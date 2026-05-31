// Testes unitários de reconcilePlan (ESM). Rode: node test/unit-reconcile.mjs
import assert from 'node:assert/strict';
import { reconcilePlan } from '../src/manifest.js';

let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log(`ok - ${name}`);
}

const file = (mtimeMs, hash = 'h', size = 1) => ({ hash, size, mtimeMs });

// --- Caso 1: local vivo & peer vivo ---

test('1. sameHash -> nada', () => {
  const r = reconcilePlan({ a: file(100, 'x') }, {}, { a: file(200, 'x') }, {});
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

test('1. la > pa -> send', () => {
  const r = reconcilePlan({ a: file(200, 'x') }, {}, { a: file(100, 'y') }, {});
  assert.deepEqual(r.send, ['a']);
  assert.deepEqual(r.deleteLocal, []);
  assert.deepEqual(r.sendDelete, []);
});

test('1. la < pa -> nada', () => {
  const r = reconcilePlan({ a: file(100, 'x') }, {}, { a: file(200, 'y') }, {});
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

test('1. empate isHost true -> send', () => {
  const r = reconcilePlan({ a: file(100, 'x') }, {}, { a: file(100, 'y') }, {}, { isHost: true });
  assert.deepEqual(r.send, ['a']);
});

test('1. empate isHost false -> nada', () => {
  const r = reconcilePlan({ a: file(100, 'x') }, {}, { a: file(100, 'y') }, {}, { isHost: false });
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

// --- Caso 2: local vivo & peer deletado ---

test('2. la > pd -> send (edição vence delete)', () => {
  const r = reconcilePlan({ a: file(200, 'x') }, {}, {}, { a: 100 });
  assert.deepEqual(r.send, ['a']);
  assert.deepEqual(r.deleteLocal, []);
});

test('2. la <= pd -> deleteLocal (delete vence)', () => {
  const r = reconcilePlan({ a: file(100, 'x') }, {}, {}, { a: 200 });
  assert.deepEqual(r.deleteLocal, ['a']);
  assert.deepEqual(r.send, []);
});

// --- Bug 1: tombstone de deleção offline carimbado no mtime da última versão ---
// O lado que deletou offline propaga o DELETE com deletedAt = mtime da última
// versão conhecida. Estes casos provam o efeito no LADO DO PEER (que recebe o
// delete e roda a reconcile como caso 2 "local vivo & peer deletado").

test('bug1 (a) tombstone == peer mtime (peer inalterado) -> empate => peer deleta', () => {
  // O peer NÃO mexeu no arquivo: seu mtime local == mtime carimbado no tombstone.
  // Caso 2: la (100) > pd (100) é FALSO (empate) => deleteLocal. A deleção propaga.
  const r = reconcilePlan({ a: file(100, 'x') }, {}, {}, { a: 100 });
  assert.deepEqual(r.deleteLocal, ['a']);
  assert.deepEqual(r.send, []);
});

test('bug1 (b) tombstone < peer mtime (peer editou mais novo) -> caso 2 send => ressuscita', () => {
  // O peer editou o arquivo DEPOIS da última versão conhecida: peer mtime (200)
  // > tombstone (100). Caso 2: la (200) > pd (100) é VERDADEIRO => send: a edição
  // mais nova vence e o arquivo é ressuscitado para o lado que deletou. Sem perda.
  const r = reconcilePlan({ a: file(200, 'x') }, {}, {}, { a: 100 });
  assert.deepEqual(r.send, ['a']);
  assert.deepEqual(r.deleteLocal, []);
});

// --- Caso 3: local vivo & peer totalmente ausente ---

test('3. local vivo & peer ausente -> send', () => {
  const r = reconcilePlan({ a: file(100, 'x') }, {}, {}, {});
  assert.deepEqual(r.send, ['a']);
});

// --- Caso 4: local deletado & peer vivo ---

test('4. ld > pa -> sendDelete', () => {
  const r = reconcilePlan({}, { a: 200 }, { a: file(100, 'x') }, {});
  assert.deepEqual(r.sendDelete, ['a']);
  assert.deepEqual(r.send, []);
  assert.deepEqual(r.deleteLocal, []);
});

test('4. ld <= pa -> nada (peer reenvia)', () => {
  const r = reconcilePlan({}, { a: 100 }, { a: file(200, 'x') }, {});
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

// --- Caso 5: local deletado & peer deletado ---

test('5. ambos deletados -> nada', () => {
  const r = reconcilePlan({}, { a: 100 }, {}, { a: 200 });
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

// --- Caso 6: local deletado & peer ausente ---

test('6. local deletado & peer ausente -> nada', () => {
  const r = reconcilePlan({}, { a: 100 }, {}, {});
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

// --- Caso 7: local ausente & peer vivo ---

test('7. local ausente & peer vivo -> nada', () => {
  const r = reconcilePlan({}, {}, { a: file(100, 'x') }, {});
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

// --- Caso 8: local ausente & peer deletado ---

test('8. local ausente & peer deletado -> nada', () => {
  const r = reconcilePlan({}, {}, {}, { a: 100 });
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

// --- Offset: skew positivo e negativo mudando o vencedor (caso 1) ---

test('offset positivo: peer-clock adiantado, vira local mais novo -> send', () => {
  // peer mtime 150 no relógio do peer; offset = +100 => pa = 50 local.
  // la = 100 > 50 -> send.
  const r = reconcilePlan({ a: file(100, 'x') }, {}, { a: file(150, 'y') }, {}, { offset: 100 });
  assert.deepEqual(r.send, ['a']);
});

test('offset zero (mesmos dados): peer mais novo -> nada', () => {
  // Sem offset os mesmos números dariam pa = 150 > la = 100 -> nada.
  const r = reconcilePlan({ a: file(100, 'x') }, {}, { a: file(150, 'y') }, {}, { offset: 0 });
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

test('offset negativo: peer-clock atrasado, vira local mais antigo -> nada', () => {
  // peer mtime 120; offset = -100 => pa = 220 local. la = 200 < 220 -> nada.
  const r = reconcilePlan({ a: file(200, 'x') }, {}, { a: file(120, 'y') }, {}, { offset: -100 });
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

test('offset negativo invertendo: sem offset daria send, com offset nada', () => {
  // Sem offset: la=200 > pa=120 -> send. Com offset -100: pa=220 > la=200 -> nada.
  const noSkew = reconcilePlan({ a: file(200, 'x') }, {}, { a: file(120, 'y') }, {}, { offset: 0 });
  assert.deepEqual(noSkew.send, ['a']);
  const skew = reconcilePlan({ a: file(200, 'x') }, {}, { a: file(120, 'y') }, {}, { offset: -100 });
  assert.deepEqual(skew.send, []);
});

// --- Delete-vs-edit nos dois sentidos com offset ---

test('delete-vs-edit sentido 2 com offset: pd ajustado vence edição local', () => {
  // peerTomb 250 (peer clock); offset +100 => pd = 150 local. la = 100 < 150 -> deleteLocal.
  const r = reconcilePlan({ a: file(100, 'x') }, {}, {}, { a: 250 }, { offset: 100 });
  assert.deepEqual(r.deleteLocal, ['a']);
});

test('delete-vs-edit sentido 2 com offset: edição local vence pd ajustado', () => {
  // peerTomb 250; offset +200 => pd = 50 local. la = 100 > 50 -> send.
  const r = reconcilePlan({ a: file(100, 'x') }, {}, {}, { a: 250 }, { offset: 200 });
  assert.deepEqual(r.send, ['a']);
});

test('delete-vs-edit sentido 4 com offset: local delete vence edição do peer', () => {
  // peer vivo mtime 300; offset +250 => pa = 50 local. ld = 100 > 50 -> sendDelete.
  const r = reconcilePlan({}, { a: 100 }, { a: file(300, 'x') }, {}, { offset: 250 });
  assert.deepEqual(r.sendDelete, ['a']);
});

test('delete-vs-edit sentido 4 com offset: edição do peer vence local delete', () => {
  // peer vivo mtime 300; offset +150 => pa = 150 local. ld = 100 < 150 -> nada.
  const r = reconcilePlan({}, { a: 100 }, { a: file(300, 'x') }, {}, { offset: 150 });
  assert.deepEqual(r, { send: [], deleteLocal: [], sendDelete: [] });
});

// --- Mistura de múltiplos rels numa só chamada ---

test('múltiplos rels: listas mutuamente exclusivas', () => {
  const r = reconcilePlan(
    { s: file(200, 'a'), dl: file(100, 'b'), n: file(50, 'c') },
    { sd: 300 },
    { s: file(100, 'z'), dl: undefined, sd: file(50, 'q') },
    { dl: 200 }
  );
  // s: local vivo & peer vivo, la>pa -> send
  // dl: local vivo & peer deletado, la(100)<=pd(200) -> deleteLocal
  // n: local vivo & peer ausente -> send
  // sd: local deletado & peer vivo, ld(300)>pa(50) -> sendDelete
  assert.deepEqual(r.send.sort(), ['n', 's']);
  assert.deepEqual(r.deleteLocal, ['dl']);
  assert.deepEqual(r.sendDelete, ['sd']);
});

console.log(`\n${count} testes passaram.`);
