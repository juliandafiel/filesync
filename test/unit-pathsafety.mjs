// Testes de segurança de caminho (path traversal por symlink). Rode:
//   node test/unit-pathsafety.mjs
//
// Cobre a barreira REFORÇADA contra symlink em componente INTERMEDIÁRIO: um
// symlink-pasta pré-existente na raiz não pode servir de ponte para escrever
// FORA da pasta sincronizada (ex: ~/.ssh/authorized_keys).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from '../src/sync-engine.js';
import { loadIgnore } from '../src/ignore.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

// Cria a engine sem subir watcher/conexão: só precisamos de this.dir + this.ig
// para exercitar rejectReason/isSafeTarget.
function makeEngine(dir) {
  return new SyncEngine({ dir, ig: loadIgnore(dir), isHost: true, log: () => {} });
}

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'filesync-pathsafety-'));
  const root = path.join(base, 'sync');     // pasta sincronizada
  const outside = path.join(base, 'outside'); // alvo do ataque (FORA da raiz)
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'authorized_keys'), 'original');

  const eng = makeEngine(root);

  // --- 1) Symlink-pasta INTERMEDIÁRIO apontando para fora deve ser RECUSADO ---
  // raiz/evil -> ../outside ; o peer tenta gravar "evil/authorized_keys".
  await fsp.symlink(outside, path.join(root, 'evil'), 'dir');
  {
    const rel = 'evil/authorized_keys';
    // isSafeRel é puramente lexico: o caminho PARECE seguro (não tem '..').
    // É exatamente o buraco que isSafeTarget fecha.
    const safeTarget = await eng.isSafeTarget(rel);
    assert.equal(safeTarget, false, 'isSafeTarget recusa symlink de diretório intermediário');
    const motivo = await eng.rejectReason(rel);
    assert.ok(motivo, `rejectReason recusa (motivo: ${motivo})`);
    ok('escrita através de symlink-pasta intermediário é recusada');
  }

  // --- 2) Symlink direto na FOLHA apontando para fora também é recusado ---
  {
    const leaf = path.join(root, 'leaklink');
    await fsp.symlink(path.join(outside, 'authorized_keys'), leaf, 'file');
    const motivo = await eng.rejectReason('leaklink');
    assert.ok(motivo, `rejectReason recusa symlink na folha (motivo: ${motivo})`);
    ok('escrita através de symlink na folha é recusada');
  }

  // --- 3) Caminho normal DENTRO da raiz (sem symlink) é ACEITO ---
  {
    await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
    assert.equal(await eng.isSafeTarget('sub/ok.txt'), true, 'isSafeTarget aceita caminho interno');
    assert.equal(await eng.rejectReason('sub/ok.txt'), null, 'rejectReason aceita caminho interno');
    ok('caminho interno legítimo é aceito');
  }

  // --- 4) Folha ainda inexistente cujo PARENT é válido é aceita ---
  // (o ancestral existente mais profundo é a raiz/sub, dentro da raiz real).
  {
    assert.equal(await eng.isSafeTarget('sub/profundo/novo.txt'), true,
      'isSafeTarget aceita folha nova sob parent válido');
    ok('folha nova sob diretório válido é aceita');
  }

  // --- 5) Escape lexico clássico ('..') segue recusado ---
  {
    assert.equal(await eng.isSafeTarget('../fora.txt'), false, 'isSafeTarget recusa ..');
    assert.ok(await eng.rejectReason('../fora.txt'), 'rejectReason recusa ..');
    ok('escape lexico com .. é recusado');
  }

  // Garante que o ataque NÃO criou nada fora da raiz (o arquivo original intacto).
  const conteudo = await fsp.readFile(path.join(outside, 'authorized_keys'), 'utf8');
  assert.equal(conteudo, 'original', 'arquivo fora da raiz permaneceu intacto');
  ok('nenhuma escrita vazou para fora da raiz');

  await fsp.rm(base, { recursive: true, force: true });
  console.log(`\n${passed} testes passaram.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
