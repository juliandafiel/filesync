// Teste da lixeira local (trash.js).
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRASH_DIR, moveToTrash, pruneTrash } from '../src/trash.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'filesync-trash-'));

try {
  // 1) moveToTrash move o arquivo, retorna destino e a origem some.
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'sub', 'a.txt'), 'conteudo');
  const now = 1000000;
  const dest = await moveToTrash(root, 'sub/a.txt', now);

  const expected = path.join(root, TRASH_DIR, String(now), 'sub', 'a.txt');
  assert.strictEqual(dest, expected, 'destino esperado');
  assert.strictEqual(fs.existsSync(dest), true, 'arquivo presente na lixeira');
  assert.strictEqual(await fsp.readFile(dest, 'utf8'), 'conteudo', 'conteudo preservado');
  assert.strictEqual(fs.existsSync(path.join(root, 'sub', 'a.txt')), false, 'origem removida');

  // 2) moveToTrash de inexistente retorna null.
  const r = await moveToTrash(root, 'nao/existe.txt', now);
  assert.strictEqual(r, null, 'inexistente retorna null');

  // 3) pruneTrash remove timestamp antigo e mantem recente.
  const nowRef = Date.now();
  const ttl = 30 * 24 * 3600 * 1000;
  const oldTs = nowRef - ttl - 5000;   // alem do ttl -> removido
  const newTs = nowRef - 1000;         // dentro do ttl -> mantido
  await fsp.mkdir(path.join(root, TRASH_DIR, String(oldTs)), { recursive: true });
  await fsp.mkdir(path.join(root, TRASH_DIR, String(newTs)), { recursive: true });

  await pruneTrash(root, nowRef, ttl);
  assert.strictEqual(fs.existsSync(path.join(root, TRASH_DIR, String(oldTs))), false, 'antigo removido');
  assert.strictEqual(fs.existsSync(path.join(root, TRASH_DIR, String(newTs))), true, 'recente mantido');

  console.log('OK: todos os testes de trash passaram');
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
