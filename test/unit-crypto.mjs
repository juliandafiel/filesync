import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { deriveKey, randomSalt, encrypt, decrypt } from '../src/crypto.js';

const salt = randomSalt();
const key = deriveKey('senha-secreta', salt);

// 0) Tamanhos esperados das primitivas
{
  assert.equal(randomSalt().length, 16, 'salt 16 bytes');
  assert.equal(key.length, 32, 'chave 32 bytes (AES-256)');
  assert.ok(Buffer.isBuffer(key), 'chave é Buffer');
  console.log('ok 0 - tamanhos de salt e chave');
}

// 1) Round-trip de vários tamanhos: 0, 1 e 1MB bytes
{
  for (const size of [0, 1, 1024 * 1024]) {
    const plain = crypto.randomBytes(size);
    const frame = encrypt(plain, key);
    // frame = iv(12) + tag(16) + ct(size)
    assert.equal(frame.length, 12 + 16 + size, `frame tem overhead 28 (size=${size})`);
    const back = decrypt(frame, key);
    assert.ok(back.equals(plain), `round-trip preserva conteúdo (size=${size})`);
  }
  console.log('ok 1 - round-trip 0 / 1 / 1MB bytes');
}

// 2) decrypt com chave errada LANÇA
{
  const plain = Buffer.from('mensagem confidencial');
  const frame = encrypt(plain, key);
  const wrongKey = deriveKey('senha-errada', salt);
  assert.throws(() => decrypt(frame, wrongKey), 'chave errada deve lançar');
  console.log('ok 2 - decrypt com chave errada lança');
}

// 3) Frame adulterado (flip de 1 byte no ciphertext) LANÇA
{
  const plain = Buffer.from('dados que serão adulterados no fio');
  const frame = encrypt(plain, key);
  const tampered = Buffer.from(frame);
  // último byte está dentro do ciphertext (após iv+tag = 28)
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => decrypt(tampered, key), 'ct adulterado deve lançar');
  console.log('ok 3 - frame adulterado lança');
}

// 4) Dois encrypts do mesmo texto produzem frames diferentes (IV aleatório)
{
  const plain = Buffer.from('texto idêntico');
  const a = encrypt(plain, key);
  const b = encrypt(plain, key);
  assert.ok(!a.equals(b), 'IV aleatório torna os frames distintos');
  // mas ambos decifram para o mesmo texto
  assert.ok(decrypt(a, key).equals(plain), 'a decifra ok');
  assert.ok(decrypt(b, key).equals(plain), 'b decifra ok');
  console.log('ok 4 - IV aleatório: frames distintos');
}

console.log('\nALL PASS');
