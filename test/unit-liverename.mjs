// Testes determinísticos do LiveRenameDetector (detecção de rename ao vivo).
//   node test/unit-liverename.mjs
//
// A janela de 800ms é exercitada SEM sleeps reais: injetamos um agendador de
// timer que coleta os callbacks; fireAll() simula "a janela venceu". Assim
// testamos a finalização da deleção, o casamento de rename por hash+size, a
// não-correspondência quando size difere, e a reaparição no mesmo caminho.
import assert from 'node:assert/strict';
import { LiveRenameDetector } from '../src/live-rename.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

// Agendador injetável fiel à semântica de clearTimeout: cada timer é um timer
// REAL com delay enorme (nunca dispara sozinho no teste síncrono) e unref'd
// (não segura o event loop). Guardamos {handle, fn}; fireAll() dispara os que
// AINDA estão ativos — assim clearTimeout/clear() (que marcam _destroyed) são
// honrados sem usar sleeps reais.
function makeFakeClock() {
  const pending = [];
  const setTimer = (fn) => {
    const handle = setTimeout(() => {}, 1e9);
    if (handle.unref) handle.unref();
    pending.push({ handle, fn });
    return handle;
  };
  return {
    setTimer,
    fireAll() {
      const live = pending.splice(0).filter((p) => !p.handle._destroyed);
      for (const p of live) p.fn();
    },
    count() { return pending.length; },
  };
}

// 1) Rename por hash+size: add com mesmo hash E size casa o unlink -> oldRel.
{
  const clock = makeFakeClock();
  const d = new LiveRenameDetector({ setTimer: clock.setTimer });
  let finalized = null;
  d.registerUnlink('old.txt', 'h1', 100, (r) => { finalized = r; });
  const oldRel = d.tryMatch('new.txt', 'h1', 100);
  assert.equal(oldRel, 'old.txt', 'casou o rename old.txt -> new.txt');
  // Casou: a janela não deve finalizar a deleção, mesmo que o tempo passe.
  clock.fireAll();
  assert.equal(finalized, null, 'rename casado nao finaliza deleção');
  ok('rename por hash+size casa e cancela a deleção');
}

// 2) NÃO casa quando o SIZE difere (mesmo hash) — evita rename espúrio.
{
  const clock = makeFakeClock();
  const d = new LiveRenameDetector({ setTimer: clock.setTimer });
  d.registerUnlink('old.txt', 'h1', 100, () => {});
  const oldRel = d.tryMatch('new.txt', 'h1', 999); // hash igual, size diferente
  assert.equal(oldRel, null, 'size diferente NAO casa rename');
  ok('size diferente nao casa rename (mesmo com hash igual)');
}

// 2b) NÃO casa quando o HASH difere (mesmo size).
{
  const clock = makeFakeClock();
  const d = new LiveRenameDetector({ setTimer: clock.setTimer });
  d.registerUnlink('old.txt', 'h1', 100, () => {});
  assert.equal(d.tryMatch('new.txt', 'hX', 100), null, 'hash diferente NAO casa rename');
  ok('hash diferente nao casa rename (mesmo com size igual)');
}

// 3) Expiração da janela: sem add casando, a deleção é finalizada.
{
  const clock = makeFakeClock();
  const d = new LiveRenameDetector({ setTimer: clock.setTimer });
  const finalized = [];
  d.registerUnlink('some.txt', 'h2', 50, (r) => finalized.push(r));
  assert.equal(finalized.length, 0, 'antes da janela nada finaliza');
  clock.fireAll(); // janela de 800ms venceu
  assert.deepEqual(finalized, ['some.txt'], 'janela venceu sem match -> finaliza deleção');
  // Entrada removida: um match tardio não acha mais nada.
  assert.equal(d.tryMatch('x.txt', 'h2', 50), null, 'apos finalizar nao ha mais o que casar');
  ok('janela expira sem match e finaliza a deleção');
}

// 4) Reaparição no MESMO caminho cancela a deleção pendente (era modify).
{
  const clock = makeFakeClock();
  const d = new LiveRenameDetector({ setTimer: clock.setTimer });
  const finalized = [];
  d.registerUnlink('mesmo.txt', 'h3', 70, (r) => finalized.push(r));
  assert.equal(d.cancelPending('mesmo.txt'), true, 'havia deleção pendente -> cancelada');
  clock.fireAll();
  assert.equal(finalized.length, 0, 'reaparição no mesmo caminho NAO finaliza deleção');
  // cancelPending de um caminho sem nada pendente retorna false.
  assert.equal(d.cancelPending('inexistente.txt'), false, 'sem pendência -> false');
  ok('reaparição no mesmo caminho cancela a deleção adiada');
}

// 5) Casamento 1-para-1: um único unlink casa com UM add; o segundo add não acha.
{
  const clock = makeFakeClock();
  const d = new LiveRenameDetector({ setTimer: clock.setTimer });
  d.registerUnlink('a.txt', 'hh', 10, () => {});
  assert.equal(d.tryMatch('b.txt', 'hh', 10), 'a.txt', 'primeiro add casa');
  assert.equal(d.tryMatch('c.txt', 'hh', 10), null, 'segundo add nao casa (1-para-1)');
  ok('casamento de rename e 1-para-1');
}

// 6) clear() cancela tudo: nenhuma deleção finaliza depois.
{
  const clock = makeFakeClock();
  const d = new LiveRenameDetector({ setTimer: clock.setTimer });
  const finalized = [];
  d.registerUnlink('p1', 'h', 1, (r) => finalized.push(r));
  d.registerUnlink('p2', 'h', 2, (r) => finalized.push(r));
  d.clear();
  assert.equal(d.recentUnlinks.size, 0, 'estado esvaziado apos clear');
  clock.fireAll();
  assert.equal(finalized.length, 0, 'apos clear nenhuma janela finaliza');
  ok('clear() cancela todas as janelas pendentes');
}

console.log(`\n${passed} testes passaram.`);
