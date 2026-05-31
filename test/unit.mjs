// Testes de unidade: cache rápido de manifesto e precedência de ignores.
import fsp from 'node:fs/promises';
import { buildManifest } from '../src/manifest.js';
import { loadIgnore, isIgnored } from '../src/ignore.js';
import { saveState, loadState } from '../src/state.js';

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'OK  ' : 'FALHOU '} ${msg}`);
  if (!cond) failures++;
}

async function testCache() {
  const dir = '/tmp/fs_unit_cache';
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(dir + '/a.txt', 'x'.repeat(50000));
  await fsp.writeFile(dir + '/b.txt', 'y'.repeat(50000));
  const ig = loadIgnore(dir);

  // Captura quantos foram hasheados via o log.
  let line = '';
  const log = (s) => { line = s; };

  await buildManifest(dir, ig, { prev: {}, log });
  check(/2 arquivo\(s\) hasheado/.test(line), 'cache vazio: hasheia os 2 arquivos');

  const m1 = await buildManifest(dir, ig, { prev: {} });
  saveState(dir, { files: m1, tombstones: {} });
  const { files: prev } = loadState(dir);
  await buildManifest(dir, ig, { prev, log });
  check(/0 arquivo\(s\) hasheado.*2 reaproveitado/.test(line), 'cache cheio (nada mudou): reaproveita 2, hasheia 0');

  await fsp.writeFile(dir + '/a.txt', 'z'.repeat(50001));
  await buildManifest(dir, ig, { prev, log });
  check(/1 arquivo\(s\) hasheado.*1 reaproveitado/.test(line), 'após editar 1: hasheia 1, reaproveita 1');

  await buildManifest(dir, ig, { prev, checksum: true, log });
  check(/2 arquivo\(s\) hasheado.*0 reaproveitado/.test(line), '--checksum força rehash de 2');
}

async function testIgnore() {
  const dir = '/tmp/fs_unit_ignore';
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  // Usuário tenta desfazer ignores internos — não pode.
  await fsp.writeFile(dir + '/.syncignore', '!.git\n!.filesync-state.json\n*.log\n');
  const ig = loadIgnore(dir);
  check(isIgnored(ig, '.git/config') === true, '.git ignorado mesmo com !.git no .syncignore');
  check(isIgnored(ig, '.filesync-state.json') === true, 'state file sempre ignorado');
  check(isIgnored(ig, 'app.log') === true, 'padrão do usuário *.log funciona');
  check(isIgnored(ig, 'src/main.js') === false, 'arquivo normal não é ignorado');
}

async function main() {
  await testCache();
  await testIgnore();
  console.log(`\n${failures === 0 ? 'UNIT OK' : failures + ' FALHA(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
