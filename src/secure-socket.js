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

export class SecureSocket extends EventEmitter {
  constructor(ws, key) {
    super();
    this.ws = ws;
    this.key = key || null;
    this.OPEN = ws.OPEN;
    ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
    ws.on('close', (...a) => this.emit('close', ...a));
    ws.on('error', (e) => this.emit('error', e));
    ws.on('pong', () => this.emit('pong'));
  }

  get readyState() { return this.ws.readyState; }
  get bufferedAmount() { return this.ws.bufferedAmount; }

  _onMessage(data, isBinary) {
    if (!this.key) { this.emit('message', data, isBinary); return; }
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const type = buf[0];
      const plain = decrypt(buf.subarray(1), this.key);
      this.emit('message', plain, type === 1);
    } catch (e) {
      this.emit('error', new Error('falha ao decifrar: ' + e.message));
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
