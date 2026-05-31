// Testes do bookkeeping de ACK/NACK no REMETENTE (SyncEngine). Rode:
//   node test/unit-acknack.mjs
//
// O ACK/NACK fim-a-fim corrige o bug em que o remetente marcava peerManifest
// otimista mesmo quando o receptor rejeitava a escrita (disco cheio, erro de
// escrita, hash divergente, versão local mais nova) — peerManifest mentia e o
// arquivo nunca era reenviado. Aqui exercitamos o lado REMETENTE de forma
// determinística: instanciamos um SyncEngine com um ws FALSO (send/readyState/
// OPEN) e chamamos onControl(msg) diretamente, sem subir watcher nem conexão.
//
// Cobrimos:
//   1. ACK limpa o inflight (e mantém o peerManifest otimista).
//   2. NACK recuperável reverte o peerManifest e REENVIA uma vez (allowDelta:false).
//   3. NACK recuperável só reenvia 1x (cap de retry — segundo NACK não reenvia).
//   4. NACK por 'sem espaço em disco' reverte o peerManifest e NÃO reenvia.
//   5. NACK por 'versão local mais nova' reverte e NÃO reenvia.
//   6. NACK do caminho DELTA (só rel, sem transferId) reverte e reenvia uma vez.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from '../src/sync-engine.js';
import { loadIgnore } from '../src/ignore.js';
import { MSG } from '../src/protocol.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

// ws falso: registra tudo que foi enviado (JSON parseado). Sempre "aberto".
// bufferedAmount:0 faz o waitDrain do transfer.js resolver imediatamente (sem
// ele, undefined < limite seria false e o sendFile travaria no timeout de 60s).
function makeFakeWs() {
  const sent = [];
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send(data) { try { sent.push(JSON.parse(data)); } catch { sent.push({ binary: true, len: data.length }); } },
  };
}

// Monta um SyncEngine pronto para receber onControl, sem start()/attach() reais.
// Define manualmente ws, peerManifest e manifest (o que attach()/start() fariam).
async function makeEngine(dir) {
  const ig = loadIgnore(dir);
  const eng = new SyncEngine({ dir, ig, isHost: true, log: () => {} });
  const ws = makeFakeWs();
  eng.ws = ws;
  eng.peerManifest = {};
  eng.peerTombstones = {};
  return { eng, ws };
}

const meta = (hash, size = 4, mtimeMs = 1700000000000) => ({ hash, size, mtimeMs });

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'filesync-acknack-'));

  // --- 1) ACK limpa o inflight; peerManifest permanece otimista ---
  {
    const { eng } = await makeEngine(dir);
    const tid = 1234;
    eng.peerManifest['a.txt'] = meta('h1');
    eng.inflight.set(tid, { rel: 'a.txt', meta: meta('h1'), retries: 0 });

    await eng.onControl({ type: MSG.ACK, transferId: tid });

    assert.equal(eng.inflight.has(tid), false, 'ACK removeu o registro em voo');
    assert.deepEqual(eng.peerManifest['a.txt'], meta('h1'), 'peerManifest preservado (peer confirmou)');
    ok('ACK limpa inflight e mantém peerManifest');
  }

  // --- 2) NACK recuperável: reverte peerManifest e reenvia 1x (allowDelta:false) ---
  {
    const { eng, ws } = await makeEngine(dir);
    const tid = 2222;
    const rel = 'doc.txt';
    // O arquivo precisa existir em disco e no manifesto para o pushFile reenviar.
    await fsp.writeFile(path.join(dir, rel), 'oioi');
    eng.manifest[rel] = meta('hdoc');
    eng.peerManifest[rel] = meta('hdoc'); // set otimista que o NACK deve reverter
    eng.inflight.set(tid, { rel, meta: meta('hdoc'), retries: 0 });
    ws.sent.length = 0;

    await eng.onControl({ type: MSG.NACK, rel, reason: 'erro de escrita', transferId: tid });

    assert.equal(eng.inflight.has(tid), false, 'inflight antigo removido');
    // Reenvio: pushFile com envio completo gera um FILE_BEGIN para o rel.
    const begins = ws.sent.filter((m) => m.type === MSG.FILE_BEGIN && m.rel === rel);
    assert.equal(begins.length, 1, 'reenviou o arquivo uma vez (FILE_BEGIN)');
    // O reenvio re-registra o peerManifest OTIMISTA (nova transferência em voo);
    // ele será confirmado/revertido pelo próximo ACK/NACK desta nova tentativa.
    assert.deepEqual(eng.peerManifest[rel], meta('hdoc'), 'peerManifest re-otimista após reenvio');
    // O novo inflight foi registrado com retries=1 (cap), pelo transferId novo.
    const novo = [...eng.inflight.values()].find((e) => e.rel === rel);
    assert.ok(novo, 'novo registro em voo criado pelo reenvio');
    assert.equal(novo.retries, 1, 'retry marcado como 1 (cap)');
    ok('NACK recuperável reverte peerManifest e reenvia 1x');
  }

  // --- 3) Cap de retry: um segundo NACK (retries já em 1) NÃO reenvia ---
  {
    const { eng, ws } = await makeEngine(dir);
    const tid = 3333;
    const rel = 'doc2.txt';
    await fsp.writeFile(path.join(dir, rel), 'abcd');
    eng.manifest[rel] = meta('hdoc2');
    eng.peerManifest[rel] = meta('hdoc2');
    // Simula que já houve um reenvio: retries=1.
    eng.inflight.set(tid, { rel, meta: meta('hdoc2'), retries: 1 });
    ws.sent.length = 0;

    await eng.onControl({ type: MSG.NACK, rel, reason: 'erro de escrita', transferId: tid });

    assert.equal(eng.peerManifest[rel], undefined, 'reverteu o peerManifest');
    const begins = ws.sent.filter((m) => m.type === MSG.FILE_BEGIN);
    assert.equal(begins.length, 0, 'NÃO reenviou (cap de 1 retry atingido)');
    ok('NACK com retries=1 não reenvia (cap)');
  }

  // --- 4) NACK por 'sem espaço em disco': reverte mas NÃO reenvia (persistente) ---
  {
    const { eng, ws } = await makeEngine(dir);
    const tid = 4444;
    const rel = 'big.bin';
    await fsp.writeFile(path.join(dir, rel), 'xyz');
    eng.manifest[rel] = meta('hbig');
    eng.peerManifest[rel] = meta('hbig');
    eng.inflight.set(tid, { rel, meta: meta('hbig'), retries: 0 });
    ws.sent.length = 0;

    await eng.onControl({ type: MSG.NACK, rel, reason: 'sem espaço em disco', transferId: tid });

    assert.equal(eng.peerManifest[rel], undefined, 'reverteu o peerManifest (honesto: peer não tem)');
    assert.equal(eng.inflight.has(tid), false, 'inflight removido');
    const begins = ws.sent.filter((m) => m.type === MSG.FILE_BEGIN);
    assert.equal(begins.length, 0, 'NÃO reenviou (motivo persistente: disco cheio)');
    ok('NACK por disco cheio reverte e não reenvia');
  }

  // --- 5) NACK por 'versão local mais nova': reverte mas NÃO reenvia (persistente) ---
  {
    const { eng, ws } = await makeEngine(dir);
    const tid = 5555;
    const rel = 'novo.txt';
    await fsp.writeFile(path.join(dir, rel), 'qwer');
    eng.manifest[rel] = meta('hnovo');
    eng.peerManifest[rel] = meta('hnovo');
    eng.inflight.set(tid, { rel, meta: meta('hnovo'), retries: 0 });
    ws.sent.length = 0;

    await eng.onControl({ type: MSG.NACK, rel, reason: 'versão local mais nova', transferId: tid });

    assert.equal(eng.peerManifest[rel], undefined, 'reverteu o peerManifest');
    const begins = ws.sent.filter((m) => m.type === MSG.FILE_BEGIN);
    assert.equal(begins.length, 0, 'NÃO reenviou (peer tem versão legítima mais nova)');
    ok('NACK por versão local mais nova reverte e não reenvia');
  }

  // --- 6) NACK do caminho DELTA (só rel, sem transferId): reverte e reenvia 1x ---
  {
    const { eng, ws } = await makeEngine(dir);
    const rel = 'delta.txt';
    await fsp.writeFile(path.join(dir, rel), 'zxcv');
    eng.manifest[rel] = meta('hdelta');
    eng.peerManifest[rel] = meta('hdelta');
    // Sem inflight: o DELTA não usa o transferId de sendFile.
    ws.sent.length = 0;

    await eng.onControl({ type: MSG.NACK, rel, reason: 'delta inválido' });

    const begins = ws.sent.filter((m) => m.type === MSG.FILE_BEGIN && m.rel === rel);
    assert.equal(begins.length, 1, 'reenviou via envio completo (allowDelta:false)');
    // Reenvio re-otimiza o peerManifest (nova transferência completa em voo).
    assert.deepEqual(eng.peerManifest[rel], meta('hdelta'), 'peerManifest re-otimista após reenvio completo');
    // O reenvio completo registra inflight (com retries=1, pelo cap por rel).
    const novo = [...eng.inflight.values()].find((e) => e.rel === rel);
    assert.ok(novo, 'reenvio completo registrou inflight (delta NACK cai em envio cheio)');
    assert.equal(novo.retries, 1, 'retry marcado como 1 (cap por rel)');
    ok('NACK do caminho DELTA (sem transferId) reverte e reenvia 1x completo');
  }

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`\n${passed} testes passaram.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
