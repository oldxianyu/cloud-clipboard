import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { serveFileRange } from '../app/http-range.js';

async function fixture(t) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'http-range-'));
    const file = path.join(dir, 'sample.bin');
    await fs.promises.writeFile(file, '0123456789');
    const server = http.createServer(async (req, res) => {
        try {
            await serveFileRange(req, res, file);
        } catch (error) {
            res.destroy(error);
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.close();
        await fs.promises.rm(dir, { recursive: true, force: true });
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function request(url, method = 'GET', range) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers: range ? { Range: range } : {} }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('serves full GET and HEAD with range capability and exact length', async t => {
    const url = await fixture(t);
    const get = await request(url);
    assert.equal(get.status, 200);
    assert.equal(get.headers['accept-ranges'], 'bytes');
    assert.equal(get.headers['content-length'], '10');
    assert.equal(get.body, '0123456789');
    const head = await request(url, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.body, '');
});

test('supports closed, open-ended, and suffix byte ranges', async t => {
    const url = await fixture(t);
    for (const [range, body, contentRange] of [
        ['bytes=2-5', '2345', 'bytes 2-5/10'],
        ['bytes=7-', '789', 'bytes 7-9/10'],
        ['bytes=-3', '789', 'bytes 7-9/10'],
    ]) {
        const response = await request(url, 'GET', range);
        assert.equal(response.status, 206);
        assert.equal(response.headers['accept-ranges'], 'bytes');
        assert.equal(response.headers['content-range'], contentRange);
        assert.equal(response.headers['content-length'], String(body.length));
        assert.equal(response.body, body);
    }
});

test('HEAD range returns matching 206 headers without a body', async t => {
    const url = await fixture(t);
    const response = await request(url, 'HEAD', 'bytes=1-3');
    assert.equal(response.status, 206);
    assert.equal(response.headers['content-range'], 'bytes 1-3/10');
    assert.equal(response.headers['content-length'], '3');
    assert.equal(response.body, '');
});

test('unsatisfiable and malformed byte ranges return 416', async t => {
    const url = await fixture(t);
    for (const range of ['bytes=10-', 'bytes=-0', 'bytes=5-2', 'bytes=0-10', 'bytes=abc']) {
        const response = await request(url, 'GET', range);
        assert.equal(response.status, 416, range);
        assert.equal(response.headers['content-range'], 'bytes */10');
        assert.equal(response.headers['accept-ranges'], 'bytes');
        assert.equal(response.body, '');
    }
});

test('ignores unsupported range units and rejects unsupported methods', async t => {
    const url = await fixture(t);
    const ignored = await request(url, 'GET', 'items=1-2');
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body, '0123456789');
    const method = await request(url, 'POST');
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'GET, HEAD');
});

test('supports zero-length files and rejects ranges against them', async t => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'http-range-empty-'));
    const file = path.join(dir, 'empty');
    await fs.promises.writeFile(file, '');
    const req = { method: 'GET', headers: {} };
    const headers = {};
    const res = { statusCode: 200, setHeader(name, value) { headers[name.toLowerCase()] = String(value); }, end() { this.ended = true; } };
    try {
        await serveFileRange(req, res, file);
        assert.equal(res.statusCode, 200);
        assert.equal(headers['content-length'], '0');
        req.headers.range = 'bytes=0-';
        await serveFileRange(req, res, file);
        assert.equal(res.statusCode, 416);
        assert.equal(headers['content-range'], 'bytes */0');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});
