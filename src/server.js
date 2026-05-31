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
  let failedAuth = 0; // rate-limit simples de tentativas com token errado

  server.on('upgrade', (req, socket, head) => {
    // Token só via header (query string vazaria em logs/infra do túnel).
    if (!tokenMatches(req.headers['x-filesync-token'], token)) {
      failedAuth++;
      if (failedAuth >= 20) {
        log('muitas tentativas de token inválido — encerrando por segurança');
        socket.destroy();
        setImmediate(() => shutdown().then(() => process.exit(1)));
        return;
      }
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (busy) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }
    failedAuth = 0;
    // Reserva a vaga SINCRONAMENTE aqui: fecha a janela de corrida em que duas
    // conexões simultâneas passariam o gate antes de 'connection' disparar.
    busy = true;
    let established = false;
    socket.on('close', () => { if (!established) busy = false; }); // libera se o upgrade falhar
    wss.handleUpgrade(req, socket, head, (ws) => { established = true; wss.emit('connection', ws); });
  });

  wss.on('connection', (rawWs) => {
    const secure = new SecureSocket(rawWs, cryptoKey); // E2E
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
