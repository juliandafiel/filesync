// Envolve um WebSocket aplicando criptografia ponta-a-ponta (E2E) em TODAS as
// mensagens, de modo que o operador do túnel só veja bytes cifrados.
//
// Cada frame no fio é binário: [tipo(1)][encrypt(payload)], tipo 0 = texto/JSON,
// 1 = binário. Reemite 'message'(plaintextBuffer, isBinary) já decifrado.
// Espelha a API do ws usada pelo app (send/readyState/OPEN/bufferedAmount/ping/
// close/terminate e eventos message/close/error/pong). Se key for null, passa
// direto (sem cifrar) — usado só quando E2E está desabilitado.
import { EventEmitter } from 'node:events';
import { encrypt, decrypt } from './crypto.js';

// Tamanho mínimo do corpo cifrado (sem o byte de tipo): iv(12) + tag(16). Um
// frame menor que isso nem chega a ter IV+tag completos, então não há nada para
// decifrar — tratamos como frame inválido em vez de deixar o createDecipheriv/
// setAuthTag lançar lá dentro. Mantido local para não acoplar à API de crypto.js.
const MIN_CIPHERTEXT_LEN = 12 + 16;

export class SecureSocket extends EventEmitter {
  // Terceiro arg opcional (retrocompatível): { onAuthFail } permite ao dono do
  // socket observar a falha de autenticação do canal (ex.: logar). Não é
  // obrigatório registrar nada — a falha já é tratada com segurança aqui dentro.
  constructor(ws, key, opts = {}) {
    super();
    this.ws = ws;
    this.key = key || null;
    this.onAuthFail = typeof opts.onAuthFail === 'function' ? opts.onAuthFail : null;
    this.OPEN = ws.OPEN;
    ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
    ws.on('close', (...a) => this.emit('close', ...a));
    ws.on('error', (e) => this.emit('error', e));
    ws.on('pong', () => this.emit('pong'));
  }

  get readyState() { return this.ws.readyState; }
  get bufferedAmount() { return this.ws.bufferedAmount; }

  // Trata um frame que não pôde ser autenticado/decifrado. Esta é a rota segura
  // para QUALQUER frame inválido (chave errada, frame forjado/adulterado, lixo
  // ou curto demais). A regra de ouro: isso NUNCA pode derrubar o processo.
  // Como o canal é AES-256-GCM autenticado, só quem possui a chave consegue
  // produzir frames com tag válida; portanto, um peer que envia frames inválidos
  // não tem a chave e deve ser desconectado — é a autenticação mútua mínima
  // implícita do canal (não confiamos em quem não prova posse da chave).
  _onAuthFail(reason) {
    // Avisa o dono, se ele registrou interesse (não derruba se ele lançar).
    if (this.onAuthFail) { try { this.onAuthFail(reason); } catch { /* ignora */ } }
    // Só emite 'error' se houver listener: emitir 'error' sem listener faz o
    // EventEmitter LANÇAR e mataria host/cliente com um único frame forjado.
    if (this.listenerCount('error') > 0) {
      this.emit('error', new Error('falha de autenticação do canal: ' + reason));
    }
    // Derruba a conexão subjacente: o peer não prova posse da chave.
    this.close();
  }

  _onMessage(data, isBinary) {
    if (!this.key) { this.emit('message', data, isBinary); return; }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Valida o tamanho ANTES de tentar decifrar: um frame menor que
    // 1(tipo) + iv(12) + tag(16) faria createDecipheriv/setAuthTag lançar.
    if (buf.length < 1 + MIN_CIPHERTEXT_LEN) {
      this._onAuthFail('frame curto demais');
      return;
    }
    try {
      const type = buf[0];
      const plain = decrypt(buf.subarray(1), this.key);
      this.emit('message', plain, type === 1);
    } catch (e) {
      this._onAuthFail('falha ao decifrar: ' + e.message);
    }
  }

  send(data) {
    if (!this.key) { this.ws.send(data); return; }
    const isBinary = Buffer.isBuffer(data);
    const payload = isBinary ? data : Buffer.from(data);
    const frame = Buffer.concat([Buffer.from([isBinary ? 1 : 0]), encrypt(payload, this.key)]);
    this.ws.send(frame);
  }

  ping() { try { this.ws.ping(); } catch { /* socket fechado */ } }
  close(...a) { try { this.ws.close(...a); } catch { /* já fechado */ } }
  terminate() { if (typeof this.ws.terminate === 'function') this.ws.terminate(); }
}
