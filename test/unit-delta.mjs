import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signature, diff, apply } from '../src/delta.js';

// Verifica o invariante de round-trip para um par (old, novo) e blockSize.
function roundTrip(old, novo, blockSize, label) {
  const sig = signature(old, blockSize);
  const ops = diff(sig, novo, blockSize);
  const back = apply(old, ops, blockSize);
  assert.ok(Buffer.isBuffer(back), `${label}: apply devolve Buffer`);
  assert.ok(back.equals(novo), `${label}: round-trip preserva o conteúdo`);
}

const BS = 1024;

// 0) Idêntico: deve reconstruir só com copies.
{
  const old = crypto.randomBytes(10 * BS + 17);
  roundTrip(old, Buffer.from(old), BS, 'idêntico');
  console.log('ok 0 - idêntico');
}

// 1) 1 byte alterado no meio.
{
  const old = crypto.randomBytes(8 * BS);
  const novo = Buffer.from(old);
  const mid = Math.floor(novo.length / 2);
  novo[mid] ^= 0xff;
  roundTrip(old, novo, BS, '1 byte no meio');
  console.log('ok 1 - 1 byte alterado no meio');
}

// 2) Inserção no início (desloca todos os blocos).
{
  const old = crypto.randomBytes(6 * BS + 3);
  const novo = Buffer.concat([crypto.randomBytes(37), old]);
  roundTrip(old, novo, BS, 'inserção no início');
  console.log('ok 2 - inserção no início');
}

// 3) Remoção de um bloco inteiro do meio.
{
  const old = crypto.randomBytes(7 * BS);
  const novo = Buffer.concat([old.subarray(0, 3 * BS), old.subarray(4 * BS)]);
  roundTrip(old, novo, BS, 'remoção de bloco');
  console.log('ok 3 - remoção de um bloco');
}

// 4) Arquivo vazio (nos dois sentidos).
{
  const old = crypto.randomBytes(5 * BS);
  roundTrip(old, Buffer.alloc(0), BS, 'novo vazio');
  roundTrip(Buffer.alloc(0), old, BS, 'old vazio');
  roundTrip(Buffer.alloc(0), Buffer.alloc(0), BS, 'ambos vazios');
  console.log('ok 4 - arquivo vazio');
}

// 5) Novo totalmente diferente (nenhum bloco em comum, provavelmente).
{
  const old = crypto.randomBytes(9 * BS + 5);
  const novo = crypto.randomBytes(11 * BS + 99);
  roundTrip(old, novo, BS, 'totalmente diferente');
  console.log('ok 5 - novo totalmente diferente');
}

// 6) Fuzz: vários pares aleatórios com blockSize default e variados.
{
  for (let t = 0; t < 50; t++) {
    const sizeOld = Math.floor(Math.random() * 20000);
    const old = crypto.randomBytes(sizeOld);
    // novo derivado do old com mutações aleatórias, ou totalmente novo.
    let novo;
    const r = Math.random();
    if (r < 0.5 && sizeOld > 0) {
      const arr = Buffer.from(old);
      for (let k = 0; k < 5; k++) {
        if (arr.length) arr[Math.floor(Math.random() * arr.length)] ^= 0xab;
      }
      const cut = Math.floor(Math.random() * (arr.length + 1));
      novo = Buffer.concat([arr.subarray(0, cut), crypto.randomBytes(Math.floor(Math.random() * 500)), arr.subarray(cut)]);
    } else {
      novo = crypto.randomBytes(Math.floor(Math.random() * 20000));
    }
    const bs = [256, 512, 4096][t % 3];
    roundTrip(old, novo, bs, `fuzz#${t}`);
  }
  console.log('ok 6 - fuzz 50 pares');
}

console.log('\nALL PASS');
