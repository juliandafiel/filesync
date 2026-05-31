import assert from 'node:assert/strict';
import { DeleteSuppressor } from '../src/suppress.js';

const TTL = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// 1) expect + consume retorna true e zera o estado.
{
  const s = new DeleteSuppressor(TTL);
  s.expect('a/b.txt');
  assert.equal(s.consume('a/b.txt'), true, 'consume apos expect deve ser true');
  assert.equal(s.counts.size, 0, 'contador deve zerar (chave removida)');
  s.clear();
  ok('expect+consume retorna true e zera');
}

// 2) delete + recriacao + delete: dois expects exigem dois consumes.
{
  const s = new DeleteSuppressor(TTL);
  s.expect('x.txt'); // eco do primeiro delete remoto
  s.expect('x.txt'); // eco do delete remoto apos recriacao
  assert.equal(s.consume('x.txt'), true, 'primeiro consume true');
  assert.equal(s.counts.get('x.txt'), 1, 'ainda resta 1 expectativa');
  assert.equal(s.consume('x.txt'), true, 'segundo consume true');
  assert.equal(s.counts.has('x.txt'), false, 'chave removida apos zerar');
  assert.equal(s.consume('x.txt'), false, 'terceiro consume (sem expect) false');
  s.clear();
  ok('dois expects exigem dois consumes');
}

// 3) consume sem expect retorna false.
{
  const s = new DeleteSuppressor(TTL);
  assert.equal(s.consume('nunca-esperado.txt'), false, 'consume sem expect false');
  s.clear();
  ok('consume sem expect retorna false');
}

// 4) apos o ttl, o contador expira sozinho.
{
  const s = new DeleteSuppressor(TTL);
  s.expect('expira.txt');
  assert.equal(s.counts.get('expira.txt'), 1, 'contador presente antes do ttl');
  await sleep(TTL + 30);
  assert.equal(s.counts.has('expira.txt'), false, 'contador deve expirar sozinho');
  // unlink real chegando tarde nao deve ser suprimido
  assert.equal(s.consume('expira.txt'), false, 'consume apos expiracao false');
  s.clear();
  ok('contador expira sozinho apos ttl');
}

// 5) clear() cancela timers pendentes: o processo deve encerrar sem ficar pendurado.
{
  const s = new DeleteSuppressor(100000); // ttl gigante: se nao cancelar, segura o loop
  s.expect('p1');
  s.expect('p2');
  assert.equal(s.timers.size, 2, 'dois timers pendentes');
  s.clear();
  assert.equal(s.timers.size, 0, 'timers cancelados');
  assert.equal(s.counts.size, 0, 'contadores zerados');
  ok('clear() cancela timers pendentes');
}

console.log(`\n${passed} testes passaram. Processo deve encerrar sem timers orfaos.`);
