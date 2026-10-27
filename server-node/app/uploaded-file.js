import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from './config.js';

const storageFolder = config.server.storageDir || path.join(os.tmpdir(), '.cloud-clipboard-storage');
const partialFolder = path.join(storageFolder, '.partial');
fs.mkdirSync(partialFolder, { recursive: true });
fs.mkdirSync(storageFolder, { recursive: true });
const PARTIAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const metadataPath = uuid => path.join(partialFolder, `${uuid}.json`);
const persist = file => fs.promises.writeFile(metadataPath(file.uuid), JSON.stringify({ uuid: file.uuid, name: file.name, size: file.size, updatedAt: Date.now() }));

class UploadedFile {
    /**
     * @param {String} name
     */
    constructor(name) {
        this.name = name;
        this.uuid = crypto.randomBytes(16).toString('hex');
        this.path = path.join(storageFolder, this.uuid);
        this.partial = true;
        this.size = 0;
        /** @type {Number} */
        this.uploadTime = undefined;
        /** @type {Number} */
        this.expireTime = undefined;
        this.writePromise = Promise.resolve();
    }

    /**
     * @param {Uint8Array} data
     */
    write(data, offset = this.size) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > config.file.limit) throw new Error('无效的上传偏移量');
        if (data.length > config.file.chunk) {
            throw new Error(`分片长度不能超过 ${config.file.chunk} 字节`);
        }
        if (offset + data.length > config.file.limit) {
            throw new Error('文件大小已超过限制');
        }
        this.writePromise = this.writePromise
            .then(async () => {
                const existingStat = await fs.promises.stat(this.path).catch(() => ({ size: 0 }));
                if (offset > existingStat.size) throw new Error('上传偏移量超出当前文件大小');
                if (offset < existingStat.size) {
                    const existing = Buffer.alloc(data.length);
                    const readHandle = await fs.promises.open(this.path, 'r');
                    try {
                        const { bytesRead } = await readHandle.read(existing, 0, data.length, offset);
                        if (bytesRead === data.length && existing.equals(Buffer.from(data))) return;
                    } finally { await readHandle.close(); }
                    throw new Error('上传偏移量与已写入数据冲突');
                }
                const handle = await fs.promises.open(this.path, 'a+');
                try {
                    await handle.write(data, 0, data.length, offset);
                    this.size = offset + data.length;
                    await persist(this);
                } finally { await handle.close(); }
            });
        return this.writePromise;
    }

    finish() {
        this.writePromise = this.writePromise.then(() => {
            this.uploadTime = Math.round(Date.now() / 1000);
            this.partial = false;
            fs.promises.rm(metadataPath(this.uuid), { force: true }).catch(() => {});
            this.expireTime = this.uploadTime + config.file.expire;
        });
        return this.writePromise;
    }

    remove() {
        this.writePromise = this.writePromise.then(async () => {
            await fs.promises.rm(this.path, { force: true });
            await fs.promises.rm(metadataPath(this.uuid), { force: true });
            this.size = 0;
        }).catch(() => {});
        return this.writePromise;
    }
}

/** @type {Map<String, UploadedFile>} */
const uploadFileMap = new Map;
for (const entry of fs.readdirSync(partialFolder)) {
    if (!/^[0-9a-f]{32}\.json$/.test(entry)) continue;
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(partialFolder, entry), 'utf8'));
        const dataPath = path.join(storageFolder, meta.uuid);
        if (!meta || !/^[0-9a-f]{32}$/.test(meta.uuid) || Date.now() - meta.updatedAt > PARTIAL_RETENTION_MS || !fs.existsSync(dataPath)) {
            fs.rmSync(path.join(partialFolder, entry), { force: true });
            fs.rmSync(dataPath, { force: true });
            continue;
        }
        const file = new UploadedFile(meta.name);
        file.uuid = meta.uuid; file.path = dataPath; file.size = fs.statSync(dataPath).size;
        if (file.size > config.file.limit) throw new Error('partial exceeds limit');
        uploadFileMap.set(file.uuid, file);
    } catch { fs.rmSync(path.join(partialFolder, entry), { force: true }); }
}

const runCleanup = async () => {
    const currentTime = Date.now();
    for (const [uuid, file] of uploadFileMap) {
        try {
            const meta = JSON.parse(await fs.promises.readFile(metadataPath(uuid), 'utf8'));
            if (currentTime - meta.updatedAt > PARTIAL_RETENTION_MS) {
                await file.remove();
                uploadFileMap.delete(uuid);
            } else if (!file.partial && file.expireTime < currentTime / 1000) {
                await file.remove();
                uploadFileMap.delete(uuid);
            }
        } catch {
            if (file.partial) {
                await file.remove();
                uploadFileMap.delete(uuid);
            } else if (file.expireTime < currentTime / 1000) {
                await file.remove();
                uploadFileMap.delete(uuid);
            }
        }
    }
};
const cleanupTimer = setInterval(runCleanup, 60 * 60 * 1000);

export {
    UploadedFile,
    uploadFileMap,
    storageFolder,
    cleanupTimer,
    PARTIAL_RETENTION_MS,
    runCleanup,
};
