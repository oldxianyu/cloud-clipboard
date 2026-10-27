import assert from 'node:assert/strict';
const app = await (await import('node:fs/promises')).readFile(new URL('./src/App.jsx', import.meta.url), 'utf8');
const api = await (await import('node:fs/promises')).readFile(new URL('../server-node/app/http-router.js', import.meta.url), 'utf8');
for (const t of ['preview/image','preview/archive','preview/document','video']) assert.ok(app.includes(t), `preview route or mode ${t}`);
assert.match(api, /serveFileRange\(ctx\.req, ctx\.res, file\.path\)/, 'video preview route streams byte ranges');
console.log('preview UI tests passed');
