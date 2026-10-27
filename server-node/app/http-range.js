import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Write a single-byte-range file response to a Node HTTP response.
 * Unsupported range units are ignored; malformed or unsatisfiable byte ranges get 416.
 */
export async function serveFileRange(req, res, filePath) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end();
        return;
    }

    const { size } = await fs.promises.stat(filePath);
    res.setHeader('Accept-Ranges', 'bytes');
    const rangeHeader = req.headers?.range;
    let range = null;
    if (rangeHeader && /^\s*bytes=/i.test(rangeHeader)) {
        const match = /^\s*bytes=(\d*)-(\d*)\s*$/i.exec(rangeHeader);
        if (!match || size === 0 || (!match[1] && !match[2])) {
            return unsatisfiable(res, size);
        }
        let start;
        let end;
        if (!match[1]) {
            const suffixLength = Number(match[2]);
            if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return unsatisfiable(res, size);
            start = Math.max(size - suffixLength, 0);
            end = size - 1;
        } else {
            start = Number(match[1]);
            end = match[2] ? Number(match[2]) : size - 1;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
                return unsatisfiable(res, size);
            }
            if (end >= size) return unsatisfiable(res, size);
        }
        range = { start, end };
    }

    if (!range) {
        res.statusCode = 200;
        res.setHeader('Content-Length', size);
        if (method === 'HEAD' || size === 0) return res.end();
        await pipeline(fs.createReadStream(filePath), res);
        return;
    }

    const { start, end } = range;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(filePath, { start, end }), res);
}

function unsatisfiable(res, size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    res.setHeader('Content-Length', 0);
    res.end();
}
