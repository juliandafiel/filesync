// Utilidades de path para sync cross-OS: normalização Unicode e maiúsculas.
// macOS guarda nomes em NFD, Linux/Windows costumam usar NFC; além disso
// alguns FS são case-insensitive. Normalizamos para evitar duplicatas falsas
// e detectamos colisões de maiúsculas/minúsculas antes que virem problema.

// Normaliza o rel para a forma canônica NFC (mesma sequência de bytes Unicode).
export function normalizeRel(rel) {
  return rel.normalize('NFC');
}

// Chave para comparação case-insensitive: NFC + minúsculas.
export function caseKey(rel) {
  return normalizeRel(rel).toLowerCase();
}

// Acha grupos de rels do manifesto que colidem pela mesma caseKey.
// manifest = { rel: {...} }. Retorna só grupos com 2+ rels (os únicos são
// ignorados). Cada grupo é a lista dos rels originais que colidem.
export function detectCaseCollisions(manifest) {
  const groups = new Map();
  for (const rel of Object.keys(manifest)) {
    const key = caseKey(rel);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rel);
  }
  const out = [];
  for (const rels of groups.values()) {
    if (rels.length >= 2) out.push(rels);
  }
  return out;
}
