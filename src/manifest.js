// Constrói e compara manifestos de uma pasta.
// Manifesto = { relPath: { hash, size, mtimeMs } } com relPath usando '/'.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIgnored } from './ignore.js';

export function toRel(dir, abs) {
  return path.relative(dir, abs).split(path.sep).join('/');
}

export function toAbs(dir, rel) {
  return path.join(dir, rel.split('/').join(path.sep));
}

export async function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Varre a pasta recursivamente, respeitando os ignores, e devolve o manifesto.
//
// Algoritmo rápido (estilo git/rsync): em vez de rehashear tudo, faz só um
// `stat` (barato) em cada arquivo. Se o tamanho E o mtime batem com o manifesto
// anterior (opts.prev, vindo do cache em disco), reaproveita o hash salvo. Só
// recalcula o SHA-256 de arquivos novos ou que realmente mudaram.
//
// opts.checksum = true força rehashear tudo (modo paranoico, ignora o cache).
export async function buildManifest(dir, ig, opts = {}) {
  const prev = opts.prev || {};
  const checksum = !!opts.checksum;
  const log = opts.log || (() => {});
  const out = {};
  let reused = 0;
  let hashed = 0;

  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = toRel(dir, abs);
      // Symlinks são ignorados por segurança/simplicidade nesta versão.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isIgnored(ig, rel + '/') || isIgnored(ig, rel)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        if (isIgnored(ig, rel)) continue;
        try {
          const stat = await fsp.stat(abs);
          const mtimeMs = Math.floor(stat.mtimeMs);
          const cached = prev[rel];
          if (!checksum && cached && cached.size === stat.size && cached.mtimeMs === mtimeMs) {
            // Inalterado segundo tamanho+mtime: reaproveita o hash do cache.
            out[rel] = { hash: cached.hash, size: stat.size, mtimeMs };
            reused++;
          } else {
            // Novo ou modificado: o hash garante o conteúdo de fato.
            out[rel] = { hash: await hashFile(abs), size: stat.size, mtimeMs };
            hashed++;
          }
        } catch {
          // Arquivo sumiu durante a varredura: ignora.
        }
      }
    }
  }

  await walk(dir);
  if (reused || hashed) log(`manifesto: ${hashed} arquivo(s) hasheado(s), ${reused} reaproveitado(s) do cache`);
  return out;
}

// Reconcilia os dois lados (local x peer), considerando arquivos vivos e
// tombstones (deleções), e produz o plano de ações deste lado.
//
// Tudo é comparado no RELÓGIO LOCAL. Os timestamps do peer chegam no relógio
// do peer; offset = (relógio do peer) - (relógio local). Para trazer um valor
// do peer ao relógio local: localValue = peerValue - offset.
//
// Retorna { send, deleteLocal, sendDelete }, listas mutuamente exclusivas por
// rel. opts.offset default 0 reproduz o comportamento sem skew.
export function reconcilePlan(local, localTomb, peer, peerTomb, opts = {}) {
  const offset = opts.offset || 0;
  const isHost = !!opts.isHost;

  const send = [];
  const deleteLocal = [];
  const sendDelete = [];

  const rels = new Set([
    ...Object.keys(local),
    ...Object.keys(localTomb),
    ...Object.keys(peer),
    ...Object.keys(peerTomb),
  ]);

  for (const rel of rels) {
    const localAlive = local[rel];
    const peerAlive = peer[rel];

    const la = localAlive ? localAlive.mtimeMs : undefined;
    const ld = localTomb[rel];
    const pa = peerAlive ? peerAlive.mtimeMs - offset : undefined;
    const pd = peerTomb[rel] !== undefined ? peerTomb[rel] - offset : undefined;
    const sameHash = localAlive && peerAlive && localAlive.hash === peerAlive.hash;

    if (localAlive) {
      if (peerAlive) {
        // 1. local vivo & peer vivo
        if (sameHash) {
          // nada
        } else if (la > pa) {
          send.push(rel);
        } else if (la < pa) {
          // nada
        } else {
          // empate de mtime
          if (isHost) send.push(rel);
        }
      } else if (pd !== undefined) {
        // 2. local vivo & peer deletado
        if (la > pd) send.push(rel); // edição venceu o delete
        else deleteLocal.push(rel);
      } else {
        // 3. local vivo & peer totalmente ausente
        send.push(rel);
      }
    } else if (ld !== undefined) {
      // local deletado
      if (peerAlive) {
        // 4. local deletado & peer vivo
        if (ld > pa) sendDelete.push(rel);
        // senão nada (peer reenvia)
      }
      // 5. local deletado & peer deletado: nada
      // 6. local deletado & peer ausente: nada
    }
    // 7. local ausente & peer vivo: nada (peer envia)
    // 8. local ausente & peer deletado: nada
  }

  return { send, deleteLocal, sendDelete };
}
