import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import test from 'node:test';

const configPath = path.join(os.tmpdir(), `clipboard-resume-${process.pid}.json`);
const storageDir = path.join(os.tmpdir(), `clipboard-resume-data-${process.pid}`);
await fs.writeFile(configPath, JSON.stringify({server:{port:0,auth:false,storageDir},text:{limit:0},file:{expire:3600,chunk:4,limit:32}}));
process.argv[2] = configPath;
const { UploadedFile, uploadFileMap, cleanupTimer, PARTIAL_RETENTION_MS, runCleanup } = await import('../app/uploaded-file.js');

test('writes chunks at the supplied offset and accepts an identical retry', async () => {
  const file = new UploadedFile('small.bin');
  await file.write(Buffer.from('abcd'), 0);
  await file.write(Buffer.from('abcd'), 0);
  await file.write(Buffer.from('efgh'), 4);
  assert.equal(await fs.readFile(file.path, 'utf8'), 'abcdefgh');
  await file.remove();
});

test('rejects conflicting retry bytes and offset gaps', async () => {
  const file = new UploadedFile('small.bin');
  await file.write(Buffer.from('abcd'), 0);
  await assert.rejects(file.write(Buffer.from('xxxx'), 0), /冲突/);
  await file.remove();
  const gap = new UploadedFile('gap.bin');
  await assert.rejects(gap.write(Buffer.from('z'), 10), /超出/);
  await gap.remove();
});

test('removes partial upload after retention window elapses', async () => {
  const file = new UploadedFile('expired-partial.bin');
  await file.write(Buffer.from('abcd'), 0);
  const metadata = JSON.parse(await fs.readFile(path.join(storageDir,'.partial',`${file.uuid}.json`),'utf8'));
  metadata.updatedAt = Date.now() - PARTIAL_RETENTION_MS - 1000;
  await fs.writeFile(path.join(storageDir,'.partial',`${file.uuid}.json`),JSON.stringify(metadata));
  await runCleanup();
  assert.equal(uploadFileMap.has(file.uuid),false);
  assert.equal(await fs.stat(file.path).then(()=>true,()=>false),true);
});


test.after(async () => { clearInterval(cleanupTimer); await fs.rm(storageDir,{recursive:true,force:true}); await fs.rm(configPath,{force:true}); });
