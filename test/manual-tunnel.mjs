// Teste REAL pela internet: sobe 'share' com TÚNEL público (loca.lt) e conecta
// 'join' pelo link público. Exercita túnel + wss + E2E + delta de ponta a ponta.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startShare } from './src/server.js';
import { startJoin } from './src/client.js';

const A = '/tmp/fs_real_A';
const B = '/tmp/fs_real_B';
const PORT = 4400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log(`${c ? '✅ OK ' : '❌ FALHOU'} ${m}`); if (!c) failures++; };
async function waitFor(fn, t = 25000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await sleep(250); } return false; }
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ex = (p) => fs.existsSync(p);
const mk = (pfx) => (m) => process.stdout.write(`  [${pfx}] ${m}\n`);
async function reset(d) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); }

async function main() {
  await reset(A); await reset(B);
  await fsp.writeFile(path.join(A, 'ola.txt'), 'sincronizado pela internet!');

  console.log('\n— Subindo host com túnel público real (pode levar alguns segundos)...\n');
  const host = await startShare({ dir: A, port: PORT, noTunnel: false, log: mk('host') });
  console.log('\n  LINK PÚBLICO:', host.link, '\n');
  check(/^https:\/\//.test(host.link), 'túnel gerou link https público');

  const client = await startJoin({ link: host.link, dir: B, log: mk('join') });

  // 1) Sync inicial pelo túnel.
  check(await waitFor(() => ex(path.join(B, 'ola.txt'))), 'A→B pelo túnel: ola.txt chegou');
  check(ex(path.join(B, 'ola.txt')) && fs.readFileSync(path.join(B, 'ola.txt'), 'utf8') === 'sincronizado pela internet!',
    'conteúdo correto (E2E decifrou certo)');

  // 2) Edição B→A pelo túnel.
  await sleep(800);
  await fsp.writeFile(path.join(B, 'resposta.txt'), 'voltou pelo túnel');
  check(await waitFor(() => ex(path.join(A, 'resposta.txt'))), 'B→A pelo túnel: resposta.txt chegou');

  // 3) Arquivo grande + integridade pelo túnel.
  const big = crypto.randomBytes(3 * 1024 * 1024);
  await fsp.writeFile(path.join(A, 'grande.bin'), big);
  const ok = await waitFor(() => ex(path.join(B, 'grande.bin')) && fs.statSync(path.join(B, 'grande.bin')).size === big.length, 40000);
  check(ok && sha(path.join(A, 'grande.bin')) === sha(path.join(B, 'grande.bin')), 'arquivo grande (3MB) íntegro pelo túnel');

  // 4) Delta pelo túnel: edição pequena no grande.
  await sleep(800);
  const edited = Buffer.from(big); crypto.randomBytes(16).copy(edited, 1024 * 1024);
  await fsp.writeFile(path.join(A, 'grande.bin'), edited);
  check(await waitFor(() => ex(path.join(B, 'grande.bin')) && sha(path.join(B, 'grande.bin')) === sha(path.join(A, 'grande.bin')), 40000),
    'delta pelo túnel: edição pequena propagou byte-idêntica');

  await client.shutdown();
  await host.shutdown();
  console.log(`\n${failures === 0 ? '🎉 TESTE REAL PELO TÚNEL: TUDO OK' : failures + ' FALHA(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('erro:', e); process.exit(1); });
