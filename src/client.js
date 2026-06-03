// Papel "join" (cliente): conecta no link, valida token via header, sincroniza
// e reconecta automaticamente com backoff quando a conexão cai.
import WebSocket from 'ws';
import { loadIgnore } from './ignore.js';
import { SyncEngine } from './sync-engine.js';
import { parseLink } from './config.js';
import { deriveKey } from './crypto.js';
import { SecureSocket } from './secure-socket.js';
import { startKeepalive } from './keepalive.js';

export async function startJoin({ link, dir, checksum, log, authTimeoutMs = 15000 }) {
  const { wsUrl, token, key } = parseLink(link);
  if (!token) log('aviso: link sem token (#t=...). A conexão pode ser recusada.');
  if (!key) log('aviso: link sem chave (#k=...). Sem criptografia ponta-a-ponta.');
  // Mesma derivação do host: passphrase (k) + token como salt.
  const cryptoKey = key ? deriveKey(key, Buffer.from(token || '')) : null;

  const ig = loadIgnore(dir);
  const engine = new SyncEngine({ dir, ig, isHost: false, checksum, log });
  await engine.start();

  let stopped = false;
  let attempt = 0;
  let current = null;

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(wsUrl, {
      headers: {
        ...(token ? { 'x-filesync-token': token } : {}),
        // localtunnel (loca.lt) mostra uma página de aviso ("Click to continue")
        // para visitantes novos e responde 200 em vez de fazer o upgrade WS.
        // Estes headers pulam o interstício e deixam o handshake chegar no host.
        'Bypass-Tunnel-Reminder': 'true',
        'User-Agent': 'filesync',
      },
    });
    current = ws;
    let lastStatus = null; // statusCode de um handshake recusado
    let stopKA = null;
    let secure = null;
    let authTimer = null;

    ws.on('open', () => {
      attempt = 0;
      log('conectado ao host');
      secure = new SecureSocket(ws, cryptoKey); // E2E
      // Listener defensivo: a SecureSocket emite 'error' ao falhar decifrar um
      // frame (chave incorreta). Sem handler, o EventEmitter LANÇA em 'error' e
      // mata o cliente. Aqui só LOGAMOS; a SecureSocket fecha o ws subjacente, o
      // que dispara ws.on('close' abaixo (detach + reconexão com backoff). O
      // cliente nunca quebra se o canal seguro emitir 'error'.
      secure.on('error', (e) => log('falha no canal seguro: ' + e.message));
      stopKA = startKeepalive(ws, {
        onDead: () => { log('host sem resposta — reconectando'); ws.terminate(); },
      });
      engine.attach(secure);

      // PROVA DE POSSE DA CHAVE PELO HOST (autentica o host ao cliente).
      //
      // Hoje o cliente confia em qualquer host que o link aponte. Mas como o
      // canal é AES-256-GCM AUTENTICADO, um frame que CHEGA DECIFRADO só pôde ser
      // produzido por quem possui a chave — prova implícita via AEAD. O primeiro
      // frame decifrado é o HELLO do HOST (enviado já no attach), então prova que
      // o host tem a chave. Exigimos recebê-lo dentro de AUTH_TIMEOUT; senão é um
      // host impostor (ou um endpoint que só conhece o token) e reconectamos.
      authTimer = setTimeout(() => {
        log('host não provou posse da chave — reconectando');
        ws.terminate(); // cai em ws.on('close' -> detach + reconexão com backoff
      }, authTimeoutMs);
      authTimer.unref?.(); // não segura o event loop vivo só por causa do timer
      secure.once('message', () => clearTimeout(authTimer)); // 1º frame decifrado = prova de posse
    });

    ws.on('close', async (code) => {
      if (authTimer) { clearTimeout(authTimer); authTimer = null; } // evita timer pendente após desconexão normal
      if (stopKA) { stopKA(); stopKA = null; }
      if (secure) await engine.detach(secure); // só limpa se ainda for a conexão ativa
      if (stopped) return;
      if (lastStatus === 401 || code === 1008) {
        log('conexão recusada (token inválido). Encerrando.');
        return;
      }
      attempt++;
      // 409 (já há um peer) não é fatal: o outro pode sair. Espera mais.
      const base = lastStatus === 409 ? 5000 : 1000;
      const delay = Math.min(30000, base * 2 ** Math.min(attempt, 5));
      log(`desconectado — tentando reconectar em ${Math.round(delay / 1000)}s`);
      setTimeout(connect, delay);
    });

    ws.on('error', (e) => log('erro de conexão: ' + e.message));
    ws.on('unexpected-response', (_req, res) => {
      lastStatus = res.statusCode;
      res.resume(); // drena a resposta para liberar o socket
      log(`host respondeu ${res.statusCode} (${res.statusCode === 401 ? 'token inválido' : res.statusCode === 409 ? 'já há um peer conectado' : 'erro'})`);
    });
  }

  connect();

  const shutdown = async () => {
    stopped = true;
    if (current && current.readyState === WebSocket.OPEN) current.close();
    await engine.stop();
  };

  return { wsUrl, shutdown };
}
