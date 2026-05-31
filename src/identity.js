// Identidade ESTÁVEL por pasta (.filesync-id.json): token + key gerados uma vez
// e persistidos, para que o link seja reaproveitável entre reinícios.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const IDENTITY_FILE = '.filesync-id.json';

// Gera token e key novos (24 bytes aleatórios cada, em base64url).
function gen() {
  return {
    token: crypto.randomBytes(24).toString('base64url'),
    key: crypto.randomBytes(24).toString('base64url'),
  };
}

// Escrita atômica (temp + rename) para nunca deixar a identidade corrompida.
function persist(dir, identity) {
  const dest = path.join(dir, IDENTITY_FILE);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...identity }));
  fs.renameSync(tmp, dest);
}

// Lê <dir>/.filesync-id.json; se válido, devolve {token,key}. Ausente ou
// corrompido -> gera, grava atomicamente e devolve.
export function loadOrCreateIdentity(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, IDENTITY_FILE), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.token === 'string' && data.token && typeof data.key === 'string' && data.key) {
      return { token: data.token, key: data.key };
    }
  } catch {
    // Ausente ou ilegível -> cai para regeneração abaixo.
  }
  const identity = gen();
  persist(dir, identity);
  return identity;
}
