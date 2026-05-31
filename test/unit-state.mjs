import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState } from '../src/state.js';
import { STATE_FILE } from '../src/ignore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filesync-state-'));
}

const DAY = 24 * 3600 * 1000;
const NOW = 1_700_000_000_000; // valor fixo de relógio para os testes

// 1) Round-trip de files + tombstones
{
  const dir = tmpDir();
  const state = {
    files: {
      'a/b.txt': { hash: 'h1', size: 10, mtimeMs: 123 },
      'c.txt': { hash: 'h2', size: 20, mtimeMs: 456 },
    },
    tombstones: {
      'old.txt': NOW - 1000, // recente o suficiente
      'gone.txt': NOW - 5000,
    },
  };
  saveState(dir, state, NOW);
  const back = loadState(dir);
  assert.deepEqual(back.files, state.files, 'files round-trip');
  assert.deepEqual(back.tombstones, state.tombstones, 'tombstones round-trip');

  // formato gravado deve ser version 2
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  assert.equal(onDisk.version, 2, 'version 2 gravado');
  console.log('ok 1 - round-trip files + tombstones');
}

// 2) Poda de tombstone antigo, retenção de recente
{
  const dir = tmpDir();
  const state = {
    files: {},
    tombstones: {
      'antigo.txt': NOW - (31 * DAY), // > 30 dias -> deve sumir
      'limite.txt': NOW - (30 * DAY) + 1000, // < 30 dias -> permanece
      'recente.txt': NOW - 1000, // permanece
    },
  };
  saveState(dir, state, NOW);
  const back = loadState(dir);
  assert.equal('antigo.txt' in back.tombstones, false, 'tombstone antigo podado');
  assert.equal(back.tombstones['limite.txt'], NOW - (30 * DAY) + 1000, 'tombstone no limite retido');
  assert.equal(back.tombstones['recente.txt'], NOW - 1000, 'tombstone recente retido');
  console.log('ok 2 - poda de tombstone antigo, retencao de recente');
}

// 3) Tolerancia a formato antigo (so {files})
{
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, STATE_FILE),
    JSON.stringify({ files: { 'x.txt': { hash: 'h', size: 1, mtimeMs: 1 } } }),
  );
  const back = loadState(dir);
  assert.deepEqual(back.files, { 'x.txt': { hash: 'h', size: 1, mtimeMs: 1 } }, 'files lidos do formato antigo');
  assert.deepEqual(back.tombstones, {}, 'tombstones vazio no formato antigo');
  console.log('ok 3 - tolerancia a formato antigo');
}

// 4) Formato antigo com {version,files}
{
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, STATE_FILE),
    JSON.stringify({ version: 1, files: { 'y.txt': { hash: 'h', size: 2, mtimeMs: 2 } } }),
  );
  const back = loadState(dir);
  assert.deepEqual(back.tombstones, {}, 'tombstones vazio no formato {version,files}');
  console.log('ok 4 - tolerancia a {version,files}');
}

// 5) Arquivo ausente / corrompido
{
  const dir = tmpDir();
  const missing = loadState(dir);
  assert.deepEqual(missing, { files: {}, tombstones: {} }, 'arquivo ausente -> estado vazio');

  fs.writeFileSync(path.join(dir, STATE_FILE), '{ isso nao e json');
  const corrupt = loadState(dir);
  assert.deepEqual(corrupt, { files: {}, tombstones: {} }, 'arquivo corrompido -> estado vazio');
  console.log('ok 5 - ausente/corrompido');
}

console.log('\nALL PASS');
