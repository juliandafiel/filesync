// Papel "share" (host): sobe servidor HTTP+WebSocket, valida token, opcionalmente
// abre o túnel público e imprime o link. Aceita um peer por vez.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadIgnore } from './ignore.js';
import { SyncEngine } from './sync-engine.js';
import { openTunnel } from './tunnel.js';
import { buildLink } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { deriveKey } from './crypto.js';
import { SecureSocket } from './secure-socket.js';
import { startKeepalive } from './keepalive.js';

// Comparação de token em tempo constante (evita ataque de timing).
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function startShare({ dir, port, noTunnel, checksum, log }) {
  const ig = loadIgnore(dir);
  // Identidade estável: o mesmo token/key entre reinícios -> o link continua válido.
  const identity = loadOrCreateIdentity(dir);
  const token = identity.token;
  // Chave de cifra E2E derivada da passphrase (identity.key) + token como salt.
  const cryptoKey = deriveKey(identity.key, Buffer.from(token));

  const engine = new SyncEngine({ dir, ig, isHost: true, checksum, log });
  await engine.start();

  // Resposta neutra: não confirma a um scanner que aqui roda um host filesync.
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });

  // noServer: validamos o token no handshake antes de aceitar.
  const wss = new WebSocketServer({ noServer: true });
  let busy = false;

  // Rate-limit de tentativas com token inválido COM DECAIMENTO temporal.
  //
  // POR QUE NÃO MATAR O PROCESSO: a versão anterior chamava process.exit(1) após
  // 20 tokens errados. Como a URL pública do túnel é conhecida por quem recebe o
  // link (e pode vazar), qualquer um conseguia derrubar o host só mandando 20
  // requests errados — o "rate-limit" virava um botão de desligar (DoS crítico).
  // O token tem 24 bytes (~192 bits), então brute-force já é inviável; aqui só
  // precisamos não ser um vetor de DoS. Logo: NUNCA encerramos o processo por
  // falha de auth. Apenas atrasamos a resposta 401 quando há muitas falhas
  // recentes (janela deslizante por decaimento), mantendo o host VIVO.
  let failScore = 0;        // "pontuação" de falhas recentes (decai com o tempo)
  let lastFailAt = 0;       // instante da última falha, para calcular o decaimento
  const FAIL_DECAY_MS = 5000;   // 1 ponto de falha decai a cada 5s
  const FAIL_FREE = 5;          // primeiras falhas não sofrem atraso
  const FAIL_DELAY_STEP = 250;  // atraso adicional por ponto acima do limite livre
  const FAIL_DELAY_MAX = 5000;  // teto do atraso (nunca prende recursos por muito tempo)

  server.on('upgrade', (req, socket, head) => {
    // Token só via header (query string vazaria em logs/infra do túnel).
    if (!tokenMatches(req.headers['x-filesync-token'], token)) {
      // Aplica o decaimento desde a última falha antes de contabilizar a nova.
      const now = Date.now();
      if (lastFailAt) failScore = Math.max(0, failScore - (now - lastFailAt) / FAIL_DECAY_MS);
      lastFailAt = now;
      failScore++;
      // Atraso crescente (mas limitado) só quando há excesso de falhas recentes.
      // Não bloqueia o event loop: usa setTimeout e destrói o socket ao final.
      const over = Math.max(0, failScore - FAIL_FREE);
      const delayMs = Math.min(FAIL_DELAY_MAX, over * FAIL_DELAY_STEP);
      const reject = () => {
        try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch { /* socket já morto */ }
        socket.destroy();
      };
      if (delayMs > 0) {
        if (failScore === FAIL_FREE + 1) log('muitas tentativas de token inválido — aplicando atraso (host segue no ar)');
        setTimeout(reject, delayMs).unref?.();
      } else {
        reject();
      }
      return;
    }
    if (busy) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }
    // Auth bem-sucedida: zera a pontuação de falhas.
    failScore = 0;
    lastFailAt = 0;
    // Reserva a vaga SINCRONAMENTE aqui: fecha a janela de corrida em que duas
    // conexões simultâneas passariam o gate antes de 'connection' disparar.
    busy = true;
    let established = false;
    socket.on('close', () => { if (!established) busy = false; }); // libera se o upgrade falhar
    wss.handleUpgrade(req, socket, head, (ws) => { established = true; wss.emit('connection', ws); });
  });

  wss.on('connection', (rawWs) => {
    const secure = new SecureSocket(rawWs, cryptoKey); // E2E
    // Listener defensivo: a SecureSocket emite 'error' quando um frame falha ao
    // decifrar (peer sem a chave correta). Sem um handler, o EventEmitter LANÇA
    // em 'error' e derruba o host. Aqui só LOGAMOS — a SecureSocket fecha o ws
    // subjacente, o que dispara rawWs.on('close' abaixo (engine.detach + busy=false),
    // liberando a vaga única. Mantemos o host vivo independentemente.
    secure.on('error', (e) => log('falha no canal seguro: ' + e.message));
    const stopKA = startKeepalive(rawWs, {
      onDead: () => { log('peer sem resposta — encerrando conexão'); rawWs.terminate(); },
    });
    log('peer conectado');
    engine.attach(secure);
    rawWs.on('close', async () => {
      stopKA();
      log('peer desconectado — aguardando reconexão');
      await engine.detach(secure); // espera limpar ANTES de liberar a vaga
      busy = false;
    });
    rawWs.on('error', (e) => log('erro no socket: ' + e.message));
  });

  await new Promise((resolve) => server.listen(port, resolve));
  log(`servidor ouvindo na porta ${port}`);

  let publicUrl = `http://localhost:${port}`;
  let tunnel = null;
  if (!noTunnel) {
    log('abrindo túnel público...');
    tunnel = await openTunnel(port);
    publicUrl = tunnel.url;
    tunnel.onError((e) => log(`erro no túnel: ${e.message} — o link pode ter expirado; reinicie o "share" para gerar um novo`));
    log('atenção: a pasta fica acessível publicamente por este link enquanto o app roda; só compartilhe o link com quem deve ter acesso.');
  }

  const link = buildLink(publicUrl, token, identity.key);

  const shutdown = async () => {
    await engine.stop();
    if (tunnel) await tunnel.close().catch(() => {});
    wss.close();
    server.close();
  };

  return { link, token, port, publicUrl, shutdown };
}
