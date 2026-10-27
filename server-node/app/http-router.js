import fs from 'node:fs';
import path from 'node:path';
import { serveFileRange } from './http-range.js';
import KoaRouter from '@koa/router';
import { koaBody } from 'koa-body';
import koaWebsocket from 'koa-websocket';

import config from './config.js';
import messageQueue from './message.js';
import {
    UploadedFile,
    uploadFileMap,
    storageFolder,
} from './uploaded-file.js';
import {
    writeJSON,
    wsBoardcast,
    createThumbnail,
} from './util.js';

const historyPath = config.server.historyFile || path.join(process.cwd(), 'history.json');

const saveHistory = () => fs.promises.writeFile(historyPath, JSON.stringify({
    file: Array.from(uploadFileMap.values()).filter(e => e.expireTime > Date.now() / 1e3).map(e => ({
        name: e.name,
        uuid: e.uuid,
        size: e.size,
        uploadTime: e.uploadTime,
        expireTime: e.expireTime,
    })),
    receive: messageQueue.queue.filter(e => e.event === 'receive').filter(e => e.data.type !== 'file' || e.data.expire > Date.now() / 1e3).map(e => e.data),
}));

/** @type {import('koa').Middleware} */
const authMiddleware = async (ctx, next) => {
    if (config.server.auth) {
        if (ctx.header.authorization !== `Bearer ${config.server.auth}`) {
            ctx.status = 403;
            const remoteAddress = ctx.request.header['x-real-ip']
                ?? ctx.request.header['x-forwarded-for']?.split(',').pop()?.trim()
                ?? ctx.req.socket.remoteAddress;
            console.log(new Date().toISOString(), '-', remoteAddress, "auth failed: ", ctx.header.authorization);
            return;
        }
    }
    await next();
};

const readTextBody = async (ctx, next) => {
    let body = '';
    for await (const chunk of ctx.req) {
        body += chunk.toString('utf8');
        if (config.text.limit > 0 && Buffer.byteLength(body, 'utf8') > config.text.limit) {
            ctx.status = 413;
            ctx.body = { code: 413, msg: '文本长度超过服务端限制', result: {} };
            return;
        }
    }
    ctx.request.body = body;
    await next();
};

const router = new KoaRouter({
    prefix: config.server.prefix,
});

router.get('/server', async ctx => {
    ctx.body = {
        'server': `ws://${ctx.request.host}${config.server.prefix}/push`,
        'auth': !!config.server.auth,
    };
});

router.post(
    '/text',
    authMiddleware,
    readTextBody,
    async ctx => {
        /** @type {String} */
        let body = ctx.request.body;
        if (config.text.limit > 0 && body.length > config.text.limit) {
            writeJSON(ctx, 400, {}, `文本长度不能超过 ${config.text.limit} 字`);
            return;
        }
        body = body
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll('\'', '&#039;');
        const message = {
            event: 'receive',
            data: {
                id: messageQueue.counter,
                type: 'text',
                room: ctx.query.room || '',
                content: body,
            },
        };
        messageQueue.enqueue(message);
        /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
        const app = ctx.app;
        wsBoardcast(app.ws, JSON.stringify(message), ctx.query.room || '');
        writeJSON(ctx, 200, {
            url: `${ctx.request.protocol}://${ctx.request.host}${config.server.prefix}/content/${message.data.id}${ctx.query.room ? `?room=${encodeURIComponent(ctx.query.room)}` : ''}`,
        });
        saveHistory();
    }
);

router.delete('/revoke/:id(\\d+)', authMiddleware, async ctx => {
    const id = parseInt(ctx.params.id);
    if (!messageQueue.queue.some(e => e.data.id === id)) {
        return writeJSON(ctx, 400, {}, '不存在的消息 ID');
    }
    messageQueue.queue.splice(messageQueue.queue.findIndex(e => e.data.id === id), 1);
    /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
    const app = ctx.app;
    wsBoardcast(
        app.ws,
        JSON.stringify({
            event: 'revoke',
            data: {
                id,
                room: ctx.query.room || '',
            },
        }),
        ctx.query.room || '',
    );
    writeJSON(ctx);
    saveHistory();
});

router.delete('/revoke/all', authMiddleware, async ctx => {
    const revoked = messageQueue.queue.filter(e => e.data.room === (ctx.query.room || ''));
    messageQueue.queue = messageQueue.queue.filter(e => e.data.room !== (ctx.query.room || ''));
    /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
    const app = ctx.app;
    revoked.forEach(e => wsBoardcast(
        app.ws,
        JSON.stringify({
            event: 'revoke',
            data: {
                id: e.data.id,
                room: ctx.query.room || '',
            },
        }),
        ctx.query.room || '',
    ));
    writeJSON(ctx);
    saveHistory();
});

router.post(
    '/upload',
    authMiddleware,
    koaBody({
        multipart: true,
        urlencoded: false,
        text: false,
        json: false,
        formLimit: config.file.limit,
        formidable: {
            maxFields: 1,
            multiples: false,
            maxFileSize: config.file.limit,
        },
    }),
    async ctx => {
        try {
            const formfile = ctx.request.files.file;
            if (!formfile) throw new Error('没有上传的文件');
            const file = new UploadedFile(formfile.originalFilename);
            uploadFileMap.set(file.uuid, file);
            file.size = formfile.size;
            await fs.promises.copyFile(formfile.filepath, file.path);
            await fs.promises.unlink(formfile.filepath);
            await file.finish();

            const message = {
                event: 'receive',
                data: {
                    id: -1, // 在生成缩略图之后进队列之前再设定
                    type: 'file',
                    room: ctx.query.room || '',
                    name: file.name,
                    size: file.size,
                    cache: file.uuid,
                    expire: file.expireTime,
                },
            };
            if (file.size <= 33554432) {
                try {
                    message.data.thumbnail = await createThumbnail(file.path);
                } catch {}
            }
            message.data.id = messageQueue.counter;
            messageQueue.enqueue(message);

            /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
            const app = ctx.app;
            wsBoardcast(app.ws, JSON.stringify(message), ctx.query.room || '');
            writeJSON(ctx, 200, {
                url: `${ctx.request.protocol}://${ctx.request.host}${config.server.prefix}/content/${message.data.id}${ctx.query.room ? `?room=${encodeURIComponent(ctx.query.room)}` : ''}`,
            });
            saveHistory();
        } catch (error) {
            writeJSON(ctx, 400, error.message || error);
        }
    }
);

router.post(
    '/upload/chunk',
    authMiddleware,
    koaBody({
        multipart: false,
        urlencoded: false,
        text: true,
        json: false,
        textLimit: 1024,
    }),
    async ctx => {
        /** @type {String} */
        const filename = ctx.request.body;
        const file = new UploadedFile(filename);
        uploadFileMap.set(file.uuid, file);
        writeJSON(ctx, 200, {
            uuid: file.uuid,
            offset: file.size,
        });
    }
);

router.get('/upload/chunk/:uuid([0-9a-f]{32})', authMiddleware, async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || !file.partial) return writeJSON(ctx, 404, {}, '无效的 UUID');
    writeJSON(ctx, 200, { uuid: file.uuid, name: file.name, offset: file.size });
});

router.post('/upload/chunk/:uuid([0-9a-f]{32})', authMiddleware, async ctx => {
    try {
        const file = uploadFileMap.get(ctx.params.uuid);
        if (!file) {
            throw new Error('无效的 UUID');
        }
        const data = await new Promise((resolve, reject) => {
            let data = Buffer.alloc(0);
            ctx.req.on('data', chunk => data = Buffer.concat([data, chunk]));
            ctx.req.on('error', error => reject(error));
            ctx.req.on('end', () => resolve(data));
        });
        const rawOffset = ctx.get('Upload-Offset') || ctx.query.offset;
        const offset = rawOffset === '' || rawOffset === undefined ? file.size : Number(rawOffset);
        await file.write(data, offset);
        writeJSON(ctx);
    } catch (error) {
        writeJSON(ctx, 400, error.message || error);
    }
});

router.post('/upload/finish/:uuid([0-9a-f]{32})', authMiddleware, async ctx => {
    try {
        const file = uploadFileMap.get(ctx.params.uuid);
        if (!file || !file.partial) {
            throw new Error('无效的 UUID');
        }
        await file.finish();

        const message = {
            event: 'receive',
            data: {
                id: -1, // 在生成缩略图之后进队列之前再设定
                type: 'file',
                room: ctx.query.room || '',
                name: file.name,
                size: file.size,
                cache: file.uuid,
                expire: file.expireTime,
            },
        };
        if (file.size <= 33554432) {
            try {
                message.data.thumbnail = await createThumbnail(file.path);
            } catch {}
        }
        message.data.id = messageQueue.counter;
        messageQueue.enqueue(message);

        /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
        const app = ctx.app;
        wsBoardcast(app.ws, JSON.stringify(message), ctx.query.room || '');
        writeJSON(ctx, 200, {
            url: `${ctx.request.protocol}://${ctx.request.host}${config.server.prefix}/content/${message.data.id}${ctx.query.room ? `?room=${encodeURIComponent(ctx.query.room)}` : ''}`,
        });
        saveHistory();
    } catch (error) {
        writeJSON(ctx, 400, error.message || error);
    }
});

router.get('/preview/archive/:uuid([0-9a-f]{32})/:filename', authMiddleware, async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || file.partial || Date.now() / 1000 > file.expireTime) return ctx.status = 404;
    const response = await fetch(`http://cloud-clipboard-preview:8000/archive/${file.uuid}/${encodeURIComponent(ctx.params.filename)}`);
    ctx.status = response.status;
    ctx.body = await response.json();
});

router.get('/preview/document/:uuid([0-9a-f]{32})/:filename', authMiddleware, async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || file.partial || Date.now() / 1000 > file.expireTime) return ctx.status = 404;
    const response = await fetch(`http://cloud-clipboard-preview:8000/document/${file.uuid}/${encodeURIComponent(ctx.params.filename)}`);
    ctx.status = response.status;
    if (!response.ok) return ctx.body = await response.text();
    ctx.type = 'application/pdf';
    ctx.body = Buffer.from(await response.arrayBuffer());
});

router.get('/preview/image/:uuid([0-9a-f]{32})/:filename', authMiddleware, async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || file.partial || Date.now() / 1000 > file.expireTime) return ctx.status = 404;
    const ext = path.extname(file.name).toLowerCase();
    const mime = ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp','.avif':'image/avif'})[ext];
    if (!mime) return ctx.status = 415;
    ctx.type = mime;
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('Cache-Control', 'private, max-age=3600');
    ctx.body = fs.createReadStream(file.path);
});

router.get(['/file/:uuid([0-9a-f]{32})', '/file/:uuid([0-9a-f]{32})/:filename'], async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || Date.now() / 1000 > file.expireTime || !fs.existsSync(file.path)) {
        return ctx.status = 404;
    }
    const fileSize = (await fs.promises.stat(file.path)).size;
    const ext = path.extname(file.name).toLowerCase();
    const media = /\.(mp4|webm|ogv|mov|m4v|mp3|wav|ogg|opus|m4a|flac|mpg|mpeg|avi|mkv)$/i.test(file.name);
    if (media) ctx.type = ext;
    ctx.set('Cache-Control', 'private, max-age=3600');
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.attachment(file.name, {type: 'inline'});
    ctx.respond = false;
    await serveFileRange(ctx.req, ctx.res, file.path);
});

router.delete('/file/:uuid([0-9a-f]{32})', authMiddleware, async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file) {
        return writeJSON(ctx, 404);
    }
    file.remove();
    uploadFileMap.delete(ctx.params.uuid);
    writeJSON(ctx);
    saveHistory();
});

router.get('/content/:id([0-9]+)', authMiddleware, async ctx => {
    const message = messageQueue.queue.find(e => (
        e.event === 'receive' &&
        e.data.room === (ctx.query.room || '') &&
        e.data.id === parseInt(ctx.params.id)
    ));
    if (!message) return ctx.status = 404;
    switch (message.data.type) {
        case 'text':
            ctx.header['Content-Type'] = 'text/plain';
            ctx.body = message.data.content
                .replaceAll('&amp;', '&')
                .replaceAll('&lt;', '<')
                .replaceAll('&gt;', '>')
                .replaceAll('&quot;', '"')
                .replaceAll('&#039;', '\'');
            break;
        case 'file':
            ctx.redirect(`${ctx.request.protocol}://${ctx.request.host}${config.server.prefix}/file/${message.data.cache}/${encodeURIComponent(message.data.name)}`);
            break;
    }
});

if (fs.existsSync(historyPath)) {
    /**
     * @type {{
     *  file: {
     *      name: String,
     *      uuid: String,
     *      size: Number,
     *      uploadTime: Number,
     *      expireTime: Number,
     *  }[],
     *  receive: ({
     *      type: 'text',
     *      room: String,
     *      content: String,
     *  }|{
     *      type: 'file',
     *      room: String,
     *      name: String,
     *      size: Number,
     *      cache: String,
     *      expire: Number,
     *  })[],
     * }}
     */
    const history = JSON.parse(fs.readFileSync(historyPath, {encoding: 'utf-8'}));
    const currentTime = Math.round(Date.now() / 1000);
    history.file.forEach(e => {
        if (!fs.existsSync(path.join(storageFolder, e.uuid))) return;
        if (e.expireTime < currentTime) return fs.rmSync(path.join(storageFolder, e.uuid));
        const f = new UploadedFile(e.name);
        f.uuid = e.uuid;
        f.path = path.join(storageFolder, f.uuid);
        f.size = e.size;
        f.uploadTime = e.uploadTime;
        f.expireTime = e.expireTime;
        uploadFileMap.set(e.uuid, f);
    });
    history.receive.forEach(e => {
        if (e.type === 'file' && !uploadFileMap.has(e.cache)) return;
        messageQueue.enqueue({
            event: 'receive',
            data: {
                ...e,
                id: messageQueue.counter,
            },
        });
    });
}

export default router;
