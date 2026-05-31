// Testa: (1) identidade/link estável entre reinícios; (2) link carrega token+key;
// (3) lixeira recupera a versão sobrescrita de um arquivo.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startShare } from '../src/server.js';
import { startJoin } from '../src/client.js';
import { parseLink } from '../src/config.js';
import { TRASH_DIR } from '../src/trash.js';

const A = '/tmp/fs_sec_A';
const B = '/tmp/fs_sec_B';
const PORT = 4125;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'OK  ' : 'FALHOU '} ${m}`); if (!c) failures++; };
async function waitFor(fn, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await sleep(150); } return false; }
const exists = (p) => fs.existsSync(p);
const quiet = (pfx) => (m) => process.stdout.write(`  [${pfx}] ${m}\n`);
async function reset(d) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); }

// Acha o conteúdo de um arquivo dentro da lixeira (qualquer timestamp).
function findInTrash(rootDir, rel) {
  const base = path.join(rootDir, TRASH_DIR);
  if (!fs.existsSync(base)) return null;
  for (const ts of fs.readdirSync(base)) {
    const p = path.join(base, ts, rel);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
}

async function main() {
  await reset(A); await reset(B);

  // 1) Identidade/link estável: dois starts na mesma pasta -> mesmo token+key.
  let host = await startShare({ dir: A, port: PORT, noTunnel: true, log: quiet('host1') });
  const l1 = parseLink(host.link);
  await host.shutdown();
  await sleep(300);
  host = await startShare({ dir: A, port: PORT, noTunnel: true, log: quiet('host2') });
  const l2 = parseLink(host.link);
  check(l1.token && l1.token === l2.token, 'token estável entre reinícios');
  check(l1.key && l1.key === l2.key, 'key estável entre reinícios');
  check(!!l2.token && !!l2.key, 'link carrega token (#t) e key (#k)');

  // 2) Lixeira recupera versão sobrescrita.
  await fsp.writeFile(path.join(A, 'f.txt'), 'v1');
  let client = await startJoin({ link: host.link, dir: B, log: quiet('join') });
  check(await waitFor(() => exists(path.join(B, 'f.txt'))), 'sync inicial: f.txt em B (v1)');
  await sleep(400);
  await fsp.writeFile(path.join(A, 'f.txt'), 'v2-novo-conteudo'); // sobrescreve em A
  check(await waitFor(() => exists(path.join(B, 'f.txt')) && fs.readFileSync(path.join(B, 'f.txt'), 'utf8') === 'v2-novo-conteudo'),
    'B atualizou para v2');
  check(await waitFor(() => findInTrash(B, 'f.txt') === 'v1', 4000),
    'lixeira em B guardou a versão antiga (v1)');

  await client.shutdown();
  await host.shutdown();
  console.log(`\n${failures === 0 ? 'SECURE OK' : failures + ' FALHA(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('erro:', e); process.exit(1); });
