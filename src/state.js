// Persiste o estado em disco (.filesync-state.json): o manifesto (CACHE de
// hashes, para reaproveitar hash de arquivos com mesmo tamanho+mtime) E o
// conjunto de tombstones (deleções recentes, para propagar deleções entre
// pares). Tombstones antigos são podados na gravação.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILE } from './ignore.js';

const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 dias

export function loadState(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
    const data = JSON.parse(raw);
    const files = data && typeof data.files === 'object' && data.files ? data.files : {};
    const tombstones =
      data && typeof data.tombstones === 'object' && data.tombstones ? data.tombstones : {};
    return { files, tombstones };
  } catch {
    return { files: {}, tombstones: {} };
  }
}

// Escrita atômica (temp + rename) para nunca deixar o estado corrompido.
// Poda tombstones com deletedAt < now - 30 dias ANTES de gravar.
export function saveState(dir, state, now = Date.now()) {
  const dest = path.join(dir, STATE_FILE);
  const tmp = dest + '.tmp';

  const files = state && typeof state.files === 'object' && state.files ? state.files : {};
  const rawTombstones =
    state && typeof state.tombstones === 'object' && state.tombstones ? state.tombstones : {};

  const cutoff = now - TOMBSTONE_TTL_MS;
  const tombstones = {};
  for (const [relPath, deletedAt] of Object.entries(rawTombstones)) {
    if (deletedAt >= cutoff) tombstones[relPath] = deletedAt;
  }

  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, files, tombstones }));
    fs.renameSync(tmp, dest);
  } catch {
    // Falha ao salvar não é fatal: na próxima vez rehasheia.
  }
}
