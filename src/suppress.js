// Suprime o "eco" de deleções vindas do watcher local.
//
// Quando aplicamos uma deleção remota no disco, o chokidar dispara um evento
// 'unlink' que NÃO deve ser re-propagado (senão vira loop). Um simples Set
// falharia no caso delete+recriação rápida do MESMO caminho: o segundo unlink
// (real, gerado pelo usuário) seria engolido indevidamente. Por isso usamos um
// CONTADOR por caminho: cada deleção remota aplicada chama expect() e cada
// unlink observado chama consume(), casando 1-para-1.
export class DeleteSuppressor {
  constructor(ttlMs = 10000) {
    this.ttlMs = ttlMs;
    // Map<rel, number>: quantos unlinks ainda esperamos suprimir para esse rel.
    this.counts = new Map();
    // Rastreamos todos os timers pendentes para poder cancelá-los em clear().
    this.timers = new Set();
  }

  // Registra que 1 unlink do watcher virá por causa de um delete remoto:
  // incrementa o contador de `rel` e agenda exatamente um decremento após ttlMs
  // (caso o unlink esperado nunca chegue, evitamos vazar a expectativa).
  expect(rel) {
    this.counts.set(rel, (this.counts.get(rel) || 0) + 1);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this._decrement(rel);
    }, this.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.add(timer);
  }

  // Chamado no evento unlink: se há expectativa pendente (contador > 0),
  // decrementa (true = suprima esse unlink); senão retorna false (unlink real).
  consume(rel) {
    const n = this.counts.get(rel) || 0;
    if (n > 0) {
      this._decrement(rel);
      return true;
    }
    return false;
  }

  // Zera todos os contadores e cancela todos os timers pendentes para que o
  // processo possa encerrar sem timers órfãos.
  clear() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.counts.clear();
  }

  _decrement(rel) {
    const n = this.counts.get(rel) || 0;
    if (n <= 1) {
      this.counts.delete(rel);
    } else {
      this.counts.set(rel, n - 1);
    }
  }
}
