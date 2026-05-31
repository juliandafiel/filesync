import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startKeepalive } from '../src/keepalive.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// ws falso: registra cada ping; sem terminate (keepalive nao deve depender dele).
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.pings = 0;
  }
  ping() {
    this.pings++;
  }
}

// (a) ping e chamado periodicamente.
{
  const ws = new FakeWs();
  const stop = startKeepalive(ws, { intervalMs: 20, timeoutMs: 60 });
  await sleep(70);
  assert.ok(ws.pings >= 2, `esperava varios pings, obteve ${ws.pings}`);
  stop();
  ok('ping e chamado periodicamente');
}

// (b) emitindo 'pong' mantem vivo: onDead NAO chamado.
{
  const ws = new FakeWs();
  let dead = 0;
  const stop = startKeepalive(ws, { intervalMs: 20, timeoutMs: 60, onDead: () => dead++ });
  // emite pong dentro do timeout repetidamente
  for (let i = 0; i < 8; i++) {
    await sleep(20);
    ws.emit('pong');
  }
  assert.equal(dead, 0, 'onDead nao deve ser chamado enquanto ha pong');
  stop();
  ok('pong mantem a conexao viva');
}

// (c) sem 'pong' apos timeout: onDead chamado exatamente 1x.
{
  const ws = new FakeWs();
  let dead = 0;
  startKeepalive(ws, { intervalMs: 20, timeoutMs: 60, onDead: () => dead++ });
  await sleep(200); // tempo de sobra para varios ticks apos o timeout
  assert.equal(dead, 1, `onDead deve disparar exatamente 1x, obteve ${dead}`);
  ok('onDead chamado exatamente 1x apos timeout');
}

// (d) stop() impede pings futuros (e timers unref => processo encerra).
{
  const ws = new FakeWs();
  const stop = startKeepalive(ws, { intervalMs: 20, timeoutMs: 60 });
  await sleep(50);
  stop();
  const after = ws.pings;
  await sleep(60);
  assert.equal(ws.pings, after, 'nenhum ping novo apos stop()');
  // listener de pong tambem removido
  assert.equal(ws.listenerCount('pong'), 0, 'listener de pong removido apos stop()');
  ok('stop() impede pings futuros e remove listeners');
}

console.log(`\n${passed} testes passaram. Processo deve encerrar sozinho (timers unref).`);
