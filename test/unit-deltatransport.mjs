// Testes do DeltaTransport (sincronização incremental rsync). Rode:
//   node test/unit-deltatransport.mjs
//
// Monta DOIS transportes (A=remetente, B=receptor) ligados por um par de "ws"
// falsos em memória, cada um com sua pasta temporária. Exercita o round-trip
// completo: A.pushDelta -> B.handleDeltaReq (responde SIG) -> A monta o DELTA ->
// B.applyDelta reconstrói e valida. Também cobre: SIG has:false (peer sem o
// arquivo) -> pushDelta retorna false; e applyDelta recusando caminho inseguro.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DeltaTransport } from '../src/delta-transport.js';
import { MSG } from '../src/protocol.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Par de "ws" falsos: o que um envia (JSON) chega como mensagem de controle no
// outro. O roteamento (qual handler chamar por msg.type) é feito pelo harness,
// imitando o onControl do SyncEngine. As mensagens são entregues de forma
// assíncrona (microtask) para o pushDelta poder aguardar a Promise do SIG.
function makeLink() {
  const peers = {};
  function makeWs(name, other) {
    return {
      readyState: 1, OPEN: 1,
      send(json) { queueMicrotask(() => peers[other].route(JSON.parse(json))); },
      _name: name,
    };
  }
  peers.A = { ws: makeWs('A', 'B') };
  peers.B = { ws: makeWs('B', 'A') };
  return peers;
}

async function main() {
  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'filesync-deltaA-'));
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'filesync-deltaB-'));

  const link = makeLink();
  let bWrites = []; // capturadas via onRemoteFileWritten em B

  const tA = new DeltaTransport({
    dir: dirA, log: () => {}, getWs: () => link.A.ws,
    rejectReason: async () => null,
    expectWrite: () => {},
    onRemoteFileWritten: () => {},
    onWork: () => {},
  });
  const tB = new DeltaTransport({
    dir: dirB, log: () => {}, getWs: () => link.B.ws,
    rejectReason: async (rel) => (rel.includes('..') ? 'caminho inseguro' : null),
    expectWrite: () => {},
    onRemoteFileWritten: (rel, meta) => bWrites.push({ rel, meta }),
    onWork: () => {},
  });

  // Roteamento: imita o switch do onControl do SyncEngine.
  link.A.route = (msg) => { if (msg.type === MSG.SIG) tA.resolveSig(msg); };
  link.B.route = (msg) => {
    if (msg.type === MSG.DELTA_REQ) tB.handleDeltaReq(msg);
    else if (msg.type === MSG.DELTA) tB.applyDelta(msg);
  };

  // --- 1) Round-trip de delta: A edita um arquivo grande que B já tem (versão antiga) ---
  {
    // Conteúdo base grande (acima de DELTA_MIN para ser representativo); B tem a
    // versão antiga, A a nova com uma pequena alteração no meio.
    const base = Buffer.alloc(300 * 1024, 7);
    const novo = Buffer.from(base);
    novo.fill(42, 100 * 1024, 100 * 1024 + 16); // muda 16 bytes
    await fsp.writeFile(path.join(dirB, 'big.dat'), base); // B: versão antiga
    await fsp.writeFile(path.join(dirA, 'big.dat'), novo); // A: versão nova
    const meta = { hash: sha(novo), size: novo.length, mtimeMs: 1700000000000 };

    const sent = await tA.pushDelta('big.dat', meta, link.A.ws);
    // pushDelta dispara mensagens assíncronas; espera o pipeline assentar.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sent, true, 'pushDelta retornou true (delta compensou)');
    const reconstruido = await fsp.readFile(path.join(dirB, 'big.dat'));
    assert.equal(sha(reconstruido), meta.hash, 'B reconstruiu byte-identico ao novo de A');
    assert.equal(bWrites.length, 1, 'onRemoteFileWritten chamado uma vez em B');
    assert.equal(bWrites[0].rel, 'big.dat', 'rel correto no callback');
    ok('round-trip de delta reconstrói o arquivo byte-identico');
  }

  // --- 2) Peer NAO tem o arquivo antigo: SIG has:false -> pushDelta retorna false ---
  {
    bWrites = [];
    const novo = Buffer.alloc(300 * 1024, 9);
    await fsp.writeFile(path.join(dirA, 'novo.dat'), novo); // só A tem
    const meta = { hash: sha(novo), size: novo.length, mtimeMs: 1700000000000 };
    const sent = await tA.pushDelta('novo.dat', meta, link.A.ws);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent, false, 'sem arquivo antigo no peer, pushDelta retorna false (cai no envio cheio)');
    assert.equal(bWrites.length, 0, 'nada gravado em B (nenhum delta aplicado)');
    ok('peer sem arquivo antigo -> pushDelta false (fallback)');
  }

  // --- 3) applyDelta recusa caminho inseguro (rejectReason) ---
  {
    bWrites = [];
    await tB.applyDelta({ rel: '../escape', hash: 'x', size: 1, mtimeMs: 0, blockSize: 4096, ops: [] });
    assert.equal(bWrites.length, 0, 'applyDelta recusado nao grava nada');
    ok('applyDelta recusa caminho inseguro');
  }

  // --- 4) applyDelta rejeita delta com hash/tamanho que nao batem ---
  {
    bWrites = [];
    // ops trivial (literal) que produz "abc", mas anunciamos um hash errado.
    const ops = [{ d: Buffer.from('abc').toString('base64') }];
    await tB.applyDelta({ rel: 'ruim.txt', hash: 'hash-errado', size: 3, mtimeMs: 0, blockSize: 4096, ops });
    assert.equal(bWrites.length, 0, 'delta com hash invalido nao e aplicado');
    ok('applyDelta rejeita delta com hash invalido');
  }

  // --- 5) resolveSig destrava a Promise pendente; cancelPending limpa o resto ---
  {
    // Injeta manualmente uma entrada pendente e confirma que resolveSig a remove.
    let resolved = 'pendente';
    tA.pendingSig.set('tid', { resolve: (v) => { resolved = v; }, timer: setTimeout(() => {}, 1e9) });
    tA.resolveSig({ type: MSG.SIG, transferId: 'tid', has: false });
    assert.equal(resolved, null, 'resolveSig(has:false) resolve com null');
    assert.equal(tA.pendingSig.has('tid'), false, 'entrada removida de pendingSig');
    // cancelPending nao deve lançar com mapa vazio.
    tA.cancelPending();
    ok('resolveSig destrava pendente e cancelPending limpa');
  }

  await fsp.rm(dirA, { recursive: true, force: true });
  await fsp.rm(dirB, { recursive: true, force: true });
  console.log(`\n${passed} testes passaram.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
