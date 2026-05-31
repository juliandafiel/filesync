// Detecção de RENAME ao vivo a partir dos eventos do watcher local.
//
// O chokidar não reporta "rename": ele dispara um unlink (no caminho antigo)
// seguido de um add (no caminho novo). Para não retransferir o conteúdo inteiro,
// adiamos a propagação de cada unlink por uma JANELA curta (800ms); se nesse
// intervalo aparecer um add com o MESMO hash E TAMANHO, tratamos como rename
// (mandamos RENAME ao peer) em vez de delete+add.
//
// Exigir hash E size (não só hash) evita rename espúrio por colisão de hash
// entre arquivos de identidades diferentes — o que engoliria uma deleção real.
//
// Estado: recentUnlinks = Map<rel, { hash, size, timer }>.
//
// CRÍTICO p/ testes determinísticos: o agendador de timer é INJETÁVEL
// (opts.setTimer), permitindo disparar a janela de 800ms sob controle do teste.
const RENAME_WINDOW_MS = 800; // janela para casar unlink+add como rename

function defaultTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

export class LiveRenameDetector {
  // opts.setTimer: (fn, ms) => handle — agendador injetável (default setTimeout+unref).
  // opts.windowMs: janela de detecção (default 800ms, igual ao comportamento original).
  constructor(opts = {}) {
    this.setTimer = opts.setTimer || defaultTimer;
    this.windowMs = opts.windowMs ?? RENAME_WINDOW_MS;
    this.recentUnlinks = new Map();
  }

  // Registra um unlink recente que PODE ser a primeira metade de um rename.
  // onFinalize(rel) é chamado quando a janela vence sem nenhum add casando —
  // ou seja, foi mesmo uma deleção. O cancelamento da janela (por match ou por
  // reaparição no mesmo caminho) impede que onFinalize rode.
  registerUnlink(rel, hash, size, onFinalize) {
    const timer = this.setTimer(() => {
      // Vence a janela: remove a entrada (se ainda for esta) e finaliza a deleção.
      const ent = this.recentUnlinks.get(rel);
      if (ent && ent.timer === timer) this.recentUnlinks.delete(rel);
      onFinalize(rel);
    }, this.windowMs);
    this.recentUnlinks.set(rel, { hash, size, timer });
  }

  // Tenta casar um add (rel/hash/size) com algum unlink recente: casamento por
  // hash E size, 1-para-1. Retorna o caminho ANTIGO (oldRel) se casou — e remove
  // a entrada, cancelando sua finalização — ou null se não houve rename.
  tryMatch(rel, hash, size) {
    for (const [oldRel, ent] of this.recentUnlinks) {
      if (ent.hash === hash && ent.size === size) {
        clearTimeout(ent.timer);
        this.recentUnlinks.delete(oldRel);
        return oldRel;
      }
    }
    return null;
  }

  // Reaparição no MESMO caminho: cancela a deleção adiada (era um modify, não um
  // delete) para o onFinalize não apagar o arquivo recriado. Retorna true se
  // havia uma deleção pendente nesse caminho.
  cancelPending(rel) {
    const ent = this.recentUnlinks.get(rel);
    if (ent) {
      clearTimeout(ent.timer);
      this.recentUnlinks.delete(rel);
      return true;
    }
    return false;
  }

  // Cancela todos os timers pendentes e esvazia o estado (chamado ao encerrar).
  clear() {
    for (const [, ent] of this.recentUnlinks) clearTimeout(ent.timer);
    this.recentUnlinks.clear();
  }
}
