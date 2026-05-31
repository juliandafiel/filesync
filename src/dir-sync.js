// Sincronização de DIRETÓRIOS (inclusive pastas vazias, que não aparecem no
// manifesto de arquivos). Concentra:
//   - o conjunto `dirs` (caminhos de pastas conhecidas, em NFC);
//   - a varredura inicial (scanDirs);
//   - a aplicação de mkdir/rmdir LOCAIS (eventos do watcher) com anti-eco e
//     emissão de MKDIR/RMDIR ao peer;
//   - a aplicação de mkdir/rmdir REMOTOS (ordens do peer) com checagem de
//     segurança e anti-eco;
//   - a reconciliação de diretórios na conexão (reconcileDirs).
//
// Dependências por INJEÇÃO (mantém o módulo testável e desacoplado do ws):
//   - dir: raiz absoluta da pasta sincronizada;
//   - ig: matcher de ignore (ignore.js);
//   - echo: EchoSuppressor (anti-eco de mkdir/rmdir);
//   - isSafeTarget(rel) -> Promise<bool>: barreira contra symlink (sync-engine);
//   - send(msg): emite uma mensagem de protocolo (MKDIR/RMDIR) ao peer, se houver;
//   - log: função de log.
//
// O anti-eco de diretórios é DELEGADO ao EchoSuppressor (suppressDirAdd/Del):
// quando aplicamos um mkdir/rmdir por ordem do peer, o watcher dispara um evento
// local que NÃO deve ser re-propagado.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MSG } from './protocol.js';
import { toAbs } from './manifest.js';
import { isIgnored } from './ignore.js';
import { normalizeRel } from './normalize.js';
import { isSafeRel } from './path-safety.js';

export class DirSync {
  constructor({ dir, ig, echo, isSafeTarget, send, log }) {
    this.dir = dir;
    this.ig = ig;
    this.echo = echo;
    this.isSafeTarget = isSafeTarget; // (rel) => Promise<bool>
    this.send = send || (() => {});   // (msgObj) => void
    this.log = log || (() => {});
    this.dirs = new Set();
  }

  // Substitui o conjunto de diretórios conhecidos (usado após a varredura inicial).
  setDirs(dirs) { this.dirs = dirs; }

  // Varre os diretórios (inclusive vazios) respeitando os ignores. Não muta o
  // estado: devolve o Set para o chamador decidir quando adotá-lo (igual ao
  // comportamento original em start()).
  async scanDirs() {
    const out = new Set();
    const walk = async (cur) => {
      let entries;
      try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const abs = path.join(cur, e.name);
        const rel = normalizeRel(path.relative(this.dir, abs).split(path.sep).join('/')); // chave NFC (ver manifest.js)
        if (isIgnored(this.ig, rel + '/') || isIgnored(this.ig, rel)) continue;
        out.add(rel);
        await walk(abs);
      }
    };
    await walk(this.dir);
    return out;
  }

  // ---- Eventos LOCAIS do watcher ----

  onLocalAddDir(absPath) {
    const rel = normalizeRel(path.relative(this.dir, absPath).split(path.sep).join('/')); // chave NFC (ver manifest.js)
    if (!rel) return;
    if (this.echo.consumeDirAdd(rel)) { this.dirs.add(rel); return; }
    this.dirs.add(rel);
    this.send({ type: MSG.MKDIR, rel });
  }

  onLocalRmDir(absPath) {
    const rel = normalizeRel(path.relative(this.dir, absPath).split(path.sep).join('/')); // chave NFC (ver manifest.js)
    if (!rel) return;
    if (this.echo.consumeDirDel(rel)) { this.dirs.delete(rel); return; }
    this.dirs.delete(rel);
    this.send({ type: MSG.RMDIR, rel });
  }

  // ---- Ordens REMOTAS do peer ----

  async applyRemoteMkdir(relRaw) {
    const rel = normalizeRel(relRaw); // chave lógica em NFC (ver manifest.js)
    if (!isSafeRel(this.dir, rel) || isIgnored(this.ig, rel)) return;
    // Recusa se um ancestral existente for symlink p/ fora (ver isSafeTarget).
    if (!(await this.isSafeTarget(rel))) { this.log(`mkdir recusado (caminho inseguro): ${rel}`); return; }
    this.echo.expectDirAdd(rel);
    await fsp.mkdir(toAbs(this.dir, rel), { recursive: true }).catch(() => {});
    this.dirs.add(rel);
  }

  async applyRemoteRmdir(relRaw) {
    const rel = normalizeRel(relRaw); // chave lógica em NFC (ver manifest.js)
    if (!isSafeRel(this.dir, rel)) return;
    // Defesa-em-profundidade: ancestral symlink p/ fora atravessaria o rmdir (ver isSafeTarget).
    if (!(await this.isSafeTarget(rel))) { this.log(`rmdir recusado (caminho inseguro): ${rel}`); return; }
    this.echo.expectDirDel(rel);
    await fsp.rmdir(toAbs(this.dir, rel)).catch(() => {}); // só remove se vazio
    this.dirs.delete(rel);
  }

  async reconcileDirs(peerDirs) {
    for (const raw of peerDirs) {
      const rel = normalizeRel(raw); // chave lógica em NFC (ver manifest.js)
      if (this.dirs.has(rel) || isIgnored(this.ig, rel)) continue;
      // Recusa se um ancestral existente for symlink p/ fora (ver isSafeTarget).
      if (!(await this.isSafeTarget(rel))) { this.log(`mkdir (reconcile) recusado (caminho inseguro): ${rel}`); continue; }
      this.echo.expectDirAdd(rel);
      await fsp.mkdir(toAbs(this.dir, rel), { recursive: true }).catch(() => {});
      this.dirs.add(rel);
    }
  }
}
