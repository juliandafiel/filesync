import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { deriveKey, randomSalt, encrypt } from '../src/crypto.js';
import { SecureSocket } from '../src/secure-socket.js';

const salt = randomSalt();
const key = deriveKey('senha-secreta', salt);

// WebSocket falso: registra o que foi enviado/fechado e reemite 'message' como
// o ws faria, para podermos exercitar o _onMessage da SecureSocket.
class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = false;
  }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  ping() {}
  // Simula a chegada de um frame do fio.
  feed(data, isBinary = true) { this.emit('message', data, isBinary); }
}

// Constrói o frame do fio do jeito que SecureSocket.send faria, mas cifrando com
// uma chave arbitrária — útil para forjar frames com a chave "errada".
function frameWith(plain, k, isBinary = false) {
  return Buffer.concat([Buffer.from([isBinary ? 1 : 0]), encrypt(Buffer.from(plain), k)]);
}

// 1) Round-trip normal com chave: send cifra; um frame válido vira 'message'.
{
  const ws = new FakeWS();
  const a = new SecureSocket(ws, key);
  // send deve cifrar (frame no fio != plaintext) e prefixar o byte de tipo.
  a.send('ola mundo');
  assert.equal(ws.sent.length, 1, 'send produziu 1 frame');
  const frame = ws.sent[0];
  assert.ok(Buffer.isBuffer(frame), 'frame é Buffer');
  assert.ok(!frame.includes(Buffer.from('ola mundo')), 'plaintext não aparece no fio');

  // Alimentar esse mesmo frame de volta deve reemitir o plaintext.
  const b = new SecureSocket(ws, key);
  let got = null;
  let gotBinary = null;
  b.on('message', (plain, isBinary) => { got = plain; gotBinary = isBinary; });
  ws.feed(frame, false);
  assert.ok(got && got.equals(Buffer.from('ola mundo')), 'round-trip preserva o conteúdo');
  assert.equal(gotBinary, false, 'tipo texto preservado (isBinary=false)');
  console.log('ok 1 - round-trip normal com chave');
}

// 2) Frame forjado (chave errada) NÃO derruba o processo e dispara o
//    fechamento + onAuthFail, sem listener 'error' registrado.
{
  const ws = new FakeWS();
  let authFailReason = null;
  const s = new SecureSocket(ws, key, { onAuthFail: (r) => { authFailReason = r; } });
  // NINGUÉM registra 'error' (espelha o engine, que só ouve 'message').
  const wrongKey = deriveKey('senha-errada', salt);
  const forjado = frameWith('payload malicioso', wrongKey);

  // Se _onMessage emitisse 'error' sem listener, isto lançaria aqui (uncaught).
  assert.doesNotThrow(() => ws.feed(forjado, true), 'frame forjado não pode derrubar o processo');
  assert.equal(ws.closed, true, 'conexão subjacente foi fechada (autenticação falhou)');
  assert.ok(authFailReason && /decifrar/.test(authFailReason), 'onAuthFail recebeu o motivo');
  console.log('ok 2 - frame forjado não derruba e dispara fechamento/onAuthFail');
}

// 2b) Mesmo cenário, mas com lixo aleatório (não é nem um frame válido).
{
  const ws = new FakeWS();
  const s = new SecureSocket(ws, key);
  const lixo = Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 0xab)]); // tamanho ok, conteúdo inválido
  assert.doesNotThrow(() => ws.feed(lixo, true), 'lixo não pode derrubar o processo');
  assert.equal(ws.closed, true, 'conexão fechada após lixo indecifrável');
  console.log('ok 2b - lixo indecifrável não derruba e fecha a conexão');
}

// 3) Frame curto demais NÃO derruba (validação de tamanho antes do decrypt).
{
  for (const len of [0, 1, 5, 1 + 12 + 16 - 1]) { // até 1 byte abaixo do mínimo
    const ws = new FakeWS();
    let authFailReason = null;
    const s = new SecureSocket(ws, key, { onAuthFail: (r) => { authFailReason = r; } });
    const curto = Buffer.alloc(len, 0x00);
    assert.doesNotThrow(() => ws.feed(curto, true), `frame de ${len} bytes não pode derrubar`);
    assert.equal(ws.closed, true, `conexão fechada para frame de ${len} bytes`);
    assert.ok(authFailReason && /curto/.test(authFailReason), 'onAuthFail aponta frame curto');
  }
  console.log('ok 3 - frame curto demais não derruba e fecha a conexão');
}

// 4) Modo SEM chave (E2E desabilitada): passa direto, sem cifrar nem fechar.
{
  const ws = new FakeWS();
  const s = new SecureSocket(ws, null);
  // send não cifra: o byte exato vai para o fio.
  s.send('texto cru');
  assert.equal(ws.sent[0], 'texto cru', 'send sem chave envia o dado cru');

  // _onMessage repassa o dado e o isBinary intactos, sem fechar a conexão.
  let got = null;
  let gotBinary = null;
  s.on('message', (d, isBinary) => { got = d; gotBinary = isBinary; });
  ws.feed('qualquer coisa', true);
  assert.equal(got, 'qualquer coisa', 'mensagem repassada sem alteração');
  assert.equal(gotBinary, true, 'isBinary repassado sem alteração');
  assert.equal(ws.closed, false, 'sem chave não fecha a conexão por frame "inválido"');
  console.log('ok 4 - modo sem chave passa direto (sem regressão)');
}

console.log('\nALL PASS');
