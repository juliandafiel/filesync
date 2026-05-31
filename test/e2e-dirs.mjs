// Testa sincronização de pastas vazias e detecção de rename (mover sem retransferir).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startShare } from '../src/server.js';
import { startJoin } from '../src/client.js';

const A = '/tmp/fs_dir_A';
const B = '/tmp/fs_dir_B';
const PORT = 4126;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'OK  ' : 'FALHOU '} ${m}`); if (!c) failures++; };
async function waitFor(fn, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await sleep(150); } return false; }
const exists = (p) => fs.existsSync(p);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const quiet = (pfx) => (m) => process.stdout.write(`  [${pfx}] ${m}\n`);
async function reset(d) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); }

async function main() {
  await reset(A); await reset(B);
  // Pasta vazia presente ANTES da conexão (deve replicar via reconcile).
  await fsp.mkdir(path.join(A, 'vazia-inicial'), { recursive: true });

  const host = await startShare({ dir: A, port: PORT, noTunnel: true, log: quiet('host') });
  const client = await startJoin({ link: host.link, dir: B, log: quiet('join') });

  // 1) Pasta vazia inicial replicada.
  check(await waitFor(() => isDir(path.join(B, 'vazia-inicial'))), 'pasta vazia inicial replicou para B');

  // 2) Pasta vazia criada ao vivo.
  await sleep(500);
  await fsp.mkdir(path.join(A, 'nova-vazia'), { recursive: true });
  check(await waitFor(() => isDir(path.join(B, 'nova-vazia'))), 'pasta vazia criada ao vivo replicou (MKDIR)');

  // 3) Rename de arquivo (mover sem retransferir).
  const conteudo = 'x'.repeat(200000);
  await fsp.writeFile(path.join(A, 'old.txt'), conteudo);
  check(await waitFor(() => exists(path.join(B, 'old.txt'))), 'old.txt sincronizou para B');
  await sleep(400);
  await fsp.rename(path.join(A, 'old.txt'), path.join(A, 'renomeado.txt'));
  check(await waitFor(() => exists(path.join(B, 'renomeado.txt'))), 'rename: renomeado.txt apareceu em B');
  check(await waitFor(() => !exists(path.join(B, 'old.txt'))), 'rename: old.txt sumiu de B');
  check(exists(path.join(B, 'renomeado.txt')) && fs.readFileSync(path.join(B, 'renomeado.txt'), 'utf8') === conteudo,
    'rename: conteúdo preservado em B');

  // 4) Remover pasta vazia ao vivo.
  await fsp.rmdir(path.join(A, 'nova-vazia'));
  check(await waitFor(() => !exists(path.join(B, 'nova-vazia'))), 'rmdir: pasta vazia removida em B');

  await client.shutdown();
  await host.shutdown();
  console.log(`\n${failures === 0 ? 'DIRS OK' : failures + ' FALHA(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('erro:', e); process.exit(1); });
