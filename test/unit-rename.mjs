// Testes de detectRenames.
import assert from 'node:assert/strict';
import { detectRenames } from '../src/rename-detect.js';

function eq(actual, expected, msg) {
  assert.deepEqual(actual, expected, msg);
}

// 1. Rename simples detectado.
{
  const oldM = { 'a.txt': { hash: 'h1', size: 10, mtimeMs: 1 } };
  const newM = { 'b.txt': { hash: 'h1', size: 10, mtimeMs: 1 } };
  eq(detectRenames(oldM, newM), [{ from: 'a.txt', to: 'b.txt' }], 'rename simples');
}

// 2. Conteúdo diferente NÃO é rename (hash diferente).
{
  const oldM = { 'a.txt': { hash: 'h1', size: 10, mtimeMs: 1 } };
  const newM = { 'b.txt': { hash: 'h2', size: 10, mtimeMs: 1 } };
  eq(detectRenames(oldM, newM), [], 'hash diferente não é rename');
}

// 2b. Mesmo hash mas size diferente NÃO é rename.
{
  const oldM = { 'a.txt': { hash: 'h1', size: 10, mtimeMs: 1 } };
  const newM = { 'b.txt': { hash: 'h1', size: 20, mtimeMs: 1 } };
  eq(detectRenames(oldM, newM), [], 'size diferente não é rename');
}

// 3. Cópia (from continua existindo) NÃO é rename.
{
  const oldM = { 'a.txt': { hash: 'h1', size: 10, mtimeMs: 1 } };
  const newM = {
    'a.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
    'b.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
  };
  eq(detectRenames(oldM, newM), [], 'cópia não é rename (from ainda existe)');
}

// 4. Múltiplos renames com hashes distintos.
{
  const oldM = {
    'a.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
    'c.txt': { hash: 'h2', size: 20, mtimeMs: 2 },
  };
  const newM = {
    'b.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
    'd.txt': { hash: 'h2', size: 20, mtimeMs: 2 },
  };
  eq(
    detectRenames(oldM, newM),
    [{ from: 'a.txt', to: 'b.txt' }, { from: 'c.txt', to: 'd.txt' }],
    'múltiplos renames hashes distintos',
  );
}

// 5. Dois arquivos de mesmo hash pareados deterministicamente (lexicográfico).
{
  const oldM = {
    'old-z.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
    'old-a.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
  };
  const newM = {
    'new-z.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
    'new-a.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
  };
  // from ordenado: old-a, old-z ; to ordenado: new-a, new-z
  eq(
    detectRenames(oldM, newM),
    [{ from: 'old-a.txt', to: 'new-a.txt' }, { from: 'old-z.txt', to: 'new-z.txt' }],
    'pareamento determinístico por ordem lexicográfica',
  );
}

// 5b. Determinismo: independe da ordem de inserção das chaves.
{
  const oldM = {
    'old-a.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
    'old-z.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
  };
  const newM = {
    'new-z.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
    'new-a.txt': { hash: 'h1', size: 10, mtimeMs: 1 },
  };
  eq(
    detectRenames(oldM, newM),
    [{ from: 'old-a.txt', to: 'new-a.txt' }, { from: 'old-z.txt', to: 'new-z.txt' }],
    'mesmo resultado independente da ordem de inserção',
  );
}

console.log('OK: todos os testes de rename passaram');
