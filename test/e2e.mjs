// Teste end-to-end em um processo só: sobe share (sem túnel) + join e verifica
// sincronização inicial, mudança de B->A, deleção A->B e ignore de .git.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startShare } from '../src/server.js';
import { startJoin } from '../src/client.js';

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const A = '/tmp/fs_test_A';
const B = '/tmp/fs_test_B';
const PORT = 4123;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'OK  ' : 'FALHOU '} ${msg}`);
  if (!cond) failures++;
}
async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
}
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');

async function reset(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
}

const quietLog = (prefix) => (m) => process.stdout.write(`  [${prefix}] ${m}\n`);

async function main() {
  await reset(A);
  await reset(B);
  // Estado inicial: arquivo em A, um .git que deve ser ignorado.
  await fsp.writeFile(path.join(A, 'teste.txt'), 'ola mundo');
  await fsp.mkdir(path.join(A, '.git'), { recursive: true });
  await fsp.writeFile(path.join(A, '.git', 'config'), 'segredo');
  // Arquivo só em B (deve subir para A na união inicial).
  await fsp.writeFile(path.join(B, 'so_no_b.txt'), 'vim do B');

  const host = await startShare({ dir: A, port: PORT, noTunnel: true, log: quietLog('host') });
  console.log('  link:', host.link);
  const client = await startJoin({ link: host.link, dir: B, log: quietLog('join') });

  // 1) Sincronização inicial bidirecional.
  check(await waitFor(() => exists(path.join(B, 'teste.txt'))), 'A->B: teste.txt chegou em B');
  check(read(path.join(B, 'teste.txt')) === 'ola mundo', 'A->B: conteúdo correto');
  check(await waitFor(() => exists(path.join(A, 'so_no_b.txt'))), 'B->A: so_no_b.txt chegou em A');
  check(!exists(path.join(B, '.git', 'config')), 'ignore: .git NÃO sincronizou');

  // 2) Edição em B reflete em A.
  await sleep(500);
  await fsp.writeFile(path.join(B, 'teste.txt'), 'editado no B');
  check(await waitFor(() => exists(path.join(A, 'teste.txt')) && read(path.join(A, 'teste.txt')) === 'editado no B'),
    'B->A: edição refletiu em A');

  // 3) Criação de subpasta + arquivo em A reflete em B.
  await fsp.mkdir(path.join(A, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(A, 'sub', 'novo.txt'), 'aninhado');
  check(await waitFor(() => exists(path.join(B, 'sub', 'novo.txt'))), 'A->B: subpasta/arquivo novo refletiu');

  // 4) Deleção em A reflete em B.
  await fsp.rm(path.join(A, 'teste.txt'));
  check(await waitFor(() => !exists(path.join(B, 'teste.txt'))), 'A->B: deleção refletiu em B');

  // 5) Sem loop de eco: arquivo estável continua existindo dos dois lados.
  await sleep(1000);
  check(exists(path.join(A, 'sub', 'novo.txt')) && exists(path.join(B, 'sub', 'novo.txt')),
    'estabilidade: sem eco/loop apagando arquivos');

  // 6) ARQUIVO GRANDE multi-chunk (testa a race begin/chunk + integridade hash).
  const big = crypto.randomBytes(5 * 1024 * 1024); // 5 MB, ~20 chunks
  await fsp.writeFile(path.join(A, 'grande.bin'), big);
  const arrived = await waitFor(() => exists(path.join(B, 'grande.bin')) &&
    fs.statSync(path.join(B, 'grande.bin')).size === big.length, 15000);
  check(arrived, 'A->B: arquivo grande (5MB) chegou completo');
  check(arrived && sha256(path.join(A, 'grande.bin')) === sha256(path.join(B, 'grande.bin')),
    'integridade: hash do arquivo grande bate dos dois lados (sem corrupção)');

  // 7) Volta grande no sentido B->A também.
  const big2 = crypto.randomBytes(3 * 1024 * 1024);
  await fsp.writeFile(path.join(B, 'grande2.bin'), big2);
  const arrived2 = await waitFor(() => exists(path.join(A, 'grande2.bin')) &&
    fs.statSync(path.join(A, 'grande2.bin')).size === big2.length, 15000);
  check(arrived2 && sha256(path.join(A, 'grande2.bin')) === sha256(path.join(B, 'grande2.bin')),
    'B->A: arquivo grande (3MB) íntegro');

  await client.shutdown();
  await host.shutdown();

  console.log(`\n${failures === 0 ? 'TODOS OS TESTES PASSARAM' : failures + ' TESTE(S) FALHARAM'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('erro no teste:', e); process.exit(1); });
