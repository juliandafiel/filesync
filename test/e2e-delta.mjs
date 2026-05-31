// Testa delta sync (rsync): edição pequena num arquivo grande deve transferir
// só os blocos alterados, com resultado byte-idêntico.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startShare } from '../src/server.js';
import { startJoin } from '../src/client.js';

const A = '/tmp/fs_delta_A';
const B = '/tmp/fs_delta_B';
const PORT = 4127;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'OK  ' : 'FALHOU '} ${m}`); if (!c) failures++; };
async function waitFor(fn, t = 12000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await sleep(150); } return false; }
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function reset(d) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); }

async function main() {
  await reset(A); await reset(B);
  const logs = [];
  const mk = (pfx) => (m) => { logs.push(`${pfx}:${m}`); process.stdout.write(`  [${pfx}] ${m}\n`); };

  // Arquivo de 2 MB, sincroniza cheio na primeira vez.
  const buf = crypto.randomBytes(2 * 1024 * 1024);
  await fsp.writeFile(path.join(A, 'big.dat'), buf);

  const host = await startShare({ dir: A, port: PORT, noTunnel: true, log: mk('host') });
  const client = await startJoin({ link: host.link, dir: B, log: mk('join') });

  check(await waitFor(() => fs.existsSync(path.join(B, 'big.dat')) &&
    fs.statSync(path.join(B, 'big.dat')).size === buf.length), 'sync inicial: big.dat (2MB) em B');
  await sleep(800);

  // Edita ~16 bytes no meio (a maioria dos blocos de 4KB fica igual).
  const edited = Buffer.from(buf);
  buf.fill(0); // garante diferença
  crypto.randomBytes(16).copy(edited, 1024 * 1024);
  await fsp.writeFile(path.join(A, 'big.dat'), edited);

  const synced = await waitFor(() => fs.existsSync(path.join(B, 'big.dat')) &&
    sha(path.join(B, 'big.dat')) === sha(path.join(A, 'big.dat')));
  check(synced, 'edição pequena propagou e B ficou byte-idêntico a A');

  // Confirma que o caminho DELTA foi usado (e que foi pequeno).
  const deltaLog = logs.find((l) => l.includes('delta big.dat'));
  check(!!deltaLog, 'delta foi usado para o update (não envio completo)');
  if (deltaLog) console.log('  -> ' + deltaLog.split(':').slice(1).join(':'));

  await client.shutdown();
  await host.shutdown();
  console.log(`\n${failures === 0 ? 'DELTA OK' : failures + ' FALHA(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('erro:', e); process.exit(1); });
