import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import KoaRouter from '@koa/router';
import { koaBody } from 'koa-body';
import koaWebsocket from 'koa-websocket';

import config from './config.js';
import messageQueue from './message.js';
import {
    UploadedFile,
    uploadFileMap,
    storageFolder,
    isExpired,
    NEVER_EXPIRE,
    resolveExpireTime,
} from './uploaded-file.js';
import {
    writeJSON,
    wsBoardcast,
    createThumbnail,
} from './util.js';
import { listArchive, isArchiveName } from './archive-list.js';

const historyPath = config.server.historyFile || path.join(process.cwd(), 'history.json');

const newShareToken = () => crypto.randomBytes(12).toString('base64url');

const ensureShareToken = (data) => {
    if (!data.share) data.share = newShareToken();
    return data.share;
};

const publicProtocol = (ctx) => {
    const forwarded = String(ctx.get('x-forwarded-proto') || '').split(',')[0].trim();
    return forwarded || (ctx.secure ? 'https' : ctx.request.protocol);
};

const shareUrl = (ctx, data) => `${publicProtocol(ctx)}://${ctx.request.host}${config.server.prefix}/s/${ensureShareToken(data)}`;


const saveHistory = () => fs.promises.writeFile(historyPath, JSON.stringify({
    file: Array.from(uploadFileMap.values()).filter(e => !isExpired(e.expireTime)).map(e => ({
        name: e.name,
        uuid: e.uuid,
        size: e.size,
        uploadTime: e.uploadTime,
        expireTime: e.expireTime,
    })),
    receive: messageQueue.queue.filter(e => e.event === 'receive').filter(e => e.data.type !== 'file' || !isExpired(e.data.expire)).map(e => e.data),
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
    koaBody({
        multipart: false,
        urlencoded: false,
        text: true,
        json: false,
        textLimit: 1048576,
    }),
    async ctx => {
        /** @type {String} */
        let body = ctx.request.body;
        if (body.length > config.text.limit) {
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
                share: newShareToken(),
            },
        };
        messageQueue.enqueue(message);
        /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
        const app = ctx.app;
        wsBoardcast(app.ws, JSON.stringify(message), ctx.query.room || '');
        writeJSON(ctx, 200, {
            url: shareUrl(ctx, message.data),
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
            message.data.share = newShareToken();
            messageQueue.enqueue(message);

            /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
            const app = ctx.app;
            wsBoardcast(app.ws, JSON.stringify(message), ctx.query.room || '');
            writeJSON(ctx, 200, {
                url: shareUrl(ctx, message.data),
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
        let filename = ctx.request.body;
        let metadata = {};
        try {
            metadata = JSON.parse(filename);
            filename = metadata.name;
        } catch {}
        if (!filename || typeof filename !== 'string') {
            return writeJSON(ctx, 400, {}, '文件名无效');
        }
        const file = new UploadedFile(filename);
        file.expectedSize = Number.isSafeInteger(Number(metadata.size)) ? Number(metadata.size) : undefined;
        file.expectedSha256 = /^[a-f0-9]{64}$/i.test(metadata.sha256 || '') ? metadata.sha256.toLowerCase() : undefined;
        uploadFileMap.set(file.uuid, file);
        writeJSON(ctx, 200, {
            uuid: file.uuid,
        });
    }
);

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
        const offset = ctx.get('x-upload-offset');
        const chunkSha256 = ctx.get('x-chunk-sha256');
        await file.write(data, {
            offset: offset === '' ? undefined : Number(offset),
            sha256: chunkSha256 || undefined,
        });
        writeJSON(ctx, 200, { size: file.size });
    } catch (error) {
        writeJSON(ctx, 400, error.message || error);
    }
});

router.post('/upload/finish/:uuid([0-9a-f]{32})', authMiddleware, async ctx => {
    try {
        const file = uploadFileMap.get(ctx.params.uuid);
        if (!file) {
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
        message.data.share = newShareToken();
        messageQueue.enqueue(message);

        /** @type {koaWebsocket.App<Koa.DefaultState, Koa.DefaultContext>} */
        const app = ctx.app;
        wsBoardcast(app.ws, JSON.stringify(message), ctx.query.room || '');
        writeJSON(ctx, 200, {
            url: shareUrl(ctx, message.data),
        });
        saveHistory();
    } catch (error) {
        writeJSON(ctx, 400, error.message || error);
    }
});


const guessMime = (name = '') => {
    const lower = name.toLowerCase();
    if (lower.match(/\.(png)$/)) return 'image/png';
    if (lower.match(/\.(jpe?g)$/)) return 'image/jpeg';
    if (lower.match(/\.(gif)$/)) return 'image/gif';
    if (lower.match(/\.(webp)$/)) return 'image/webp';
    if (lower.match(/\.(bmp)$/)) return 'image/bmp';
    if (lower.match(/\.(svg)$/)) return 'image/svg+xml';
    if (lower.match(/\.(mp4)$/)) return 'video/mp4';
    if (lower.match(/\.(webm)$/)) return 'video/webm';
    if (lower.match(/\.(ogv)$/)) return 'video/ogg';
    if (lower.match(/\.(mov)$/)) return 'video/quicktime';
    if (lower.match(/\.(mp3)$/)) return 'audio/mpeg';
    if (lower.match(/\.(wav)$/)) return 'audio/wav';
    if (lower.match(/\.(ogg|opus)$/)) return 'audio/ogg';
    if (lower.match(/\.(m4a)$/)) return 'audio/mp4';
    if (lower.match(/\.(flac)$/)) return 'audio/flac';
    if (lower.match(/\.(pdf)$/)) return 'application/pdf';
    if (lower.match(/\.(txt|log|md|csv|json)$/)) return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
};

const sendStoredFile = async (ctx, { disposition = 'attachment' } = {}) => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || isExpired(file.expireTime) || !fs.existsSync(file.path)) {
        return ctx.status = 404;
    }
    const mime = disposition === 'inline' ? guessMime(file.name) : 'application/octet-stream';
    ctx.attachment(file.name, {type: disposition});
    ctx.set('Content-Type', mime);
    ctx.set('X-Content-Type-Options', 'nosniff');
    if (disposition === 'inline') {
        ctx.set('Cache-Control', 'private, max-age=300');
    }
    const fileSize = (await fs.promises.stat(file.path)).size;
    // https://github.com/xtx1130/koa-partial-content/blob/master/index.js
    if (ctx.header.range && file.name.match(/\.(mp3|mp4|flv|webm|ogv|mpg|mpg|wav|ogg|opus|m4a|flac|mov)$/gi)) {
        try {
            const m = /^bytes=(\d+)-(\d*)$/.exec(ctx.request.header.range || 'bytes=0-');
            if (!m) throw new Error;
            const rangeStart = parseInt(m[1], 10);
            const rangeEnd = parseInt(m[2] || (fileSize - 1), 10);
            const contentLength = rangeEnd - rangeStart + 1;
            ctx.set('Accept-Ranges', 'bytes');
            if (
                !Number.isSafeInteger(rangeStart) ||
                !Number.isSafeInteger(rangeEnd) ||
                rangeStart < 0 ||
                rangeStart >= fileSize ||
                rangeEnd < rangeStart ||
                rangeEnd >= fileSize
            ) {
                ctx.set('Content-Range', `bytes */${fileSize}`);
                ctx.status = 416;
                return;
            }
            ctx.status = 206;
            ctx.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${fileSize}`);
            // Required by some mobile/browser video players and avoids a
            // chunked 206 response through Cloudflare.
            ctx.set('Content-Length', String(contentLength));
            await new Promise(resolve => {
                const rs = fs.createReadStream(file.path, {
                    start: rangeStart,
                    end: rangeEnd,
                });
                rs.on('open', () => rs.pipe(ctx.res));
                rs.on('end', resolve);
                rs.on('error', () => resolve(ctx.throw(500)));
            });
        } catch (err) {
            ctx.throw(416);
            ctx.set('Content-Range', `bytes */${fileSize}`);
        }
    } else {
        ctx.body = fs.createReadStream(file.path);
    }
};

// Force download (default)
router.get(['/file/:uuid([0-9a-f]{32})', '/file/:uuid([0-9a-f]{32})/:filename'], async ctx => {
    await sendStoredFile(ctx, { disposition: 'attachment' });
});

// Inline preview for images/videos/audio/pdf/text
router.get(['/preview/:uuid([0-9a-f]{32})', '/preview/:uuid([0-9a-f]{32})/:filename'], async ctx => {
    await sendStoredFile(ctx, { disposition: 'inline' });
});



// List archive contents for preview (zip/rar/7z)
router.get('/archive/:uuid([0-9a-f]{32})', async ctx => {
    const file = uploadFileMap.get(ctx.params.uuid);
    if (!file || isExpired(file.expireTime) || !fs.existsSync(file.path)) {
        return writeJSON(ctx, 404, {}, '文件不存在或已过期');
    }
    if (!isArchiveName(file.name)) {
        return writeJSON(ctx, 400, {}, '不是可预览的压缩包');
    }
    try {
        const result = await listArchive(file.path, file.name);
        // hard cap for UI
        const maxEntries = 2000;
        const entries = result.entries.slice(0, maxEntries);
        writeJSON(ctx, 200, {
            name: file.name,
            uuid: file.uuid,
            size: file.size,
            format: result.format,
            count: result.count,
            truncated: result.count > maxEntries,
            entries,
        });
    } catch (error) {
        writeJSON(ctx, 400, {}, error.message || String(error));
    }
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

// Opaque public share links: /s/<token>
// Keep write/delete endpoints protected; share pages are public GET only.
router.get('/s/:token([A-Za-z0-9_-]{10,64})', async ctx => {
    const message = messageQueue.queue.find(e => (
        e.event === 'receive' &&
        e.data.share === ctx.params.token
    ));
    if (!message) {
        ctx.status = 404;
        ctx.type = 'html';
        ctx.body = `<!doctype html><meta charset="utf-8"><title>内容不存在</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:10vh auto;padding:0 20px;color:#222}</style>
<h2>内容不存在或已过期</h2>
<p>链接无效、消息已删除，或历史已滚动淘汰。</p>`;
        return;
    }
    switch (message.data.type) {
        case 'text': {
            const plain = message.data.content
                .replaceAll('&amp;', '&')
                .replaceAll('&lt;', '<')
                .replaceAll('&gt;', '>')
                .replaceAll('&quot;', '"')
                .replaceAll('&#039;', "'");
            const accept = String(ctx.get('accept') || '');
            if (accept.includes('text/plain') && !accept.includes('text/html')) {
                ctx.type = 'text/plain';
                ctx.body = plain;
            } else {
                const safe = plain
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;');
                ctx.type = 'html';
                ctx.body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分享内容</title>
<style>
body{margin:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:rgba(0,0,0,.88)}
.wrap{max-width:860px;margin:0 auto;padding:24px}
.card{background:#fff;border:1px solid #f0f0f0;border-radius:12px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
.meta{color:rgba(0,0,0,.45);font-size:13px;margin-bottom:12px}
pre{white-space:pre-wrap;word-break:break-word;line-height:1.7;margin:0;font:inherit}
.actions{margin-top:16px}
button{appearance:none;border:1px solid #1677ff;background:#1677ff;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer}
</style>
<div class="wrap"><div class="card">
<div class="meta">分享内容</div>
<pre id="c">${safe}</pre>
<div class="actions">
<button onclick="navigator.clipboard.writeText(document.getElementById('c').innerText)">复制</button>
</div></div></div>`;
            }
            break;
        }
        case 'file':
            ctx.redirect(`${publicProtocol(ctx)}://${ctx.request.host}${config.server.prefix}/preview/${message.data.cache}/${encodeURIComponent(message.data.name)}`);
            break;
    }
});

// Old numeric share URLs are no longer exposed.
router.get('/content/:id([0-9]+)', async ctx => {
    ctx.status = 404;
    ctx.type = 'html';
    ctx.body = `<!doctype html><meta charset="utf-8"><title>链接已更新</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:10vh auto;padding:0 20px;color:#222}</style>
<h2>该分享链接已失效</h2>
<p>请使用新的随机分享链接。</p>`;
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
        if (isExpired(e.expireTime, currentTime)) return fs.rmSync(path.join(storageFolder, e.uuid));
        const f = new UploadedFile(e.name);
        f.uuid = e.uuid;
        f.path = path.join(storageFolder, f.uuid);
        f.size = e.size;
        f.uploadTime = e.uploadTime;
        // If never-expire mode (config.file.expire <= 0), rewrite existing items to never expire.
        f.expireTime = (Number(config.file?.expire) <= 0)
            ? NEVER_EXPIRE
            : (e.expireTime || resolveExpireTime(e.uploadTime || currentTime));
        uploadFileMap.set(e.uuid, f);
    });
    // Preserve original message IDs and opaque share tokens across restarts.
    let maxId = -1;
    let tokenTouched = false;
    history.receive.forEach(e => {
        if (e.type === 'file' && !uploadFileMap.has(e.cache)) return;
        const id = Number.isInteger(e.id) ? e.id : messageQueue.counter;
        maxId = Math.max(maxId, id);
        if (!e.share) {
            e.share = newShareToken();
            tokenTouched = true;
        }
        const data = {
            ...e,
            id,
            share: e.share,
        };
        if (data.type === 'file') {
            data.expire = (Number(config.file?.expire) <= 0)
                ? NEVER_EXPIRE
                : (data.expire || NEVER_EXPIRE);
        }
        messageQueue.queue.push({
            event: 'receive',
            data,
        });
    });
    messageQueue.counter = Math.max(messageQueue.counter, maxId + 1);
    while (messageQueue.queue.length > (config.server.history || messageQueue.queue.length)) {
        messageQueue.queue.shift();
    }
    const expireTouched = Number(config.file?.expire) <= 0;
    if (tokenTouched || expireTouched) saveHistory();
}

export default router;
