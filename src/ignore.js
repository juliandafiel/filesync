// Monta um matcher estilo .gitignore a partir do arquivo .syncignore da pasta,
// somado a padrões sempre ignorados (internos do app).
import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

export const STATE_FILE = '.filesync-state.json';
export const SYNCIGNORE_FILE = '.syncignore';
export const TEMP_SUFFIX = '.filesync-tmp';

// Padrões que nunca são sincronizados, independente do .syncignore.
const ALWAYS_IGNORE = [
  '.git/',
  STATE_FILE,
  SYNCIGNORE_FILE,
  '.filesync-trash/',   // lixeira local (recuperação de versões sobrescritas/apagadas)
  '.filesync-id.json',  // identidade/token estável da pasta
  `*${TEMP_SUFFIX}`,
];

export function loadIgnore(dir) {
  const ig = ignore();

  // Primeiro os padrões do usuário...
  const file = path.join(dir, SYNCIGNORE_FILE);
  try {
    ig.add(fs.readFileSync(file, 'utf8'));
  } catch {
    // Sem .syncignore: tudo bem, usamos só os defaults.
  }

  // ...e ALWAYS_IGNORE por ÚLTIMO, para que tenha precedência (última regra
  // vence). Assim o usuário não consegue desfazer com '!.git' etc.
  ig.add(ALWAYS_IGNORE);
  return ig;
}

// Recebe um caminho relativo (com separadores '/') e diz se deve ser ignorado.
// 'ignore' lança se receber string vazia (a própria raiz), então protegemos.
export function isIgnored(ig, relPath) {
  if (!relPath || relPath === '.') return false;
  return ig.ignores(relPath);
}
