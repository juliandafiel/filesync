// Anti-eco centralizado: quando aplicamos no disco uma mudança que VEIO do peer,
// o chokidar dispara um evento local (add/unlink/addDir/unlinkDir) que NÃO deve
// ser re-propagado — senão vira loop infinito de eco entre os dois lados.
//
// Este módulo concentra as três frentes de supressão que antes viviam soltas no
// SyncEngine:
//   - suppressAdd:   Map<rel, Set<hash>> — escritas de arquivo esperadas do peer.
//   - suppressDir*:  Set<rel> — mkdir/rmdir esperados do peer (expiram em 10s).
//   - DeleteSuppressor (reusado de suppress.js) — deleções de arquivo, com
//     CONTADOR 1-para-1 (necessário p/ delete+recriação rápida do mesmo caminho).
//
// CRÍTICO p/ testes determinísticos: o agendador de timer é INJETÁVEL
// (opts.setTimer). Assim os testes controlam o tempo sem sleeps reais. O default
// usa setTimeout com .unref() para não segurar o event loop ao encerrar.
import { DeleteSuppressor } from './suppress.js';

// Timer padrão: setTimeout com unref() (não impede o processo de sair).
function defaultTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

export class EchoSuppressor {
  // opts.setTimer: (fn, ms) => handle — agendador injetável (default: setTimeout+unref).
  // opts.dirTtlMs: janela de supressão de mkdir/rmdir (default 10s, igual ao original).
  // opts.addTtlMs: janela da rede de segurança do clearSuppressLater (default 10s).
  constructor(opts = {}) {
    this.setTimer = opts.setTimer || defaultTimer;
    this.dirTtlMs = opts.dirTtlMs ?? 10000;
    this.addTtlMs = opts.addTtlMs ?? 10000;
    // Anti-eco de arquivos: rel -> Set(hashes esperados de escritas vindas do peer).
    this.suppressAdd = new Map();
    // Deleções: contador 1-para-1 (ver suppress.js). O DeleteSuppressor usa o
    // próprio setTimeout+unref interno; aqui só repassamos o TTL (default 10s).
    this.suppressDelete = new DeleteSuppressor(this.dirTtlMs);
    // Anti-eco de diretórios.
    this.suppressDirAdd = new Set();
    this.suppressDirDel = new Set();
  }

  // ---- Escritas de arquivo (add/change) ----

  // Registra que uma escrita com este hash virá do peer. SEM timeout aqui: uma
  // transferência grande pode demorar, e expirar no meio causaria loop de eco.
  // O timeout de segurança é armado só quando o arquivo aterrissa (rename) via
  // clearSuppressLater.
  expectWrite(rel, hash) {
    if (!this.suppressAdd.has(rel)) this.suppressAdd.set(rel, new Set());
    this.suppressAdd.get(rel).add(hash);
  }

  // Consome o eco de uma escrita esperada. Retorna true se este (rel, hash) era
  // esperado (e então o evento do watcher deve ser ignorado). Limpa a entrada
  // INTEIRA do rel: o awaitWriteFinish coalesce escritas e só entrega o estado
  // final, então hashes intermediários nunca disparariam evento.
  consumeEcho(rel, hash) {
    const expected = this.suppressAdd.get(rel);
    if (expected && expected.has(hash)) {
      this.suppressAdd.delete(rel);
      return true;
    }
    return false;
  }

  // Libera a supressão de um eco que não virá (ex: recebimento rejeitado).
  cancelWrite(rel) {
    this.suppressAdd.delete(rel);
  }

  clearSuppressLater(rel, hash) {
    // Rede de segurança: se o watcher nunca disparar (ex: conteúdo idêntico),
    // limpa após addTtlMs contados do momento em que o arquivo já está no disco.
    this.setTimer(() => {
      const set = this.suppressAdd.get(rel);
      if (set) { set.delete(hash); if (set.size === 0) this.suppressAdd.delete(rel); }
    }, this.addTtlMs);
  }

  // ---- Deleções de arquivo (delega ao DeleteSuppressor) ----

  expectDelete(rel) { this.suppressDelete.expect(rel); }
  consumeDelete(rel) { return this.suppressDelete.consume(rel); }

  // ---- Diretórios (mkdir/rmdir) ----

  // Espera o eco de um mkdir aplicado por ordem do peer; expira em dirTtlMs.
  expectDirAdd(rel) {
    this.suppressDirAdd.add(rel);
    this.setTimer(() => this.suppressDirAdd.delete(rel), this.dirTtlMs);
  }

  // Consome o eco do addDir; true = é eco (ignore), false = mkdir local real.
  consumeDirAdd(rel) {
    if (this.suppressDirAdd.has(rel)) { this.suppressDirAdd.delete(rel); return true; }
    return false;
  }

  // Espera o eco de um rmdir aplicado por ordem do peer; expira em dirTtlMs.
  expectDirDel(rel) {
    this.suppressDirDel.add(rel);
    this.setTimer(() => this.suppressDirDel.delete(rel), this.dirTtlMs);
  }

  // Consome o eco do unlinkDir; true = é eco (ignore), false = rmdir local real.
  consumeDirDel(rel) {
    if (this.suppressDirDel.has(rel)) { this.suppressDirDel.delete(rel); return true; }
    return false;
  }

  // Cancela todos os timers de deleção pendentes (chamado ao encerrar).
  clear() {
    this.suppressDelete.clear();
  }
}
