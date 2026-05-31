// Constantes, geração de token e helpers de link.
import crypto from 'node:crypto';

export const DEFAULT_PORT = 4000;
export const CHUNK_SIZE = 256 * 1024; // 256 KB por chunk

export function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Monta o link humano a partir da URL pública do túnel, do token (gateia a
// conexão) e da passphrase de criptografia (k). Ambos ficam no FRAGMENTO (#),
// que nunca é enviado ao servidor/túnel — então o túnel não vê a passphrase.
// Ex: https://abc.loca.lt#t=token&k=key
export function buildLink(publicUrl, token, key) {
  const clean = publicUrl.replace(/\/+$/, '');
  return `${clean}#t=${token}&k=${key}`;
}

// Faz o caminho inverso: extrai a URL de WebSocket (wss/ws), o token e a key.
export function parseLink(link) {
  let token = null;
  let key = null;
  let base = link.trim();
  const hashIdx = base.indexOf('#');
  if (hashIdx !== -1) {
    const frag = base.slice(hashIdx + 1);
    base = base.slice(0, hashIdx);
    const mt = frag.match(/(?:^|&)t=([^&]+)/);
    if (mt) token = decodeURIComponent(mt[1]);
    const mk = frag.match(/(?:^|&)k=([^&]+)/);
    if (mk) key = decodeURIComponent(mk[1]);
  }
  base = base.replace(/\/+$/, '');
  let wsUrl;
  if (base.startsWith('https://')) wsUrl = 'wss://' + base.slice('https://'.length);
  else if (base.startsWith('http://')) wsUrl = 'ws://' + base.slice('http://'.length);
  else if (base.startsWith('wss://') || base.startsWith('ws://')) wsUrl = base;
  else wsUrl = 'ws://' + base; // ex: host:porta cru
  return { wsUrl, token, key };
}
