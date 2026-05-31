// Testa a AUTENTICAÇÃO MÚTUA PLENA (prova de posse da chave via AEAD):
//   (1) cliente com a CHAVE CERTA sincroniza normalmente (não é derrubado pelo
//       timer de auth — o HELLO decifrado chega em ~1 RTT);
//   (2) um SQUATTER que conhece só o TOKEN (passa o gate do header) mas NÃO
//       envia frame decifrável é derrubado pelo HOST dentro do authTimeoutMs,
//       LIBERANDO a vaga única (busy -> false) para o cliente legítimo.
// Sem túnel; usa authTimeoutMs curto para não esperar os 15s do default.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { startShare } from '../src/server.js';
import { startJoin } from '../src/client.js';
import { parseLink } from '../src/config.js';

const A = '/tmp/fs_auth_A';
const B = '/tmp/fs_auth_B';
const PORT = 4126;
const AUTH_MS = 800; // timeout de auth curto: o teste não pode esperar 15s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'OK  ' : 'FALHOU '} ${m}`); if (!c) failures++; };
async function waitFor(fn, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await sleep(100); } return false; }
const exists = (p) => fs.existsSync(p);
const quiet = (pfx) => (m) => process.stdout.write(`  [${pfx}] ${m}\n`);
async function reset(d) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); }

// Abre um WebSocket cru (sem SecureSocket) com o token correto no header e
// resolve com o resultado do handshake. Não envia NADA depois — simula o
// squatter que conhece o token mas não a chave (não consegue emitir frame
// decifrável). Mantemos a referência para fechar no fim do teste.
function rawConnect(wsUrl, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { 'x-filesync-token': token } });
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ ws, ...r }); } };
    ws.on('open', () => done({ ok: true }));
    // unexpected-response = handshake recusado pelo host (ex.: 409 vaga ocupada).
    ws.on('unexpected-response', (_req, res) => { res.resume(); done({ ok: false, status: res.statusCode }); });
    ws.on('error', () => done({ ok: false, status: null }));
  });
}

async function main() {
  await reset(A); await reset(B);
  await fsp.writeFile(path.join(A, 'ok.txt'), 'conteudo-legitimo');

  const host = await startShare({ dir: A, port: PORT, noTunnel: true, authTimeoutMs: AUTH_MS, log: quiet('host') });
  const { wsUrl, token } = parseLink(host.link);

  // --- (2a) SQUATTER conecta com o token certo e ocupa a vaga única. ---
  const squatter = await rawConnect(wsUrl, token);
  check(squatter.ok, 'squatter passou o gate do token (header) e abriu o WS');

  // Enquanto o squatter segura a vaga, uma 2ª conexão deve receber 409 (busy).
  const intruder = await rawConnect(wsUrl, token);
  check(!intruder.ok && intruder.status === 409, 'vaga ocupada pelo squatter: 2ª conexão recebe 409');
  try { intruder.ws.terminate(); } catch { /* já morto */ }

  // --- (2b) O HOST derruba o squatter dentro do authTimeoutMs (ele nunca
  // enviou frame decifrável), LIBERANDO a vaga. Provamos que a vaga voltou
  // observando que uma NOVA conexão crua agora passa o handshake (não dá 409). ---
  let squatterClosed = false;
  squatter.ws.on('close', () => { squatterClosed = true; });
  check(await waitFor(() => squatterClosed, AUTH_MS + 4000), 'HOST derrubou o squatter dentro do timeout de auth');

  const freed = await waitFor(async () => {
    const probe = await rawConnect(wsUrl, token);
    if (probe.ok) { try { probe.ws.terminate(); } catch { /* */ } return true; }
    // ainda 409? a vaga não foi liberada (ou outra sonda ainda fechando) — segue tentando
    try { probe.ws.terminate(); } catch { /* */ }
    return false;
  }, 5000);
  check(freed, 'vaga liberada após derrubar o squatter (busy -> false; nova conexão não recebe 409)');

  // --- (1) Cliente LEGÍTIMO (com a chave certa) conecta e sincroniza normalmente. ---
  const client = await startJoin({ link: host.link, dir: B, authTimeoutMs: AUTH_MS, log: quiet('join') });
  check(await waitFor(() => exists(path.join(B, 'ok.txt')) && fs.readFileSync(path.join(B, 'ok.txt'), 'utf8') === 'conteudo-legitimo'),
    'cliente com a chave certa NÃO é derrubado e sincroniza ok.txt');

  // Sincronização contínua segue funcionando (não foi morto pelo timer de auth).
  await fsp.writeFile(path.join(A, 'mais.txt'), 'segundo-arquivo');
  check(await waitFor(() => exists(path.join(B, 'mais.txt'))),
    'cliente legítimo continua vivo e sincroniza um novo arquivo');

  try { squatter.ws.terminate(); } catch { /* */ }
  await client.shutdown();
  await host.shutdown();
  console.log(`\n${failures === 0 ? 'AUTH OK' : failures + ' FALHA(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('erro:', e); process.exit(1); });
