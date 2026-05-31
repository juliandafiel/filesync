// Testes do DirSync (sincronização de diretórios, inclusive pastas vazias).
//   node test/unit-dirsync.mjs
//
// Exercita em disco temporário: varredura inicial, mkdir/rmdir LOCAIS (emitindo
// MKDIR/RMDIR e atualizando `dirs`), anti-eco (mkdir/rmdir remotos não devem
// re-propagar o evento local que disparam), aplicação de ordens remotas, e
// reconcileDirs. O EchoSuppressor usa um agendador de timer injetável para não
// deixar timers órfãos.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirSync } from '../src/dir-sync.js';
import { EchoSuppressor } from '../src/echo-suppress.js';
import { loadIgnore } from '../src/ignore.js';
import { MSG } from '../src/protocol.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

// Agendador no-op (não dispara nada): os testes não precisam expirar o anti-eco.
const noopTimer = () => ({ unref() {} });

function makeDirSync(dir, sent) {
  const echo = new EchoSuppressor({ setTimer: noopTimer });
  const ds = new DirSync({
    dir,
    ig: loadIgnore(dir),
    echo,
    isSafeTarget: async () => true, // raiz limpa sem symlinks (testado em pathsafety)
    send: (msg) => sent.push(msg),
    log: () => {},
  });
  return { ds, echo };
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'filesync-dirsync-'));

  // --- 1) scanDirs encontra pastas (inclusive aninhadas e vazias) ---
  {
    await fsp.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'vazia'));
    const sent = [];
    const { ds } = makeDirSync(dir, sent);
    const dirs = await ds.scanDirs();
    assert.ok(dirs.has('a') && dirs.has('a/b') && dirs.has('vazia'), 'scanDirs acha pastas aninhadas e vazias');
    ok('scanDirs encontra pastas aninhadas e vazias');
  }

  // --- 2) mkdir LOCAL: adiciona a `dirs` e emite MKDIR ---
  {
    const sent = [];
    const { ds } = makeDirSync(dir, sent);
    ds.onLocalAddDir(path.join(dir, 'nova'));
    assert.ok(ds.dirs.has('nova'), 'dirs contem a nova pasta');
    assert.deepEqual(sent, [{ type: MSG.MKDIR, rel: 'nova' }], 'emitiu MKDIR ao peer');
    ok('mkdir local atualiza dirs e emite MKDIR');
  }

  // --- 3) rmdir LOCAL: remove de `dirs` e emite RMDIR ---
  {
    const sent = [];
    const { ds } = makeDirSync(dir, sent);
    ds.dirs.add('nova');
    ds.onLocalRmDir(path.join(dir, 'nova'));
    assert.ok(!ds.dirs.has('nova'), 'dirs nao contem mais a pasta');
    assert.deepEqual(sent, [{ type: MSG.RMDIR, rel: 'nova' }], 'emitiu RMDIR ao peer');
    ok('rmdir local atualiza dirs e emite RMDIR');
  }

  // --- 4) ANTI-ECO: applyRemoteMkdir nao deve re-propagar o addDir que dispara ---
  {
    const sent = [];
    const { ds } = makeDirSync(dir, sent);
    await ds.applyRemoteMkdir('remota');
    assert.ok(ds.dirs.has('remota'), 'pasta remota criada e registrada');
    // O watcher dispararia addDir('remota'); simulamos: NAO deve re-emitir MKDIR.
    ds.onLocalAddDir(path.join(dir, 'remota'));
    assert.deepEqual(sent, [], 'eco do mkdir remoto foi suprimido (nada emitido)');
    ok('anti-eco: mkdir remoto nao re-propaga');
  }

  // --- 5) ANTI-ECO: applyRemoteRmdir nao deve re-propagar o unlinkDir ---
  {
    const sent = [];
    const { ds } = makeDirSync(dir, sent);
    ds.dirs.add('pararemover');
    await fsp.mkdir(path.join(dir, 'pararemover'), { recursive: true }).catch(() => {});
    await ds.applyRemoteRmdir('pararemover');
    assert.ok(!ds.dirs.has('pararemover'), 'pasta removida de dirs');
    ds.onLocalRmDir(path.join(dir, 'pararemover')); // eco do watcher
    assert.deepEqual(sent, [], 'eco do rmdir remoto foi suprimido');
    ok('anti-eco: rmdir remoto nao re-propaga');
  }

  // --- 6) reconcileDirs cria as pastas do peer que faltam (e ignora as ja conhecidas) ---
  {
    const sent = [];
    const { ds } = makeDirSync(dir, sent);
    ds.dirs.add('ja-existe');
    await ds.reconcileDirs(['ja-existe', 'peer-pasta', 'peer/aninhada']);
    assert.ok(ds.dirs.has('peer-pasta') && ds.dirs.has('peer/aninhada'), 'criou as pastas faltantes do peer');
    // reconcileDirs NAO emite MKDIR (a criação é local, anti-eco trata o evento).
    assert.deepEqual(sent, [], 'reconcileDirs nao emite mensagens');
    ok('reconcileDirs cria pastas faltantes sem re-emitir');
  }

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`\n${passed} testes passaram.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
