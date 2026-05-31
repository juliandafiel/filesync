// Criptografia ponta-a-ponta: AES-256-GCM com chave derivada por scrypt.
// Frame no fio = [iv(12)][authTag(16)][ciphertext]. O IV é aleatório por
// frame; a tag GCM autentica o conteúdo (decrypt LANÇA se for adulterado).
import crypto from 'node:crypto';

const IV_LEN = 12; // nonce padrão do GCM (96 bits)
const TAG_LEN = 16; // tag de autenticação GCM (128 bits)

// Deriva uma chave de 32 bytes (AES-256) a partir da passphrase + salt.
export function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32);
}

// Salt aleatório de 16 bytes para a derivação da chave.
export function randomSalt() {
  return crypto.randomBytes(16);
}

// Cifra o buffer e devolve o frame [iv][tag][ct].
export function encrypt(plaintextBuf, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

// Decifra o frame [iv][tag][ct]; LANÇA se a autenticação GCM falhar.
export function decrypt(frameBuf, key) {
  const iv = frameBuf.subarray(0, IV_LEN);
  const tag = frameBuf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = frameBuf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
