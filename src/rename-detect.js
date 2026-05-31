// Detecta renomeações comparando dois manifestos.
// Manifesto = { rel: { hash, size, mtimeMs } }.
//
// Um rename é: 'from' existia no old e sumiu no new; 'to' não existia no old e
// apareceu no new; com hash E size iguais. Pareamento 1-para-1: cada from/to é
// usado no máximo uma vez. Havendo vários candidatos de mesmo hash+size,
// pareia em ordem lexicográfica para resultado determinístico.

export function detectRenames(oldManifest, newManifest) {
  // 'from' = sumiu (estava no old, não está no new).
  // 'to'   = apareceu (está no new, não estava no old).
  const gone = Object.keys(oldManifest).filter((rel) => !(rel in newManifest));
  const fresh = Object.keys(newManifest).filter((rel) => !(rel in oldManifest));

  // Indexa os 'to' por chave hash|size, em ordem lexicográfica.
  const byKey = new Map();
  for (const rel of fresh.sort()) {
    const e = newManifest[rel];
    const k = e.hash + '|' + e.size;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(rel);
  }

  // Percorre os 'from' em ordem lexicográfica e consome um 'to' compatível.
  const renames = [];
  for (const from of gone.sort()) {
    const e = oldManifest[from];
    const k = e.hash + '|' + e.size;
    const candidates = byKey.get(k);
    if (candidates && candidates.length) {
      const to = candidates.shift(); // menor lexicográfico disponível
      renames.push({ from, to });
    }
  }

  return renames;
}
