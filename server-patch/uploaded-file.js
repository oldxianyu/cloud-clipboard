import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import config from './config.js';

const storageFolder = config.server.storageDir || path.join(os.tmpdir(), '.cloud-clipboard-storage');
if (!fs.existsSync(storageFolder)) {
    fs.mkdirSync(storageFolder);
}

/** Treat <=0 / non-finite expire as never-expire. */
const NEVER_EXPIRE = 4102444800; // 2100-01-01 UTC

const resolveExpireTime = (uploadTime) => {
    const expire = Number(config.file?.expire);
    if (!Number.isFinite(expire) || expire <= 0) {
        return NEVER_EXPIRE;
    }
    return uploadTime + expire;
};

const isExpired = (expireTime, now = Math.round(Date.now() / 1000)) => {
    if (!Number.isFinite(expireTime) || expireTime <= 0) return false;
    // treat far-future / never marker as not expired
    if (expireTime >= NEVER_EXPIRE) return false;
    return expireTime < now;
};

class UploadedFile {
    /**
     * @param {String} name
     */
    constructor(name) {
        this.name = name;
        this.uuid = crypto.randomBytes(16).toString('hex');
        this.path = path.join(storageFolder, this.uuid);
        this.size = 0;
        /** @type {Number} */
        this.uploadTime = undefined;
        /** @type {Number} */
        this.expireTime = undefined;
        this.writePromise = Promise.resolve();
        this.expectedSize = undefined;
        this.expectedSha256 = undefined;
        this.sha256 = crypto.createHash('sha256');
    }

    /**
     * @param {Uint8Array} data
     */
    write(data, { offset, sha256 } = {}) {
        if (offset !== undefined && Number(offset) !== this.size) {
            throw new Error(`分片偏移错误：服务器为 ${this.size}，客户端为 ${offset}`);
        }
        if (data.length > config.file.chunk) {
            throw new Error(`分片长度不能超过 ${config.file.chunk} 字节`);
        }
        if (this.size + data.length > config.file.limit) {
            throw new Error('文件大小已超过限制');
        }
        if (sha256 && crypto.createHash('sha256').update(data).digest('hex') !== String(sha256).toLowerCase()) {
            throw new Error('分片校验失败');
        }
        this.writePromise = this.writePromise
            .then(() => fs.promises.appendFile(this.path, data))
            .then(() => {
                this.sha256.update(data);
                this.size += data.length;
            });
        return this.writePromise;
    }

    finish() {
        this.writePromise = this.writePromise.then(() => {
            if (this.expectedSize !== undefined && this.size !== this.expectedSize) {
                throw new Error(`文件大小校验失败：收到 ${this.size}，应为 ${this.expectedSize}`);
            }
            if (this.expectedSha256) {
                const actual = this.sha256.copy().digest('hex');
                if (actual !== this.expectedSha256) throw new Error('文件 SHA-256 校验失败');
            }
            this.uploadTime = Math.round(Date.now() / 1000);
            this.expireTime = resolveExpireTime(this.uploadTime);
        });
        return this.writePromise;
    }

    remove() {
        this.writePromise = this.writePromise.then(() => fs.promises.rm(this.path)).catch(() => {});
        return this.writePromise;
    }
}

/** @type {Map<String, UploadedFile>} */
const uploadFileMap = new Map;

setInterval(() => {
    /** @type {String[]} */
    const toRemove = [];
    const currentTime = Math.round(Date.now() / 1000);
    uploadFileMap.forEach((v, k) => {
        if (isExpired(v.expireTime, currentTime)) toRemove.push(k);
    });
    toRemove.forEach(e => {
        try {
            uploadFileMap.get(e).remove();
            uploadFileMap.delete(e);
        } catch (err) {

        }
    });
}, 1800000);

export {
    UploadedFile,
    uploadFileMap,
    storageFolder,
    isExpired,
    NEVER_EXPIRE,
    resolveExpireTime,
};
