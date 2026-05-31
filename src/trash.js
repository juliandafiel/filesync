// Lixeira local: guarda versões sobrescritas/deletadas para não perder dados.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const TRASH_DIR = '.filesync-trash';

// Move <rootDir>/<rel> para <rootDir>/.filesync-trash/<now>/<rel>.
// Retorna o caminho destino, ou null se a origem não existe.
export async function moveToTrash(rootDir, rel, now = Date.now()) {
  const relParts = rel.split('/');
  const src = path.join(rootDir, ...relParts);

  // Se a origem não existe, nada a fazer.
  try {
    await fsp.access(src);
  } catch {
    return null;
  }

  const dest = path.join(rootDir, TRASH_DIR, String(now), ...relParts);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  try {
    await fsp.rename(src, dest);
  } catch (err) {
    // Cross-device: cai para copiar + apagar.
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    } else {
      throw err;
    }
  }
  return dest;
}

// Remove subpastas de timestamp cujo nome (número) < now - ttlMs.
export async function pruneTrash(rootDir, now = Date.now(), ttlMs = 30 * 24 * 3600 * 1000) {
  const base = path.join(rootDir, TRASH_DIR);
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return; // sem lixeira ainda
  }
  const cutoff = now - ttlMs;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const ts = Number(e.name);
    if (Number.isFinite(ts) && ts < cutoff) {
      await fsp.rm(path.join(base, e.name), { recursive: true, force: true });
    }
  }
}
