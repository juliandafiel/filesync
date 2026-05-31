#!/usr/bin/env node
// CLI do filesync: comandos `share`, `join` e `status`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { startDetached, stopDaemon, daemonStatus } from '../src/daemon.js';
import { loadIgnore, isIgnored } from '../src/ignore.js';
import { buildManifest } from '../src/manifest.js';
import { loadState } from '../src/state.js';
import { startShare } from '../src/server.js';
import { startJoin } from '../src/client.js';
import { DEFAULT_PORT } from '../src/config.js';

function ts() {
  return new Date().toISOString().slice(11, 19);
}
function log(msg) {
  process.stdout.write(`[${ts()}] ${msg}\n`);
}

function resolveDir(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`Pasta inválida: ${abs}`);
    process.exit(1);
  }
  return abs;
}

const program = new Command();
program
  .name('filesync')
  .description('Sincroniza uma pasta em tempo real entre dois PCs, via link.')
  .version('1.0.0');

program
  .command('share')
  .description('Compartilha uma pasta e gera o link para o outro PC.')
  .argument('<pasta>', 'pasta a sincronizar')
  .option('-p, --port <porta>', 'porta local', String(DEFAULT_PORT))
  .option('--no-tunnel', 'não abrir túnel público (usar só na rede local)')
  .option('--checksum', 'rehashear tudo na inicialização (ignora o cache de mtime)')
  .action(async (pasta, opts) => {
    const dir = resolveDir(pasta);
    const port = parseInt(opts.port, 10);
    log(`compartilhando ${dir}`);
    const session = await startShare({ dir, port, noTunnel: !opts.tunnel, checksum: opts.checksum, log });
    console.log('\n  Link para compartilhar com o outro PC:\n');
    console.log('    ' + session.link + '\n');
    if (opts.tunnel) {
      console.log('  (No outro PC: filesync join "<link>" <pasta>)\n');
    } else {
      console.log(`  Modo local: o outro PC usa  ws://SEU_IP:${port}#t=<token>\n`);
    }
    setupShutdown(session.shutdown);
  });

program
  .command('join')
  .description('Conecta no link de outro PC e sincroniza com uma pasta local.')
  .argument('<link>', 'link gerado pelo comando share')
  .argument('<pasta>', 'pasta local a sincronizar')
  .action(async (link, pasta) => {
    const dir = resolveDir(pasta);
    log(`sincronizando ${dir}`);
    const session = await startJoin({ link, dir, log });
    setupShutdown(session.shutdown);
  });

// Arquivos de controle do daemon (fora da pasta sincronizada, em /tmp).
function daemonFiles(dir) {
  const key = Buffer.from(path.resolve(dir)).toString('base64url').slice(0, 40);
  return {
    pidFile: path.join(os.tmpdir(), `filesync-${key}.pid`),
    logFile: path.join(os.tmpdir(), `filesync-${key}.log`),
  };
}

program
  .command('daemon')
  .description('Roda o "share" em segundo plano (always-on). Ações: start|stop|status.')
  .argument('<ação>', 'start | stop | status')
  .argument('<pasta>', 'pasta a sincronizar')
  .option('-p, --port <porta>', 'porta local (no start)', String(DEFAULT_PORT))
  .action((acao, pasta, opts) => {
    const dir = resolveDir(pasta);
    const { pidFile, logFile } = daemonFiles(dir);
    if (acao === 'start') {
      const st = daemonStatus(pidFile);
      if (st.running) { console.log(`já rodando (pid ${st.pid})`); return; }
      const pid = startDetached({ args: ['share', dir, '--port', opts.port], logFile, pidFile });
      console.log(`daemon iniciado (pid ${pid}). Logs: ${logFile}`);
      console.log(`O link aparece no log: tail -f "${logFile}"`);
    } else if (acao === 'stop') {
      console.log(stopDaemon(pidFile) ? 'daemon encerrado.' : 'nenhum daemon rodando.');
    } else if (acao === 'status') {
      const st = daemonStatus(pidFile);
      console.log(st.running ? `rodando (pid ${st.pid})` : 'parado');
    } else {
      console.error('ação inválida: use start | stop | status');
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Lista os arquivos que seriam sincronizados (respeitando ignores).')
  .argument('<pasta>', 'pasta a inspecionar')
  .action(async (pasta) => {
    const dir = resolveDir(pasta);
    const ig = loadIgnore(dir);
    const { files } = loadState(dir); // usa o cache de hashes para ir mais rápido
    const manifest = await buildManifest(dir, ig, { prev: files });
    const entries = Object.entries(manifest).sort((a, b) => a[0].localeCompare(b[0]));
    let total = 0;
    for (const [rel, meta] of entries) {
      total += meta.size;
      console.log(`  ${formatSize(meta.size).padStart(10)}  ${rel}`);
    }
    console.log(`\n  ${entries.length} arquivo(s), ${formatSize(total)} no total.`);
    // Mostra alguns exemplos de ignores ativos.
    const ignored = ['.git', 'node_modules', 'arquivo.tmp'].filter((p) => isIgnored(ig, p) || isIgnored(ig, p + '/'));
    if (ignored.length) console.log(`  Ignorando (exemplos): ${ignored.join(', ')}`);
  });

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function setupShutdown(shutdown) {
  let closing = false;
  const handler = async () => {
    if (closing) return;
    closing = true;
    log('encerrando...');
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

program.parseAsync(process.argv);
