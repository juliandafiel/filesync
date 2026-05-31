import assert from 'node:assert/strict';
import { normalizeRel, caseKey, detectCaseCollisions } from '../src/normalize.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// 1) NFC e NFD do mesmo acentuado viram strings iguais apos normalizeRel.
{
  const nfc = 'é.txt';        // é pre-composto (NFC)
  const nfd = 'é.txt';       // e + acento combinante (NFD)
  assert.notEqual(nfc, nfd, 'pre-condicao: NFC e NFD diferem como bytes');
  assert.equal(normalizeRel(nfc), normalizeRel(nfd), 'NFC == NFD apos normalizeRel');
  ok('normalizeRel iguala NFC e NFD');
}

// 2) caseKey iguala 'Foo.TXT' e 'foo.txt'.
{
  assert.equal(caseKey('Foo.TXT'), caseKey('foo.txt'), 'caseKey ignora maiusculas');
  ok('caseKey iguala Foo.TXT e foo.txt');
}

// 3) detectCaseCollisions acha o grupo e ignora arquivos unicos.
{
  const manifest = {
    'A.txt': { hash: '1' },
    'a.txt': { hash: '2' },
    'unico.txt': { hash: '3' },
  };
  const groups = detectCaseCollisions(manifest);
  assert.equal(groups.length, 1, 'apenas um grupo de colisao');
  const g = [...groups[0]].sort();
  assert.deepEqual(g, ['A.txt', 'a.txt'], 'grupo contem A.txt e a.txt');
  ok('detectCaseCollisions acha grupo e ignora unicos');
}

// 4) sem colisoes -> array vazio.
{
  const manifest = { 'a.txt': {}, 'b.txt': {}, 'c/d.txt': {} };
  assert.deepEqual(detectCaseCollisions(manifest), [], 'sem colisoes retorna vazio');
  ok('sem colisoes retorna vazio');
}

console.log(`\n${passed} testes passaram.`);
