// Núcleo da sincronização: liga uma pasta a uma conexão WebSocket.
// - Mantém o manifesto em memória.
// - Monitora a pasta (chokidar) e empurra mudanças locais para o peer.
// - Recebe mudanças do peer, grava de forma atômica e suprime o "eco" do
//   watcher para não reenviar o que acabou de aplicar.
// - Reconcilia ao conectar (mais recente vence; nunca deleta na união inicial).
import fsp from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { MSG, PROTOCOL_VERSION } from './protocol.js';
import { buildManifest, hashFile, toAbs, reconcilePlan } from './manifest.js';
import { sendFile, TransferReceiver } from './transfer.js';
import { isIgnored, TEMP_SUFFIX } from './ignore.js';
import { loadState, saveState } from './state.js';
import { DeleteSuppressor } from './suppress.js';
import { moveToTrash, pruneTrash } from './trash.js';
import { detectCaseCollisions, normalizeRel } from './normalize.js';
import { signature, diff, apply } from './delta.js';
import { newTransferId } from './transfer.js';
import crypto from 'node:crypto';

const DELTA_MIN = 256 * 1024;        // só vale a pena delta acima disto
const DELTA_MAX = 64 * 1024 * 1024;  // acima disto, transfere cheio (memória)
const DELTA_BLOCK = 4096;

// Reescreve as chaves de um objeto rel->valor para a forma canônica NFC.
// Usado nos manifestos/tombstones recebidos do peer para que NFC e NFD do mesmo
// nome não sejam tratados como dois arquivos distintos (ver normalize.js).
function normalizeKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[normalizeRel(k)] = obj[k];
  return out;
}

// Garante (LEXICAMENTE) que um caminho relativo recebido do peer não escapa da
// pasta raiz. É só a primeira barreira: não enxerga symlinks (ver isSafeTarget).
function isSafeRel(dir, rel) {
  if (!rel || rel.includes('\0')) return false;
  const abs = path.resolve(dir, rel.split('/').join(path.sep));
  const root = path.resolve(dir);
  return abs === root || abs.startsWith(root + path.sep);
}

export class SyncEngine {
  constructor({ dir, ig, isHost, log, checksum }) {
    this.dir = path.resolve(dir);
    this.ig = ig;
    this.isHost = isHost;
    this.log = log || (() => {});
    this.checksum = !!checksum;
    this.manifest = {};
    this.tombstones = {};        // rel -> deletedAtMs (relógio LOCAL)
    this.peerManifest = null;
    this.peerTombstones = null;
    this.clockOffset = 0;        // (relógio do peer) - (relógio local), em ms
    this.ws = null;
    this.receiver = null;
    this.watcher = null;
    this.saveTimer = null;
    // Anti-eco: rel -> Set(hashes esperados de escritas vindas do peer).
    this.suppressAdd = new Map();
    this.suppressDelete = new DeleteSuppressor();
    // Diretórios (para sincronizar pastas vazias) e anti-eco de mkdir/rmdir.
    this.dirs = new Set();
    this.suppressDirAdd = new Set();
    this.suppressDirDel = new Set();
    // Detecção de rename ao vivo: hash -> { rel, timer } de unlinks recentes.
    this.recentUnlinks = new Map();
    // Delta sync: transferId -> resolver aguardando a assinatura (SIG) do peer.
    this.pendingSig = new Map();
  }

  async start() {
    // Carrega o cache de hashes (para varredura rápida) e os tombstones.
    const { files, tombstones } = loadState(this.dir);
    this.tombstones = tombstones;

    // Sobe o watcher e ESPERA o 'ready' ANTES de varrer o manifesto: assim
    // capturamos também arquivos criados durante a inicialização (que o
    // ignoreInitial descartaria) e evitamos uma janela cega no boot.
    this.startWatcher();
    await this.watcherReady;

    this.manifest = await buildManifest(this.dir, this.ig, {
      prev: files,
      checksum: this.checksum,
      log: this.log,
    });
    this.dirs = await this.scanDirs();

    // Deleção OFFLINE: arquivo que estava no estado salvo e agora sumiu (e não
    // virou ignorado) foi apagado com o app fechado -> vira tombstone para
    // propagar a deleção na próxima conexão (em vez de ser ressuscitado).
    const now = Date.now();
    let offline = 0;
    for (const rel of Object.keys(files)) {
      if (!this.manifest[rel] && this.tombstones[rel] === undefined && !isIgnored(this.ig, rel)) {
        this.tombstones[rel] = now;
        offline++;
      }
    }
    if (offline) this.log(`${offline} deleção(ões) offline detectada(s)`);

    // Aviso de colisão por maiúsculas/Unicode (perigoso ao sincronizar com SO
    // case-insensitive como macOS/Windows). Apenas alerta, não altera nada.
    const collisions = detectCaseCollisions(this.manifest);
    for (const grupo of collisions) {
      this.log(`aviso: arquivos colidem por maiúsculas/acentos: ${grupo.join(', ')}`);
    }

    // Só agora plugamos os handlers: eventos a partir daqui são mudanças reais
    // (pós-boot), sem corrida contra a varredura inicial.
    this.attachWatcherHandlers();
    pruneTrash(this.dir).catch(() => {}); // limpa lixeira antiga (30 dias)
    this.scheduleSave();
  }

  // Salva o estado (cache de hashes + tombstones) em disco de forma debounced.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      saveState(this.dir, { files: this.manifest, tombstones: this.tombstones });
    }, 1000);
  }

  startWatcher() {
    this.watcher = chokidar.watch(this.dir, {
      ignoreInitial: true, // não dispara 'add' para o que já existe
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p) => {
        const rel = path.relative(this.dir, p).split(path.sep).join('/');
        return rel ? isIgnored(this.ig, rel) : false;
      },
    });
    this.watcherReady = new Promise((res) => this.watcher.once('ready', res));
  }

  attachWatcherHandlers() {
    this.watcher.on('add', (p) => this.onLocalUpsert(p));
    this.watcher.on('change', (p) => this.onLocalUpsert(p));
    this.watcher.on('unlink', (p) => this.onLocalUnlink(p));
    this.watcher.on('addDir', (p) => this.onLocalAddDir(p));
    this.watcher.on('unlinkDir', (p) => this.onLocalRmDir(p));
  }

  // Varre os diretórios (inclusive vazios) respeitando os ignores.
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

  attach(ws) {
    this.ws = ws;
    this.peerManifest = {};
    this.peerTombstones = {};
    this.receiver = new TransferReceiver(this.dir, {
      onComplete: (rel, meta) => this.onRemoteFileWritten(rel, meta),
      onReject: (rel, motivo) => {
        this.suppressAdd.delete(rel); // libera a supressão de um eco que não virá
        this.log(`recebimento rejeitado (${rel}): ${motivo}`);
      },
      log: this.log,
    });

    ws.send(JSON.stringify({ type: MSG.HELLO, version: PROTOCOL_VERSION, isHost: this.isHost, time: Date.now() }));
    ws.send(JSON.stringify({ type: MSG.MANIFEST, files: this.manifest, tombstones: this.tombstones, dirs: [...this.dirs] }));

    // Fila serial: garante que FILE_BEGIN seja totalmente processado antes dos
    // chunks que o seguem, e aplica backpressure (await da escrita) na ordem.
    let queue = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      queue = queue.then(() => this.handleMessage(ws, data, isBinary))
        .catch((e) => this.log('erro ao processar mensagem: ' + e.message));
    });
  }

  async handleMessage(ws, data, isBinary) {
    if (ws !== this.ws || !this.receiver) return; // conexão já trocou/fechou
    if (isBinary) {
      await this.receiver.chunk(data); // pode retornar Promise (backpressure)
    } else {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      await this.onControl(msg);
    }
  }

  async detach(ws) {
    // Só limpa se o ws que fechou ainda é o ativo (evita anular reconexão nova).
    if (ws && ws !== this.ws) return;
    if (this.receiver) await this.receiver.cleanup();
    for (const [, p] of this.pendingSig) { clearTimeout(p.timer); p.resolve(null); }
    this.pendingSig.clear();
    this.receiver = null;
    this.ws = null;
    this.peerManifest = null;
    this.peerTombstones = null;
  }

  async onControl(msg) {
    switch (msg.type) {
      case MSG.HELLO:
        // Recusa versões de protocolo incompatíveis (evita corromper o sync).
        if (msg.version !== PROTOCOL_VERSION) {
          this.log(`versão de protocolo incompatível (peer v${msg.version}, local v${PROTOCOL_VERSION}) — encerrando`);
          if (this.ws) this.ws.close();
          return;
        }
        // Estima a diferença de relógio com o peer (ignorando a latência, que é
        // pequena perto do skew que importa para "mais recente vence").
        if (typeof msg.time === 'number') this.clockOffset = msg.time - Date.now();
        this.log(`conectado (peer ${msg.isHost ? 'host' : 'cliente'}, protocolo v${msg.version}, offset ${this.clockOffset}ms)`);
        break;
      case MSG.MANIFEST:
        // Canoniza as CHAVES recebidas para NFC (ver manifest.js): garante que a
        // comparação contra o manifesto local (já NFC) trate NFC/NFD como o mesmo
        // arquivo, mesmo que o peer ainda não normalize.
        this.peerManifest = normalizeKeys(msg.files || {});
        this.peerTombstones = normalizeKeys(msg.tombstones || {});
        await this.reconcileDirs(msg.dirs || []);
        await this.reconcile();
        break;
      case MSG.MKDIR:
        await this.applyRemoteMkdir(msg.rel);
        break;
      case MSG.RMDIR:
        await this.applyRemoteRmdir(msg.rel);
        break;
      case MSG.RENAME:
        await this.applyRemoteRename(msg.from, msg.to);
        break;
      case MSG.DELTA_REQ:
        await this.handleDeltaReq(msg);
        break;
      case MSG.SIG: {
        const p = this.pendingSig.get(msg.transferId);
        if (p) { this.pendingSig.delete(msg.transferId); clearTimeout(p.timer); p.resolve(msg.has ? msg : null); }
        break;
      }
      case MSG.DELTA:
        await this.applyDelta(msg);
        break;
      case MSG.FILE_BEGIN: {
        // Chave lógica em NFC (ver manifest.js): normaliza o rel ANTES de validar,
        // suprimir o eco e entregar ao receiver, para que a chave de manifesto, a
        // supressão e o caminho gravado coincidam com a forma canônica usada nos
        // dois lados. (Mantém-se o msg original; só substituímos o rel.)
        msg.rel = normalizeRel(msg.rel);
        const motivo = await this.rejectReason(msg.rel);
        if (motivo) {
          this.log(`recusado (${motivo}): ${msg.rel}`);
          return;
        }
        // Suprime o eco só para transferências aceitas (registramos depois das
        // validações). Limpeza acontece no rename (onRemoteFileWritten).
        this.announced = false; // chegou trabalho: re-anuncia "em sincronia" depois
        this.expectWrite(msg.rel, msg.hash);
        if (this.receiver) await this.receiver.begin(msg);
        break;
      }
      case MSG.FILE_END:
        if (this.receiver) await this.receiver.end(msg.transferId);
        break;
      case MSG.DELETE:
        await this.applyRemoteDelete(msg.rel, msg.deletedAt);
        break;
      case MSG.REJECT:
        this.log(`recusado pelo peer: ${msg.reason || 'sem motivo'}`);
        break;
    }
  }

  // Verificação de segurança REFORÇADA contra path traversal por symlink.
  // isSafeRel é só lexico (path.resolve) e não enxerga symlinks; um symlink-pasta
  // num componente INTERMEDIÁRIO (ex: raiz/link -> /home/vitima/.ssh) faria a
  // escrita aterrissar FORA da pasta mesmo com rel "seguro". Aqui resolvemos com
  // fs.realpath o ancestral EXISTENTE mais profundo do caminho e exigimos que
  // ele continue DENTRO de realpath(this.dir). Se algum componente já existente
  // for um symlink apontando para fora, a operação é recusada.
  async isSafeTarget(rel) {
    if (!isSafeRel(this.dir, rel)) return false;
    let realRoot;
    try { realRoot = await fsp.realpath(this.dir); }
    catch { return false; } // sem raiz real não há como garantir contenção
    const abs = toAbs(this.dir, rel);
    // Sobe pelos ancestrais até achar um que exista no disco; esse é o mais
    // profundo cujo realpath conseguimos resolver (o resto ainda será criado).
    let probe = path.dirname(abs);
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        // O ancestral existente tem que ser a própria raiz ou estar dentro dela.
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return false;
        return true;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) return false; // chegou na raiz do FS sem resolver
        probe = parent;
      }
    }
  }

  // Valida um caminho recebido do peer. Devolve o motivo da recusa, ou null.
  async rejectReason(rel) {
    if (!isSafeRel(this.dir, rel)) return 'caminho inseguro';
    if (isIgnored(this.ig, rel)) return 'arquivo ignorado';
    // Symlink num componente intermediário escaparia da raiz apesar do isSafeRel.
    if (!(await this.isSafeTarget(rel))) return 'caminho inseguro (symlink)';
    // Não escrever através de um symlink na FOLHA (idem, escaparia da raiz).
    try {
      const st = await fsp.lstat(toAbs(this.dir, rel));
      if (st.isSymbolicLink()) return 'symlink';
    } catch { /* destino não existe: ok */ }
    return null;
  }

  // Reconcilia local x peer (arquivos vivos + tombstones, com ajuste de clock).
  async reconcile() {
    if (!this.peerManifest) return;
    // Snapshots: evita comparar contra um estado que muda enquanto escritas
    // remotas chegam (ping-pong/perda).
    const localSnap = { ...this.manifest };
    const tombSnap = { ...this.tombstones };
    const plan = reconcilePlan(localSnap, tombSnap, this.peerManifest, this.peerTombstones || {}, {
      offset: this.clockOffset,
      isHost: this.isHost,
    });
    this.log(`reconciliando: enviar ${plan.send.length}, deletar local ${plan.deleteLocal.length}, propagar delete ${plan.sendDelete.length}`);
    for (const rel of plan.send) await this.pushFile(rel, { allowDelta: false });
    for (const rel of plan.sendDelete) this.sendDelete(rel, this.tombstones[rel]);
    for (const rel of plan.deleteLocal) {
      // Peer deletou mais recentemente: apaga local e adota o tombstone (no relógio local).
      const peerDel = this.peerTombstones ? this.peerTombstones[rel] : undefined;
      const when = typeof peerDel === 'number' ? peerDel - this.clockOffset : Date.now();
      await this.deleteLocalFile(rel, when);
    }
    this.maybeInSync();
  }

  // ---- Saída: empurrar mudanças locais para o peer ----

  // allowDelta=false durante a reconcile (que roda DENTRO da fila serial de
  // mensagens; esperar a resposta SIG ali causaria deadlock).
  async pushFile(rel, { allowDelta = true } = {}) {
    const ws = this.ws; // captura: a conexão pode trocar durante o await
    if (!ws || ws.readyState !== ws.OPEN) return;
    const meta = this.manifest[rel];
    if (!meta) return;
    this.sending = (this.sending || 0) + 1;
    this.announced = false;
    try {
      if (meta.size >= 4 * 1024 * 1024) this.log(`enviando ${rel} (${(meta.size / 1048576).toFixed(1)} MB)`);
      const peerOld = this.peerManifest && this.peerManifest[rel];
      const canDelta = allowDelta && peerOld && peerOld.hash !== meta.hash &&
        meta.size >= DELTA_MIN && meta.size <= DELTA_MAX;
      let sent = false;
      if (canDelta) sent = await this.pushDelta(rel, meta, ws);
      if (!sent) await sendFile(ws, toAbs(this.dir, rel), rel, meta);
      if (this.peerManifest && this.ws === ws) this.peerManifest[rel] = meta; // peer tem esta versão
    } catch (e) {
      this.log(`falha ao enviar ${rel}: ${e.message}`);
    } finally {
      this.sending--;
      this.maybeInSync();
    }
  }

  // Envia só os blocos que mudaram (rsync). Retorna false para cair no envio
  // completo (peer não tem versão antiga, delta não compensou, ou timeout).
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
    if (this.ws !== ws || ws.readyState !== ws.OPEN) return false; // conexão trocou
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
    msg.rel = normalizeRel(msg.rel); // chave lógica em NFC (ver manifest.js)
    if (!isSafeRel(this.dir, msg.rel)) { this.ws.send(JSON.stringify({ type: MSG.SIG, transferId: msg.transferId, has: false })); return; }
    let buf;
    try { buf = await fsp.readFile(toAbs(this.dir, msg.rel)); } catch {
      this.ws.send(JSON.stringify({ type: MSG.SIG, transferId: msg.transferId, has: false }));
      return;
    }
    const sig = signature(buf, DELTA_BLOCK);
    this.ws.send(JSON.stringify({ type: MSG.SIG, transferId: msg.transferId, has: true, blockSize: DELTA_BLOCK, sig }));
  }

  // Recebe um delta: reconstrói o arquivo a partir do antigo + ops e valida hash.
  async applyDelta(msg) {
    msg.rel = normalizeRel(msg.rel); // chave lógica em NFC (ver manifest.js)
    const motivo = await this.rejectReason(msg.rel);
    if (motivo) { this.log(`delta recusado (${motivo}): ${msg.rel}`); return; }
    let oldBuf;
    try { oldBuf = await fsp.readFile(toAbs(this.dir, msg.rel)); } catch { oldBuf = Buffer.alloc(0); }
    const ops = msg.ops.map((o) => (o.d !== undefined ? { data: Buffer.from(o.d, 'base64') } : { copy: o.c }));
    let newBuf;
    try { newBuf = apply(oldBuf, ops, msg.blockSize); } catch (e) { this.log(`delta falhou em ${msg.rel}: ${e.message}`); return; }
    // Integridade: o resultado tem que bater com o hash/tamanho anunciados.
    const digest = crypto.createHash('sha256').update(newBuf).digest('hex');
    if (digest !== msg.hash || newBuf.length !== msg.size) {
      this.log(`delta inválido em ${msg.rel} (hash/tamanho) — será re-sincronizado`);
      return;
    }
    this.announced = false;
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

  // Anuncia "em sincronia" quando não há nada em voo (uma vez por ciclo).
  maybeInSync() {
    if (this.announced) return;
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    if ((this.sending || 0) > 0) return;
    if (this.receiver && this.receiver.active.size > 0) return;
    this.announced = true;
    this.log('✓ em sincronia');
  }

  sendDelete(rel, deletedAt) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    // deletedAt = quando a deleção aconteceu (relógio local), para desempate
    // delete-vs-edit e para o peer registrar/propagar.
    const when = typeof deletedAt === 'number' ? deletedAt : Date.now();
    this.ws.send(JSON.stringify({ type: MSG.DELETE, rel, deletedAt: when }));
  }

  // ---- Watcher local ----

  async onLocalUpsert(absPath) {
    // Chave lógica em NFC (ver manifest.js): mesmo nome visível tem que casar
    // entre os peers mesmo que o disco use NFD (macOS).
    const rel = normalizeRel(path.relative(this.dir, absPath).split(path.sep).join('/'));
    let meta;
    try {
      const stat = await fsp.stat(absPath);
      meta = { hash: await hashFile(absPath), size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
    } catch {
      return; // sumiu nesse meio tempo
    }

    // Arquivo vivo de novo: remove qualquer tombstone pendente.
    delete this.tombstones[rel];

    // Reapareceu no MESMO caminho: cancela a deleção adiada (era um modify,
    // não um delete) para o finalizeDelete não apagar o arquivo recriado.
    const samePath = this.recentUnlinks.get(rel);
    if (samePath) { clearTimeout(samePath.timer); this.recentUnlinks.delete(rel); }

    // Eco de uma escrita que veio do peer? Consome e não reenvia.
    // Limpa a entrada INTEIRA: o awaitWriteFinish coalesce escritas e só entrega
    // o estado final, então hashes intermediários nunca disparariam evento.
    const expected = this.suppressAdd.get(rel);
    if (expected && expected.has(meta.hash)) {
      this.suppressAdd.delete(rel);
      this.manifest[rel] = meta;
      this.scheduleSave();
      return;
    }

    // RENAME? Um unlink recente com o MESMO hash E TAMANHO = arquivo movido.
    // Exigir size também evita rename espúrio por colisão de hash entre arquivos
    // de identidades diferentes (que engoliria uma deleção real). Mandamos RENAME
    // (mover no peer) em vez de retransferir o conteúdo.
    for (const [oldRel, ent] of this.recentUnlinks) {
      if (ent.hash === meta.hash && ent.size === meta.size) {
        clearTimeout(ent.timer);
        this.recentUnlinks.delete(oldRel);
        this.manifest[rel] = meta;
        this.scheduleSave();
        if (this.peerManifest) { delete this.peerManifest[oldRel]; this.peerManifest[rel] = meta; }
        this.log(`rename: ${oldRel} -> ${rel}`);
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          this.ws.send(JSON.stringify({ type: MSG.RENAME, from: oldRel, to: rel }));
        }
        return;
      }
    }

    this.manifest[rel] = meta;
    this.scheduleSave();
    // Se o peer já tem exatamente este conteúdo, não reenvia (quebra loops).
    if (this.peerManifest && this.peerManifest[rel] && this.peerManifest[rel].hash === meta.hash) {
      return;
    }
    await this.pushFile(rel);
  }

  onLocalUnlink(absPath) {
    // Chave lógica em NFC (ver manifest.js).
    const rel = normalizeRel(path.relative(this.dir, absPath).split(path.sep).join('/'));
    // Eco de uma deleção que veio do peer? Consome (contador) e não re-propaga.
    if (this.suppressDelete.consume(rel)) {
      delete this.manifest[rel];
      this.scheduleSave();
      return;
    }
    // Captura hash E size ANTES de apagar do manifesto: o rename ao vivo exige
    // ambos iguais (ver onLocalUpsert) para não casar arquivos só por hash.
    const prev = this.manifest[rel];
    const hash = prev ? prev.hash : null;
    const size = prev ? prev.size : null;
    delete this.manifest[rel];
    this.scheduleSave();
    // Adia a propagação ~800ms para detectar rename (add com mesmo hash logo
    // em seguida). Se nada aparecer, finaliza como deleção de verdade.
    if (hash) {
      const timer = setTimeout(() => this.finalizeDelete(rel), 800);
      if (timer.unref) timer.unref();
      this.recentUnlinks.set(rel, { hash, size, timer });
    } else {
      this.finalizeDelete(rel);
    }
  }

  finalizeDelete(rel) {
    const ent = this.recentUnlinks.get(rel);
    if (ent) { clearTimeout(ent.timer); this.recentUnlinks.delete(rel); }
    const now = Date.now();
    this.tombstones[rel] = now; // sobrevive à desconexão e propaga
    this.scheduleSave();
    this.sendDelete(rel, now);
  }

  // ---- Aplicação de mudanças vindas do peer ----

  // Registra que uma escrita com este hash virá do peer. SEM timeout aqui: uma
  // transferência grande pode demorar, e expirar no meio causaria loop de eco.
  // O timeout de segurança é armado só quando o arquivo aterrissa (rename).
  expectWrite(rel, hash) {
    if (!this.suppressAdd.has(rel)) this.suppressAdd.set(rel, new Set());
    this.suppressAdd.get(rel).add(hash);
  }

  clearSuppressLater(rel, hash) {
    // Rede de segurança: se o watcher nunca disparar (ex: conteúdo idêntico),
    // limpa após 10s contados do momento em que o arquivo já está no disco.
    setTimeout(() => {
      const set = this.suppressAdd.get(rel);
      if (set) { set.delete(hash); if (set.size === 0) this.suppressAdd.delete(rel); }
    }, 10000);
  }

  onRemoteFileWritten(rel, meta) {
    // Arquivo do peer já gravado e validado (hash conferido em transfer.js).
    this.manifest[rel] = meta;
    delete this.tombstones[rel]; // está vivo de novo
    if (this.peerManifest) this.peerManifest[rel] = meta; // o peer tem esta versão
    this.clearSuppressLater(rel, meta.hash);
    this.scheduleSave();
    this.maybeInSync();
  }

  async applyRemoteDelete(relRaw, deletedAt) {
    const rel = normalizeRel(relRaw); // chave lógica em NFC (ver manifest.js)
    if (!isSafeRel(this.dir, rel)) return;
    // Defesa-em-profundidade: um ancestral symlink p/ fora faria o rm/fsp.rm
    // atravessar e apagar algo FORA da raiz (ver isSafeTarget).
    if (!(await this.isSafeTarget(rel))) { this.log(`delete recusado (caminho inseguro): ${rel}`); return; }
    const abs = toAbs(this.dir, rel);
    // Converte o instante da deleção (relógio do peer) para o relógio local.
    const deletedAtLocal = typeof deletedAt === 'number' ? deletedAt - this.clockOffset : Date.now();

    // Desempate delete-vs-edit: se o arquivo local foi modificado DEPOIS da
    // deleção, a edição é mais recente e vence — ignoramos o delete e reenviamos.
    try {
      const st = await fsp.stat(abs);
      if (Math.floor(st.mtimeMs) > deletedAtLocal) {
        this.log(`delete ignorado (edição local mais nova): ${rel}`);
        // allowDelta:false: estamos DENTRO da fila serial de mensagens; esperar a
        // resposta SIG do delta aqui travaria a própria fila (deadlock ~30s).
        // Mesmo motivo do allowDelta:false na reconcile (ver pushFile).
        await this.pushFile(rel, { allowDelta: false });
        return;
      }
    } catch { /* não existe localmente: segue com o delete (vira tombstone) */ }

    await this.deleteLocalFile(rel, deletedAtLocal);
  }

  // Apaga um arquivo localmente por ordem do peer/reconciliação: suprime o eco
  // do watcher (só se havia arquivo) e registra o tombstone no relógio local.
  async deleteLocalFile(rel, deletedAtLocal) {
    const abs = toAbs(this.dir, rel);
    let existed = false;
    try { await fsp.access(abs); existed = true; } catch { /* não existe */ }
    if (existed) {
      this.suppressDelete.expect(rel);
      await moveToTrash(this.dir, rel).catch(() => {}); // recuperação antes de apagar
      try { await fsp.rm(abs, { force: true }); } catch { /* corrida */ }
    }
    delete this.manifest[rel];
    this.tombstones[rel] = deletedAtLocal;
    if (this.peerManifest) delete this.peerManifest[rel];
    this.scheduleSave();
  }

  // ---- Diretórios (pastas vazias) ----

  onLocalAddDir(absPath) {
    const rel = normalizeRel(path.relative(this.dir, absPath).split(path.sep).join('/')); // chave NFC (ver manifest.js)
    if (!rel) return;
    if (this.suppressDirAdd.has(rel)) { this.suppressDirAdd.delete(rel); this.dirs.add(rel); return; }
    this.dirs.add(rel);
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ type: MSG.MKDIR, rel }));
  }

  onLocalRmDir(absPath) {
    const rel = normalizeRel(path.relative(this.dir, absPath).split(path.sep).join('/')); // chave NFC (ver manifest.js)
    if (!rel) return;
    if (this.suppressDirDel.has(rel)) { this.suppressDirDel.delete(rel); this.dirs.delete(rel); return; }
    this.dirs.delete(rel);
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ type: MSG.RMDIR, rel }));
  }

  async applyRemoteMkdir(relRaw) {
    const rel = normalizeRel(relRaw); // chave lógica em NFC (ver manifest.js)
    if (!isSafeRel(this.dir, rel) || isIgnored(this.ig, rel)) return;
    // Recusa se um ancestral existente for symlink p/ fora (ver isSafeTarget).
    if (!(await this.isSafeTarget(rel))) { this.log(`mkdir recusado (caminho inseguro): ${rel}`); return; }
    this.suppressDirAdd.add(rel);
    setTimeout(() => this.suppressDirAdd.delete(rel), 10000);
    await fsp.mkdir(toAbs(this.dir, rel), { recursive: true }).catch(() => {});
    this.dirs.add(rel);
  }

  async applyRemoteRmdir(relRaw) {
    const rel = normalizeRel(relRaw); // chave lógica em NFC (ver manifest.js)
    if (!isSafeRel(this.dir, rel)) return;
    // Defesa-em-profundidade: ancestral symlink p/ fora atravessaria o rmdir (ver isSafeTarget).
    if (!(await this.isSafeTarget(rel))) { this.log(`rmdir recusado (caminho inseguro): ${rel}`); return; }
    this.suppressDirDel.add(rel);
    setTimeout(() => this.suppressDirDel.delete(rel), 10000);
    await fsp.rmdir(toAbs(this.dir, rel)).catch(() => {}); // só remove se vazio
    this.dirs.delete(rel);
  }

  async reconcileDirs(peerDirs) {
    for (const raw of peerDirs) {
      const rel = normalizeRel(raw); // chave lógica em NFC (ver manifest.js)
      if (this.dirs.has(rel) || isIgnored(this.ig, rel)) continue;
      // Recusa se um ancestral existente for symlink p/ fora (ver isSafeTarget).
      if (!(await this.isSafeTarget(rel))) { this.log(`mkdir (reconcile) recusado (caminho inseguro): ${rel}`); continue; }
      this.suppressDirAdd.add(rel);
      setTimeout(() => this.suppressDirAdd.delete(rel), 10000);
      await fsp.mkdir(toAbs(this.dir, rel), { recursive: true }).catch(() => {});
      this.dirs.add(rel);
    }
  }

  async applyRemoteRename(fromRaw, toRaw) {
    const from = normalizeRel(fromRaw); // chaves lógicas em NFC (ver manifest.js)
    const to = normalizeRel(toRaw);
    if (!isSafeRel(this.dir, from) || !isSafeRel(this.dir, to) || isIgnored(this.ig, to)) return;
    // Recusa se um ancestral existente de ORIGEM ou DESTINO for symlink p/ fora:
    // ler/gravar através dele escaparia da raiz (ver isSafeTarget).
    if (!(await this.isSafeTarget(from)) || !(await this.isSafeTarget(to))) {
      this.log(`rename recusado (caminho inseguro): ${from} -> ${to}`);
      return;
    }
    const hash = this.manifest[from] ? this.manifest[from].hash : null;
    this.suppressDelete.expect(from);     // o unlink do origem será suprimido
    if (hash) this.expectWrite(to, hash); // o add do destino será suprimido
    try {
      await fsp.mkdir(path.dirname(toAbs(this.dir, to)), { recursive: true });
      await fsp.rename(toAbs(this.dir, from), toAbs(this.dir, to));
    } catch (e) {
      this.log(`rename ${from}->${to} falhou: ${e.message} (será re-sincronizado)`);
      return;
    }
    if (this.manifest[from]) { this.manifest[to] = this.manifest[from]; delete this.manifest[from]; }
    delete this.tombstones[from];
    if (this.peerManifest && this.peerManifest[from]) {
      this.peerManifest[to] = this.peerManifest[from];
      delete this.peerManifest[from];
    }
    this.scheduleSave();
  }

  async stop() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    for (const [, ent] of this.recentUnlinks) clearTimeout(ent.timer);
    this.recentUnlinks.clear();
    saveState(this.dir, { files: this.manifest, tombstones: this.tombstones }); // estado atualizado ao sair
    this.suppressDelete.clear();
    if (this.watcher) await this.watcher.close();
    await this.detach();
  }
}
