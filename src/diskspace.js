// Checagem de espaço livre em disco no caminho de destino.
import fsp from 'node:fs/promises';

// Bytes livres disponíveis para usuário comum no filesystem de targetPath.
export async function freeBytes(targetPath) {
  const stats = await fsp.statfs(targetPath);
  return stats.bavail * stats.bsize;
}

// Verifica se há espaço para bytesNeeded mantendo uma margem de folga.
export async function hasFreeSpace(targetPath, bytesNeeded, marginBytes = 50 * 1024 * 1024) {
  const free = await freeBytes(targetPath);
  return free >= bytesNeeded + marginBytes;
}
