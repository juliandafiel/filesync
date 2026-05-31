// Barreira LEXICA de segurança de caminho: garante que um caminho relativo
// recebido do peer não escapa da pasta raiz. É só a PRIMEIRA barreira — não
// enxerga symlinks (essa parte fica no isSafeTarget do SyncEngine, que resolve
// realpath dos ancestrais). Extraído para ser compartilhado por sync-engine.js,
// dir-sync.js e delta-transport.js sem duplicação.
import path from 'node:path';

// Verifica (apenas lexicamente, via path.resolve) que `rel` aterrissa dentro de
// `dir`. Rejeita strings vazias, com NUL, ou que escapam por '..'.
export function isSafeRel(dir, rel) {
  if (!rel || rel.includes('\0')) return false;
  const abs = path.resolve(dir, rel.split('/').join(path.sep));
  const root = path.resolve(dir);
  return abs === root || abs.startsWith(root + path.sep);
}
