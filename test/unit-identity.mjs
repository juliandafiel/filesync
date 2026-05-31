import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDENTITY_FILE, loadOrCreateIdentity } from '../src/identity.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filesync-id-'));
}

function isBase64url(s) {
  return typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
}

// 1) 1a chamada cria e persiste
{
  const dir = tmpDir();
  const file = path.join(dir, IDENTITY_FILE);
  assert.equal(fs.existsSync(file), false, 'arquivo nao existe antes');

  const id = loadOrCreateIdentity(dir);
  assert.ok(isBase64url(id.token), 'token base64url valido');
  assert.ok(isBase64url(id.key), 'key base64url valida');
  assert.equal(fs.existsSync(file), true, 'arquivo persistido');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.token, id.token, 'token gravado em disco');
  assert.equal(onDisk.key, id.key, 'key gravada em disco');
  console.log('ok 1 - cria e persiste');
}

// 2) 2a chamada devolve o MESMO token e key
{
  const dir = tmpDir();
  const a = loadOrCreateIdentity(dir);
  const b = loadOrCreateIdentity(dir);
  assert.equal(b.token, a.token, 'mesmo token entre chamadas');
  assert.equal(b.key, a.key, 'mesma key entre chamadas');
  console.log('ok 2 - estavel entre chamadas');
}

// 3) Arquivo corrompido -> regenera token/key validos e persiste
{
  const dir = tmpDir();
  const file = path.join(dir, IDENTITY_FILE);
  fs.writeFileSync(file, 'lixo');

  const id = loadOrCreateIdentity(dir);
  assert.ok(isBase64url(id.token), 'token regenerado valido');
  assert.ok(isBase64url(id.key), 'key regenerada valida');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.token, id.token, 'token regenerado persistido');
  assert.equal(onDisk.key, id.key, 'key regenerada persistida');

  // e estavel a partir daqui
  const again = loadOrCreateIdentity(dir);
  assert.equal(again.token, id.token, 'token estavel apos regeneracao');
  assert.equal(again.key, id.key, 'key estavel apos regeneracao');
  console.log('ok 3 - corrompido regenera e persiste');
}

console.log('\nALL PASS');
