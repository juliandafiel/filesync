// Testa deleção OFFLINE: apagar um arquivo com o app desligado deve propagar a
// deleção (e NÃO ser ressuscitado) quando o app reconecta. Também testa
// delete+recriação rápida (suppressor por contador).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startShare } from '../src/server.js';
import { startJoin } from '../src/client.js';

const A = '/tmp/fs_off_A';
const B = '/tmp/fs_off_B';
const PORT = 4124;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'OK  ' : 'FALHOU '} ${m}`); if (!c) failures++; };
async function waitFor(fn, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await sleep(150); } return false; }
const exists = (p) => fs.existsSync(p);
const quiet = (pfx) => (m) => process.stdout.write(`  [${pfx}] ${m}\n`);
async function reset(d) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); }

async function main() {
  await reset(A); await reset(B);
  await fsp.writeFile(path.join(A, 'doc.txt'), 'conteudo');

  // 1) Sobe host + cliente, sincroniza o arquivo.
  let host = await startShare({ dir: A, port: PORT, noTunnel: true, log: quiet('host') });
  let client = await startJoin({ link: host.link, dir: B, log: quiet('join') });
  check(await waitFor(() => exists(path.join(B, 'doc.txt'))), 'sync inicial: doc.txt chegou em B');

  // 2) Cliente vai OFFLINE (encerra o processo do cliente).
  await client.shutdown();
  await sleep(500);

  // 3) Apaga o arquivo em B com o cliente desligado (deleção offline).
  await fsp.rm(path.join(B, 'doc.txt'));
  check(!exists(path.join(B, 'doc.txt')), 'arquivo apagado offline em B');

  // 4) Cliente RECONECTA (novo start -> detecta deleção offline via tombstone).
  client = await startJoin({ link: host.link, dir: B, log: quiet('join2') });

  // 5) A deleção deve PROPAGAR para A (não ressuscitar em B).
  check(await waitFor(() => !exists(path.join(A, 'doc.txt'))), 'deleção offline propagou: doc.txt sumiu de A');
  await sleep(1500);
  check(!exists(path.join(B, 'doc.txt')), 'doc.txt NÃO foi ressuscitado em B');

  // 6) delete+recriação rápida do mesmo caminho (suppressor por contador).
  await fsp.writeFile(path.join(A, 'r.txt'), 'v1');
  check(await waitFor(() => exists(path.join(B, 'r.txt'))), 'r.txt sincronizou para B');
  await fsp.rm(path.join(A, 'r.txt'));
  await fsp.writeFile(path.join(A, 'r.txt'), 'v2'); // recria rápido
  await sleep(2000);
  check(exists(path.join(B, 'r.txt')) && fs.readFileSync(path.join(B, 'r.txt'), 'utf8') === 'v2',
    'delete+recriação rápida: B fica com a versão recriada (v2)');

  await client.shutdown();
  await host.shutdown();
  console.log(`\n${failures === 0 ? 'OFFLINE OK' : failures + ' FALHA(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('erro:', e); process.exit(1); });
