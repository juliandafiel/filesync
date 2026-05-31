// Transporte DELTA (sincronização incremental estilo rsync): envia/recebe só os
// BLOCOS que mudaram, em vez do arquivo inteiro. Concentra os três lados do
// protocolo de delta e o estado das assinaturas pendentes:
//
//   - pushDelta(rel, meta, ws): pede a assinatura do arquivo antigo ao peer
//     (DELTA_REQ), espera o SIG, calcula o diff e envia o DELTA. Retorna false
//     se não compensou / o peer não tinha o arquivo / a conexão caiu — sinal
//     para o chamador cair no envio COMPLETO.
//   - handleDeltaReq(msg): o peer pediu a assinatura do NOSSO arquivo; responde
//     SIG (has:true + assinatura, ou has:false).
//   - applyDelta(msg): recebe um DELTA, reconstrói o arquivo (antigo + ops),
//     valida hash/tamanho e grava de forma atômica.
//   - resolveSig(msg): casa um SIG recebido com a Promise pendente do pushDelta.
//   - pendingSig: Map<transferId, { resolve, timer }> das assinaturas aguardadas.
//
// A DECISÃO de habilitar delta (allowDelta) e o gatilho de pushDelta continuam
// no SyncEngine (pushFile) — aqui só executamos. Isso preserva a proteção
// anti-deadlock: durante a fila serial de mensagens (reconcile / delete-vs-edit)
// o SyncEngine chama com allowDelta:false e nunca entra em pushDelta, evitando
// esperar o SIG dentro da própria fila.
//
// Dependências por INJEÇÃO (mantém testável e desacoplado do SyncEngine):
//   - dir: raiz absoluta;
//   - log: função de log;
//   - getWs(): devolve o ws ATUAL (a conexão pode trocar durante um await);
//   - rejectReason(rel) -> Promise<string|null>: validação de segurança/ignore;
//   - expectWrite(rel, hash): registra o anti-eco da escrita que vamos aplicar;
//   - onRemoteFileWritten(rel, meta): pós-gravação (manifesto, in-sync, etc.);
//   - onWork(): sinaliza "chegou trabalho" (re-anunciar em sincronia depois).
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { MSG } from './protocol.js';
import { toAbs } from './manifest.js';
import { TEMP_SUFFIX } from './ignore.js';
import { moveToTrash } from './trash.js';
import { signature, diff, apply } from './delta.js';
import { newTransferId } from './transfer.js';
import { normalizeRel } from './normalize.js';
import { isSafeRel } from './path-safety.js';

export const DELTA_MIN = 256 * 1024;        // só vale a pena delta acima disto
export const DELTA_MAX = 64 * 1024 * 1024;  // acima disto, transfere cheio (memória)
export const DELTA_BLOCK = 4096;

export class DeltaTransport {
  constructor({ dir, log, getWs, rejectReason, expectWrite, onRemoteFileWritten, onWork }) {
    this.dir = dir;
    this.log = log || (() => {});
    this.getWs = getWs;
    this.rejectReason = rejectReason;
    this.expectWrite = expectWrite;
    this.onRemoteFileWritten = onRemoteFileWritten;
    this.onWork = onWork || (() => {});
    // transferId -> resolver aguardando a assinatura (SIG) do peer.
    this.pendingSig = new Map();
  }

  // Envia só os blocos que mudaram (rsync). Retorna false para cair no envio
  // completo (peer não tem versão antiga, delta não compensou, ou timeout).
  // `ws` é o socket capturado pelo chamador (pushFile) — usado para enviar e
  // para detectar troca de conexão durante os awaits.
  async pushDelta(rel, meta, ws) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    const transferId = newTransferId();
    const sig = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pendingSig.delete(transferId); resolve(null); }, 30000);
      if (timer.unref) timer.unref();
      this.pendingSig.set(transferId, { resolve, timer });
      ws.send(JSON.stringify({ type: MSG.DELTA_REQ, transferId, rel }));
    });
    if (!sig || !sig.sig) return false; // peer não tem o arquivo antigo (ou caiu)
    if (this.getWs() !== ws || ws.readyState !== ws.OPEN) return false; // conexão trocou
    let buf;
    try { buf = await fsp.readFile(toAbs(this.dir, rel)); } catch { return false; }
    const ops = diff(sig.sig, buf, sig.blockSize);
    let literal = 0;
    for (const op of ops) if (op.data) literal += op.data.length;
    if (literal > buf.length * 0.8) return false; // delta não compensa: envia cheio
    const wire = ops.map((op) => (op.data ? { d: op.data.toString('base64') } : { c: op.copy }));
    ws.send(JSON.stringify({
      type: MSG.DELTA, rel, hash: meta.hash, size: meta.size, mtimeMs: meta.mtimeMs,
      blockSize: sig.blockSize, ops: wire,
    }));
    this.log(`delta ${rel}: ${(literal / 1024).toFixed(0)} KB de ${(buf.length / 1024).toFixed(0)} KB`);
    return true;
  }

  // Peer pediu a assinatura do nosso arquivo antigo (para nos mandar um delta).
  async handleDeltaReq(msg) {
    const ws = this.getWs();
    msg.rel = normalizeRel(msg.rel); // chave lógica em NFC (ver manifest.js)
    if (!isSafeRel(this.dir, msg.rel)) { ws.send(JSON.stringify({ type: MSG.SIG, transferId: msg.transferId, has: false })); return; }
    let buf;
    try { buf = await fsp.readFile(toAbs(this.dir, msg.rel)); } catch {
      ws.send(JSON.stringify({ type: MSG.SIG, transferId: msg.transferId, has: false }));
      return;
    }
    const sig = signature(buf, DELTA_BLOCK);
    ws.send(JSON.stringify({ type: MSG.SIG, transferId: msg.transferId, has: true, blockSize: DELTA_BLOCK, sig }));
  }

  // NACK do caminho DELTA: o DELTA não usa o transferId de sendFile, então
  // sinalizamos só por rel (o handler de MSG.NACK no remetente trata rel sem
  // transferId: reverte peerManifest[rel] e reenvia uma vez com allowDelta:false,
  // caindo no envio COMPLETO — que então é confiável). Só envia se o ws estiver
  // aberto (a conexão pode ter trocado durante os awaits do applyDelta).
  nack(rel, reason) {
    const ws = this.getWs();
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: MSG.NACK, rel, reason }));
    }
  }

  // Casa um SIG recebido com a Promise pendente do pushDelta correspondente.
  resolveSig(msg) {
    const p = this.pendingSig.get(msg.transferId);
    if (p) { this.pendingSig.delete(msg.transferId); clearTimeout(p.timer); p.resolve(msg.has ? msg : null); }
  }

  // Recebe um delta: reconstrói o arquivo a partir do antigo + ops e valida hash.
  async applyDelta(msg) {
    msg.rel = normalizeRel(msg.rel); // chave lógica em NFC (ver manifest.js)
    const motivo = await this.rejectReason(msg.rel);
    if (motivo) { this.log(`delta recusado (${motivo}): ${msg.rel}`); this.nack(msg.rel, motivo); return; }
    let oldBuf;
    try { oldBuf = await fsp.readFile(toAbs(this.dir, msg.rel)); } catch { oldBuf = Buffer.alloc(0); }
    const ops = msg.ops.map((o) => (o.d !== undefined ? { data: Buffer.from(o.d, 'base64') } : { copy: o.c }));
    let newBuf;
    try { newBuf = apply(oldBuf, ops, msg.blockSize); } catch (e) { this.log(`delta falhou em ${msg.rel}: ${e.message}`); this.nack(msg.rel, 'delta inválido'); return; }
    // Integridade: o resultado tem que bater com o hash/tamanho anunciados.
    const digest = crypto.createHash('sha256').update(newBuf).digest('hex');
    if (digest !== msg.hash || newBuf.length !== msg.size) {
      this.log(`delta inválido em ${msg.rel} (hash/tamanho) — será re-sincronizado`);
      this.nack(msg.rel, 'delta inválido');
      return;
    }
    this.onWork(); // chegou trabalho: re-anuncia "em sincronia" depois
    this.expectWrite(msg.rel, msg.hash);
    const abs = toAbs(this.dir, msg.rel);
    const tmp = abs + '.delta' + TEMP_SUFFIX;
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(tmp, newBuf);
    await moveToTrash(this.dir, msg.rel).catch(() => {});
    await fsp.rename(tmp, abs);
    const mtime = new Date(msg.mtimeMs);
    await fsp.utimes(abs, mtime, mtime).catch(() => {});
    this.onRemoteFileWritten(msg.rel, { hash: msg.hash, size: msg.size, mtimeMs: msg.mtimeMs });
  }

  // Cancela todas as assinaturas pendentes (chamado no detach): resolve null
  // para destravar pushDelta esperando, e limpa os timers de 30s.
  cancelPending() {
    for (const [, p] of this.pendingSig) { clearTimeout(p.timer); p.resolve(null); }
    this.pendingSig.clear();
  }
}
