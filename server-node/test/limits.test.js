import assert from 'node:assert/strict';
import test from 'node:test';
process.argv[2] = '/root/cloud-clipboard/runtime/config.json';
const { default: config } = await import('../app/config.js');

test('public clipboard allows unauthenticated access and unlimited text', () => {
    assert.equal(config.server.auth, false);
    assert.equal(config.text.limit, 0);
});

test('individual file limit is 10 GiB', () => {
    assert.equal(config.file.limit, 10 * 1024 * 1024 * 1024);
});
