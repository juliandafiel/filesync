import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startDetached, stopDaemon, daemonStatus } from '../src/daemon.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// Pasta temporaria isolada para log/pid (limpa no fim).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesync-daemon-'));
const pidFile = path.join(tmp, 'sub', 'filesync.pid'); // subpasta inexistente: testa mkdir
const logFile = path.join(tmp, 'logs', 'filesync.log');

// startDetached sempre spawna bin/cli.js; usamos os args 'status <pasta>' que
// saem rapido. Toleramos a corrida (o processo curto pode ja ter saido quando
// checamos daemonStatus). O ciclo de vida deterministico vem no bloco (d).

// (a) startDetached cria pidFile e retorna pid valido.
{
  const pid = startDetached({ args: ['status', tmp], logFile, pidFile });
  assert.equal(typeof pid, 'number', 'pid deve ser numero');
  assert.ok(pid > 0, 'pid deve ser positivo');
  assert.ok(fs.existsSync(pidFile), 'pidFile deve existir');
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(pid), 'pidFile contem o pid');
  assert.ok(fs.existsSync(logFile), 'logFile deve existir (stdio em append)');
  ok('startDetached cria pidFile e retorna pid');

  // (b) daemonStatus reporta um estado coerente logo apos (toleramos corrida:
  // o processo 'status' e curto e pode ja ter saido).
  const st = daemonStatus(pidFile);
  assert.equal(typeof st.running, 'boolean', 'running e boolean');
  assert.equal(st.pid, pid, 'status reporta o pid do pidFile');
  ok(`daemonStatus reporta estado coerente (running=${st.running})`);

  // (c) stopDaemon retorna boolean e remove o pidFile (mesmo se ja saiu).
  const killed = stopDaemon(pidFile);
  assert.equal(typeof killed, 'boolean', 'stopDaemon retorna boolean');
  assert.ok(!fs.existsSync(pidFile), 'pidFile removido apos stopDaemon');
  ok(`stopDaemon retorna boolean (${killed}) e remove pidFile`);
}

// (d) Teste deterministico do ciclo de vida com um processo longo controlado:
// spawn de um node que dorme ~700ms, gravando seu pid num pidFile manual, e
// validamos running=true enquanto vivo, depois stop mata e remove.
{
  const pidFile2 = path.join(tmp, 'longo.pid');
  // Processo que vive ~700ms; nao usamos startDetached aqui porque queremos
  // controle do tempo de vida (independe do CLI).
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 700)'], {
    detached: true,
    stdio: 'ignore',
  });
  fs.writeFileSync(pidFile2, String(child.pid));
  child.unref();

  await sleep(80); // garante que ja esta no ar
  const st = daemonStatus(pidFile2);
  assert.equal(st.running, true, 'processo longo deve estar running');
  assert.equal(st.pid, child.pid, 'pid bate');
  ok('daemonStatus running=true para processo vivo');

  const killed = stopDaemon(pidFile2);
  assert.equal(killed, true, 'stopDaemon mata processo vivo => true');
  assert.ok(!fs.existsSync(pidFile2), 'pidFile2 removido');
  await sleep(30);
  // Apos matar, status sem pidFile => running false, pid null.
  const st2 = daemonStatus(pidFile2);
  assert.deepEqual(st2, { running: false, pid: null }, 'sem pidFile => parado');
  ok('stopDaemon mata processo vivo e limpa pidFile');
}

// (e) stopDaemon/daemonStatus sem pidFile: falso/parado, sem lancar.
{
  const ghost = path.join(tmp, 'naoexiste.pid');
  assert.equal(stopDaemon(ghost), false, 'stopDaemon sem pidFile => false');
  assert.deepEqual(daemonStatus(ghost), { running: false, pid: null }, 'status sem pidFile');
  ok('sem pidFile: stopDaemon=false e status parado');
}

// Limpeza.
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} testes passaram.`);
