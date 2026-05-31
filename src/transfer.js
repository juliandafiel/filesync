// Envio e recebimento de arquivos em chunks sobre o WebSocket.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CHUNK_SIZE } from './config.js';
import { MSG, encodeChunk, decodeChunk } from './protocol.js';
import { TEMP_SUFFIX } from './ignore.js';
import { hasFreeSpace } from './diskspace.js';
import { moveToTrash } from './trash.js';

let nextTransferId = 1;
export function newTransferId() {
  // uint32; volta a 1 ao estourar.
  nextTransferId = nextTransferId >= 0xffffffff ? 1 : nextTransferId + 1;
  return nextTransferId;
}

// Espera o buffer do socket esvaziar para respeitar backpressure no ENVIO.
// Rejeita se o socket fechar ou se travar por muito tempo (peer morto).
function waitDrain(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== ws.OPEN) return reject(new Error('socket fechado'));
    if (ws.bufferedAmount < 1024 * 1024) return resolve();
    let waited = 0;
    const timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) { clearInterval(timer); return reject(new Error('socket fechado')); }
      if (ws.bufferedAmount < 256 * 1024) { clearInterval(timer); return resolve(); }
      waited += 20;
      if (waited > 60000) { clearInterval(timer); return reject(new Error('timeout de backpressure')); }
    }, 20);
  });
}

// Envia um arquivo: file-begin (JSON) -> chunks binários -> file-end (JSON).
export async function sendFile(ws, absPath, rel, meta) {
  const transferId = newTransferId();
  ws.send(JSON.stringify({
    type: MSG.FILE_BEGIN,
    transferId,
    rel,
    hash: meta.hash,
    size: meta.size,
    mtimeMs: meta.mtimeMs,
  }));

  // for-await trata backpressure de leitura naturalmente e propaga exceções
  // (nada de handler async em 'data' que viraria unhandled rejection).
  const stream = fs.createReadStream(absPath, { highWaterMark: CHUNK_SIZE });
  try {
    for await (const chunk of stream) {
      if (ws.readyState !== ws.OPEN) throw new Error('socket fechado durante envio');
      ws.send(encodeChunk(transferId, chunk));
      await waitDrain(ws);
    }
  } finally {
    stream.destroy();
  }

  ws.send(JSON.stringify({ type: MSG.FILE_END, transferId }));
}

// Recebe transferências. O processamento de mensagens é SERIALIZADO por quem
// chama (sync-engine usa uma fila), então begin() sempre roda antes dos chunks.
// Validamos hash + tamanho antes de promover o arquivo (garantia de integridade)
// e tratamos erros/backpressure de escrita.
export class TransferReceiver {
  constructor(dir, { onComplete, onReject, log } = {}) {
    this.dir = dir;
    this.onComplete = onComplete; // (rel, meta) => void  (após gravar e validar)
    this.onReject = onReject;     // (rel, motivo) => void
    this.log = log || (() => {});
    this.active = new Map(); // transferId -> { rel, meta, tmpAbs, destAbs, stream, hash, bytes, error }
  }

  async begin(msg) {
    const destAbs = path.join(this.dir, msg.rel.split('/').join(path.sep));
    const tmpAbs = destAbs + '.' + msg.transferId + TEMP_SUFFIX;
    // transferId reutilizado/colidido: limpa a transferência anterior para não
    // vazar o WriteStream e o .tmp órfão.
    const old = this.active.get(msg.transferId);
    if (old) {
      if (old.stream) old.stream.destroy();
      await fsp.rm(old.tmpAbs, { force: true }).catch(() => {});
      this.active.delete(msg.transferId);
    }

    // Espaço em disco insuficiente: registra a transferência em modo "skip"
    // (absorve os chunks sem gravar) e rejeita no fim, mantendo o protocolo em
    // sincronia em vez de descartar chunks silenciosamente.
    if (!(await hasFreeSpace(this.dir, msg.size || 0))) {
      this.log(`sem espaço em disco para ${msg.rel} (${msg.size} bytes) — recusado`);
      this.active.set(msg.transferId, {
        rel: msg.rel, skip: true, stream: null, tmpAbs, bytes: 0,
      });
      return;
    }

    await fsp.mkdir(path.dirname(destAbs), { recursive: true });
    const stream = fs.createWriteStream(tmpAbs);
    const entry = {
      rel: msg.rel,
      meta: { hash: msg.hash, size: msg.size, mtimeMs: msg.mtimeMs },
      tmpAbs,
      destAbs,
      stream,
      hash: crypto.createHash('sha256'),
      bytes: 0,
      error: null,
    };
    stream.on('error', (e) => { entry.error = e; });
    this.active.set(msg.transferId, entry);
  }

  // Devolve uma Promise quando precisa aplicar backpressure (write retornou false).
  chunk(buf) {
    const { transferId, data } = decodeChunk(buf);
    const t = this.active.get(transferId);
    if (!t) {
      // Com o processamento serializado isto não deve acontecer; logamos.
      this.log(`chunk órfão (transferId ${transferId}) descartado`);
      return;
    }
    if (t.skip) { t.bytes += data.length; return; } // sem espaço: só absorve
    if (t.error) return;
    t.hash.update(data);
    t.bytes += data.length;
    // Progresso para arquivos grandes (a cada 25%).
    if (t.meta.size >= 4 * 1024 * 1024) {
      const step = Math.floor((t.bytes / t.meta.size) * 4);
      if (step > (t.lastStep || 0)) {
        t.lastStep = step;
        this.log(`recebendo ${t.rel}: ${Math.min(100, step * 25)}%`);
      }
    }
    if (!t.stream.write(data)) {
      return new Promise((resolve) => t.stream.once('drain', resolve));
    }
  }

  async end(transferId) {
    const t = this.active.get(transferId);
    if (!t) return null;
    this.active.delete(transferId);

    // Transferência recusada por falta de espaço: nada gravado.
    if (t.skip) {
      if (this.onReject) this.onReject(t.rel, 'sem espaço em disco');
      return null;
    }

    await new Promise((resolve) => t.stream.end(resolve));

    // Falha de escrita em disco: descarta, não promove.
    if (t.error) {
      await fsp.rm(t.tmpAbs, { force: true }).catch(() => {});
      this.log(`erro ao gravar ${t.rel}: ${t.error.message}`);
      if (this.onReject) this.onReject(t.rel, 'erro de escrita');
      return null;
    }

    // GARANTIA DE INTEGRIDADE: o conteúdo recebido tem que bater com o hash e o
    // tamanho anunciados. Se não bater (truncado, corrompido, modificado durante
    // o envio), descarta sem promover — nada de arquivo corrompido vira válido.
    const digest = t.hash.digest('hex');
    if (digest !== t.meta.hash || t.bytes !== t.meta.size) {
      await fsp.rm(t.tmpAbs, { force: true }).catch(() => {});
      this.log(`integridade falhou em ${t.rel} (hash/tamanho não conferem) — descartado`);
      if (this.onReject) this.onReject(t.rel, 'hash/tamanho divergente');
      return null;
    }

    // "Mais recente vence" também na escrita: se o arquivo no destino já é mais
    // novo que o recebido (ex: chunks/eventos fora de ordem, ou edição local no
    // meio), não sobrescreve com uma versão mais antiga.
    try {
      const cur = await fsp.stat(t.destAbs);
      if (Math.floor(cur.mtimeMs) > t.meta.mtimeMs) {
        await fsp.rm(t.tmpAbs, { force: true }).catch(() => {});
        this.log(`mantido ${t.rel}: versão local é mais recente`);
        return null;
      }
    } catch { /* destino não existe: pode gravar */ }

    // Antes de sobrescrever, manda a versão atual do destino para a lixeira
    // (recuperação). moveToTrash é no-op se o arquivo ainda não existe.
    await moveToTrash(this.dir, t.rel).catch(() => {});

    try {
      await fsp.rename(t.tmpAbs, t.destAbs);
    } catch (e) {
      await fsp.rm(t.tmpAbs, { force: true }).catch(() => {});
      this.log(`falha ao finalizar ${t.rel}: ${e.message}`);
      return null;
    }
    // Preserva o mtime para a regra "mais recente vence" fazer sentido.
    const mtime = new Date(t.meta.mtimeMs);
    await fsp.utimes(t.destAbs, mtime, mtime).catch(() => {});
    if (this.onComplete) this.onComplete(t.rel, t.meta);
    return t.rel;
  }

  // Limpa transferências incompletas (ex: conexão caiu no meio).
  async cleanup() {
    for (const [, t] of this.active) {
      if (t.stream) t.stream.destroy();
      await fsp.rm(t.tmpAbs, { force: true }).catch(() => {});
    }
    this.active.clear();
  }
}
