// Testes determinísticos do EchoSuppressor (anti-eco centralizado). Rode:
//   node test/unit-echosuppress.mjs
//
// Toda a temporização (expiração de 10s das supressões de add/dir/delete) é
// exercitada SEM sleeps reais: injetamos um agendador de timer que apenas
// COLETA os callbacks e os disparamos manualmente quando quisermos simular a
// passagem do tempo. Assim os testes são síncronos e instantâneos.
import assert from 'node:assert/strict';
import { EchoSuppressor } from '../src/echo-suppress.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

// Agendador injetável: guarda os callbacks pendentes; fireAll() dispara todos
// (simula "o tempo passou e todos os timers venceram").
function makeFakeClock() {
  const pending = [];
  const setTimer = (fn, ms) => { pending.push({ fn, ms }); return { unref() {} }; };
  return {
    setTimer,
    fireAll() { const fns = pending.splice(0).map((p) => p.fn); for (const fn of fns) fn(); },
    count() { return pending.length; },
  };
}

// 1) Consumo de eco de escrita 1-para-1 (hash exato).
{
  const clock = makeFakeClock();
  const e = new EchoSuppressor({ setTimer: clock.setTimer });
  e.expectWrite('a.txt', 'h1');
  // Hash diferente NÃO é eco (escrita local real com outro conteúdo).
  assert.equal(e.consumeEcho('a.txt', 'hX'), false, 'hash diferente nao e eco');
  // Hash esperado É eco e limpa a entrada inteira.
  assert.equal(e.consumeEcho('a.txt', 'h1'), true, 'hash esperado e eco');
  // Segundo consumo do mesmo rel/hash já não casa (entrada foi limpa).
  assert.equal(e.consumeEcho('a.txt', 'h1'), false, 'segundo consumo nao casa (limpou)');
  ok('consumo de eco de escrita 1-para-1 por hash');
}

// 2) cancelWrite libera a supressão de um eco que não virá (recebimento rejeitado).
{
  const clock = makeFakeClock();
  const e = new EchoSuppressor({ setTimer: clock.setTimer });
  e.expectWrite('b.txt', 'h2');
  e.cancelWrite('b.txt');
  assert.equal(e.consumeEcho('b.txt', 'h2'), false, 'apos cancelWrite nao e mais eco');
  ok('cancelWrite libera supressao de eco que nao vira');
}

// 3) clearSuppressLater limpa o hash quando o timer (10s) vence sem evento.
{
  const clock = makeFakeClock();
  const e = new EchoSuppressor({ setTimer: clock.setTimer });
  e.expectWrite('c.txt', 'h3');
  e.clearSuppressLater('c.txt', 'h3');
  // Antes de vencer: ainda é eco.
  assert.equal(e.suppressAdd.has('c.txt'), true, 'antes do timer ainda suprime');
  clock.fireAll(); // simula 10s passados
  assert.equal(e.suppressAdd.has('c.txt'), false, 'apos o timer a entrada some');
  assert.equal(e.consumeEcho('c.txt', 'h3'), false, 'apos expirar nao e mais eco');
  ok('clearSuppressLater expira a supressao apos o timer');
}

// 3b) clearSuppressLater preserva outros hashes do mesmo rel e só remove o seu.
{
  const clock = makeFakeClock();
  const e = new EchoSuppressor({ setTimer: clock.setTimer });
  e.expectWrite('d.txt', 'hA');
  e.expectWrite('d.txt', 'hB');
  e.clearSuppressLater('d.txt', 'hA');
  clock.fireAll();
  // hA expirou; hB ainda deve estar lá.
  assert.equal(e.suppressAdd.get('d.txt').has('hA'), false, 'hA removido');
  assert.equal(e.consumeEcho('d.txt', 'hB'), true, 'hB ainda e eco');
  ok('clearSuppressLater remove so o hash dele, preserva os outros');
}

// 4) Deleção: delega ao DeleteSuppressor (contador 1-para-1).
{
  const clock = makeFakeClock();
  const e = new EchoSuppressor({ setTimer: clock.setTimer });
  e.expectDelete('x.txt');
  e.expectDelete('x.txt'); // delete + recriação rápida -> dois ecos esperados
  assert.equal(e.consumeDelete('x.txt'), true, 'primeiro consume de delete true');
  assert.equal(e.consumeDelete('x.txt'), true, 'segundo consume de delete true');
  assert.equal(e.consumeDelete('x.txt'), false, 'terceiro consume (sem expect) false');
  ok('deletes: contador 1-para-1 (delete+recriacao)');
}

// 5) Anti-eco de diretórios (mkdir): expectDirAdd + consumeDirAdd e expiração.
{
  const clock = makeFakeClock();
  const e = new EchoSuppressor({ setTimer: clock.setTimer });
  e.expectDirAdd('pasta');
  assert.equal(e.consumeDirAdd('pasta'), true, 'consumeDirAdd e eco apos expect');
  assert.equal(e.consumeDirAdd('pasta'), false, 'segundo consumeDirAdd nao casa');
  // Expiração: se o addDir nunca chegar, o timer (10s) limpa sozinho.
  e.expectDirAdd('outra');
  clock.fireAll();
  assert.equal(e.consumeDirAdd('outra'), false, 'apos expirar nao suprime mkdir local real');
  ok('anti-eco de mkdir (consumeDirAdd + expiracao)');
}

// 6) Anti-eco de diretórios (rmdir): expectDirDel + consumeDirDel e expiração.
{
  const clock = makeFakeClock();
  const e = new EchoSuppressor({ setTimer: clock.setTimer });
  e.expectDirDel('pasta');
  assert.equal(e.consumeDirDel('pasta'), true, 'consumeDirDel e eco apos expect');
  assert.equal(e.consumeDirDel('pasta'), false, 'segundo consumeDirDel nao casa');
  e.expectDirDel('outra');
  clock.fireAll();
  assert.equal(e.consumeDirDel('outra'), false, 'apos expirar nao suprime rmdir local real');
  ok('anti-eco de rmdir (consumeDirDel + expiracao)');
}

// 7) clear() encerra sem timers órfãos (delega ao DeleteSuppressor.clear()).
{
  const e = new EchoSuppressor(); // timer real (com unref) — só checa que clear() não lança
  e.expectDelete('p1');
  e.clear();
  assert.equal(e.suppressDelete.counts.size, 0, 'contadores de delete zerados apos clear');
  ok('clear() zera deletes e nao deixa timers orfaos');
}

console.log(`\n${passed} testes passaram.`);
