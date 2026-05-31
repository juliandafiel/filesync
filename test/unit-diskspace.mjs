// Teste unitário de diskspace.js
import assert from 'node:assert/strict';
import { freeBytes, hasFreeSpace } from '../src/diskspace.js';

const free = await freeBytes('/tmp');
assert.ok(free > 0, 'freeBytes(/tmp) deve ser > 0');

assert.equal(await hasFreeSpace('/tmp', 0), true, 'hasFreeSpace(/tmp, 0) deve ser true');
assert.equal(await hasFreeSpace('/tmp', Number.MAX_SAFE_INTEGER), false, 'hasFreeSpace(/tmp, MAX) deve ser false');

console.log('OK: unit-diskspace passou');
