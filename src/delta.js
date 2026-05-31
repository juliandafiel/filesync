// Diff estilo rsync com rolling hash: transfere só o que mudou em arquivos grandes.
// signature(old) -> assinatura por bloco; diff(sig, novo) -> ops; apply(old, ops) -> novo.
import crypto from 'node:crypto';

const M = 65521; // módulo do adler32

// Checksum fraco (adler32) de um bloco. Devolve { a, b, weak } para permitir o roll.
function adler32(buf, start, end) {
  let a = 1;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + buf[i]) % M;
    b = (b + a) % M;
  }
  return { a, b, weak: (b << 16) | a };
}

// SHA-1 hex de uma fatia (forte, confirma o match do weak).
function sha1(buf, start, end) {
  return crypto.createHash('sha1').update(buf.subarray(start, end)).digest('hex');
}

// Assinatura do buffer antigo: um descritor por bloco (último pode ser menor).
export function signature(buf, blockSize = 4096) {
  const sig = [];
  for (let off = 0; off < buf.length; off += blockSize) {
    const end = Math.min(off + blockSize, buf.length);
    sig.push({ weak: adler32(buf, off, end).weak, strong: sha1(buf, off, end) });
  }
  return sig;
}

// Gera as ops para reconstruir newBuf a partir dos blocos antigos.
// Janela deslizante: rola o adler32 byte a byte; em batida de weak, confirma com strong.
export function diff(oldSignature, newBuf, blockSize = 4096) {
  // Mapa weak -> lista de índices de bloco (pode haver colisão de weak).
  const byWeak = new Map();
  for (let i = 0; i < oldSignature.length; i++) {
    const w = oldSignature[i].weak;
    if (!byWeak.has(w)) byWeak.set(w, []);
    byWeak.get(w).push(i);
  }

  const ops = [];
  const n = newBuf.length;
  let literalStart = 0; // início do trecho literal pendente
  let i = 0;            // início da janela atual

  // Despeja como {data} os bytes literais acumulados em [literalStart, upto).
  function flushLiteral(upto) {
    if (upto > literalStart) ops.push({ data: Buffer.from(newBuf.subarray(literalStart, upto)) });
  }

  let a = 0;
  let b = 0;
  let winEnd = 0;

  while (i < n) {
    const end = Math.min(i + blockSize, n);
    // (Re)calcula o adler da janela quando não dá pra aproveitar o roll.
    if (winEnd !== end || i === 0) {
      const r = adler32(newBuf, i, end);
      a = r.a;
      b = r.b;
      winEnd = end;
    }
    const weak = (b << 16) | a;

    let matched = -1;
    const cands = byWeak.get(weak);
    if (cands) {
      const strong = sha1(newBuf, i, end);
      for (const idx of cands) {
        if (oldSignature[idx].strong === strong) { matched = idx; break; }
      }
    }

    if (matched >= 0) {
      flushLiteral(i);          // fecha literais antes do match
      ops.push({ copy: matched });
      i = end;                  // pula o bloco inteiro
      literalStart = i;
      winEnd = 0;               // força recálculo na próxima janela
    } else {
      // Sem match: rola a janela 1 byte (remove o da esquerda, adiciona o da direita).
      const next = i + 1;
      const newEnd = Math.min(next + blockSize, n);
      if (newEnd > end && newEnd === next + blockSize) {
        // Roll só vale com janela cheia entrando um byte novo à direita.
        const out = newBuf[i];
        const inc = newBuf[end];
        const len = end - i;
        a = (a - out + inc) % M;
        if (a < 0) a += M;
        b = (b - len * out - 1 + a) % M;
        b = ((b % M) + M) % M;
        winEnd = newEnd;
      } else {
        winEnd = 0; // perto do fim: recalcula do zero na próxima volta
      }
      i = next;
    }
  }

  flushLiteral(n); // literais finais
  return ops;
}

// Reconstrói o buffer: {copy:i} = bloco i do antigo, {data} = bytes literais.
export function apply(oldBuf, ops, blockSize = 4096) {
  const parts = [];
  for (const op of ops) {
    if (op.copy !== undefined) {
      const off = op.copy * blockSize;
      parts.push(oldBuf.subarray(off, Math.min(off + blockSize, oldBuf.length)));
    } else {
      parts.push(op.data);
    }
  }
  return Buffer.concat(parts);
}
