import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ARCHIVE_EXT = /\.(zip|rar|7z)$/i;

export const isArchiveName = (name = '') => ARCHIVE_EXT.test(name);

const formatEntry = (name, size, isDir = false) => ({
    name: String(name || '').replace(/\\/g, '/'),
    size: Number.isFinite(size) ? size : null,
    isDir: !!isDir || String(name || '').endsWith('/'),
});

/**
 * Minimal ZIP central-directory listing (no external deps).
 * Supports standard ZIP / ZIP64 not required for most phone shares.
 */
export const listZip = (filePath) => {
    const fd = fs.openSync(filePath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        const tailSize = Math.min(stat.size, 65557); // comment max 65535 + EOCD 22
        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);

        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error('不是有效的 ZIP 文件');

        const totalEntries = tail.readUInt16LE(eocd + 10);
        const centralSize = tail.readUInt32LE(eocd + 12);
        const centralOffset = tail.readUInt32LE(eocd + 16);
        if (centralOffset + centralSize > stat.size) throw new Error('ZIP 目录损坏');

        const central = Buffer.alloc(centralSize);
        fs.readSync(fd, central, 0, centralSize, centralOffset);

        const entries = [];
        let offset = 0;
        for (let i = 0; i < totalEntries && offset + 46 <= central.length; i++) {
            if (central.readUInt32LE(offset) !== 0x02014b50) break;
            const compressedSize = central.readUInt32LE(offset + 20);
            const uncompressedSize = central.readUInt32LE(offset + 24);
            const nameLen = central.readUInt16LE(offset + 28);
            const extraLen = central.readUInt16LE(offset + 30);
            const commentLen = central.readUInt16LE(offset + 32);
            const externalAttrs = central.readUInt32LE(offset + 38);
            const nameStart = offset + 46;
            const name = central.slice(nameStart, nameStart + nameLen).toString('utf8');
            const isDir = name.endsWith('/') || ((externalAttrs >>> 28) & 0xf) === 0x4;
            entries.push(formatEntry(name, isDir ? 0 : uncompressedSize || compressedSize, isDir));
            offset = nameStart + nameLen + extraLen + commentLen;
        }
        return {
            format: 'zip',
            count: entries.length,
            entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
        };
    } finally {
        fs.closeSync(fd);
    }
};

const run7zList = (filePath) => new Promise((resolve, reject) => {
    const bin = ['7z', '7za', '7zr'].find((b) => {
        try {
            // cheap existence check via spawn which later fails clearly
            return true;
        } catch {
            return false;
        }
    }) || '7z';

    const child = spawn(bin, ['l', '-slt', '-ba', '--', filePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
        if (code !== 0) {
            reject(new Error(err.trim() || `7z exit ${code}`));
            return;
        }
        const blocks = out.split(/\n(?=Path = )/g);
        const entries = [];
        for (const block of blocks) {
            const pathMatch = block.match(/^Path = (.*)$/m);
            if (!pathMatch) continue;
            const name = pathMatch[1].trim();
            if (!name || name === path.basename(filePath)) continue;
            const sizeMatch = block.match(/^Size = (\d+)/m);
            const attrMatch = block.match(/^Attributes = (.*)$/m);
            const attrs = (attrMatch?.[1] || '').toUpperCase();
            const isDir = attrs.includes('D') || name.endsWith('/');
            const size = sizeMatch ? parseInt(sizeMatch[1], 10) : null;
            entries.push(formatEntry(name, isDir ? 0 : size, isDir));
        }
        resolve({
            format: '7z',
            count: entries.length,
            entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
        });
    });
});

export const listArchive = async (filePath, originalName = '') => {
    const name = originalName || path.basename(filePath);
    const lower = name.toLowerCase();

    if (lower.endsWith('.zip')) {
        try {
            return listZip(filePath);
        } catch (zipErr) {
            // fall through to 7z if available
            try {
                const r = await run7zList(filePath);
                r.format = 'zip';
                return r;
            } catch {
                throw zipErr;
            }
        }
    }

    if (lower.endsWith('.7z') || lower.endsWith('.rar')) {
        try {
            const r = await run7zList(filePath);
            r.format = lower.endsWith('.rar') ? 'rar' : '7z';
            return r;
        } catch (e) {
            if (e && (e.code === 'ENOENT' || String(e.message || '').includes('ENOENT'))) {
                throw new Error('服务器未安装 7z，无法预览 rar/7z。请安装 p7zip-full 后重试');
            }
            throw new Error(e.message || String(e));
        }
    }

    throw new Error('不支持的压缩格式');
};

export default {
    isArchiveName,
    listArchive,
    listZip,
};
