// Roda o filesync em segundo plano (always-on) via processo destacado.
//
// startDetached faz spawn de um novo node executando bin/cli.js com os args
// dados, com stdio redirecionado para um arquivo de log (append), grava o pid
// num pidFile e chama unref() para que o processo-pai possa encerrar sozinho.
// stopDaemon/daemonStatus usam o pidFile para controlar/checar esse processo.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Caminho absoluto do CLI, resolvido a partir deste módulo (src/ -> ../bin/cli.js).
const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

// Inicia o app destacado. Retorna o pid do filho.
export function startDetached({ args = [], logFile, pidFile }) {
  // Garante que as pastas de log e pid existem.
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  // Abre o log em append; usamos o mesmo fd para stdout e stderr.
  const out = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [CLI, ...args], {
    detached: true,
    stdio: ['ignore', out, out],
  });

  fs.writeFileSync(pidFile, String(child.pid));
  child.unref(); // não segura o event loop do pai
  return child.pid;
}

// Para o daemon: lê o pid, mata o processo e remove o pidFile.
// Retorna true se havia um pid para matar, false caso contrário.
export function stopDaemon(pidFile) {
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  } catch {
    return false; // sem pidFile => nada rodando
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidFile, { force: true });
    return false;
  }

  let killed = true;
  try {
    process.kill(pid);
  } catch (err) {
    // ESRCH: processo já saiu; consideramos que não havia o que matar.
    if (err.code === 'ESRCH') killed = false;
    else throw err;
  }
  fs.rmSync(pidFile, { force: true });
  return killed;
}

// Estado do daemon a partir do pidFile. process.kill(pid, 0) checa se vive.
export function daemonStatus(pidFile) {
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  } catch {
    return { running: false, pid: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null };

  try {
    process.kill(pid, 0); // sinal 0: não mata, só testa existência/permissão
    return { running: true, pid };
  } catch (err) {
    // EPERM: existe mas sem permissão de sinalizar => ainda está vivo.
    if (err.code === 'EPERM') return { running: true, pid };
    return { running: false, pid };
  }
}
