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
import { isIgnored } from './ignore.js';
import { loadState, saveState } from './state.js';
import { EchoSuppressor } from './echo-suppress.js';
import { LiveRenameDetector } from './live-rename.js';
import { DirSync } from './dir-sync.js';
import { isSafeRel } from './path-safety.js';
import { moveToTrash, pruneTrash } from './trash.js';
import { detectCaseCollisions, normalizeRel } from './normalize.js';
import { DeltaTransport, DELTA_MIN, DELTA_MAX } from './delta-transport.js';

// Reescreve as chaves de um objeto rel->valor para a forma canônica NFC.
// Usado nos manifestos/tombstones recebidos do peer para que NFC e NFD do mesmo
// nome não sejam tratados como dois arquivos distintos (ver normalize.js).
function normalizeKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[normalizeRel(k)] = obj[k];
  return out;
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
    // Envios em voo aguardando ACK/NACK: transferId -> { rel, meta, retries }.
    // Permite reverter o peerManifest otimista num NACK e reenviar (1x) em falha
    // recuperável. Cap de 1 retry por transferId; resetado a cada conexão
    // (limpo em detach()/stop()) para não acumular loop de reenvio. Ver onControl.
    this.inflight = new Map();
    // Anti-eco centralizado: escritas (suppressAdd), deleções (DeleteSuppressor)
    // e mkdir/rmdir de diretórios. Ver echo-suppress.js.
    this.echo = new EchoSuppressor();
    // Diretórios (pastas vazias): estado + mkdir/rmdir local/remoto. Ver dir-sync.js.
    // O send é resolvido na hora (a conexão pode trocar): só emite se o ws atual
    // estiver aberto — mesma condição do código original.
    this.dirSync = new DirSync({
      dir: this.dir,
      ig: this.ig,
      echo: this.echo,
      isSafeTarget: (rel) => this.isSafeTarget(rel),
      send: (msg) => { if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg)); },
      log: this.log,
    });
    // Detecção de rename ao vivo (unlink+add com mesmo hash+size). Ver live-rename.js.
    this.liveRename = new LiveRenameDetector();
    // Transporte delta (rsync). A DECISÃO de usar delta (allowDelta) fica aqui no
    // pushFile; o módulo só executa. Ver delta-transport.js.
    this.delta = new DeltaTransport({
      dir: this.dir,
      log: this.log,
      getWs: () => this.ws,
      rejectReason: (rel) => this.rejectReason(rel),
      expectWrite: (rel, hash) => this.expectWrite(rel, hash),
      onRemoteFileWritten: (rel, meta) => this.onRemoteFileWritten(rel, meta),
      onWork: () => { this.announced = false; },
    });
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
    this.dirSync.setDirs(await this.dirSync.scanDirs());

    // Deleção OFFLINE: arquivo que estava no estado salvo e agora sumiu (e não
    // virou ignorado) foi apagado com o app fechado -> vira tombstone para
    // propagar a deleção na próxima conexão (em vez de ser ressuscitado).
    const now = Date.now();
    let offline = 0;
    for (const rel of Object.keys(files)) {
      if (!this.manifest[rel] && this.tombstones[rel] === undefined && !isIgnored(this.ig, rel)) {
        // PORQUÊ: carimbar com `now` (instante do boot) faz a deleção offline
        // SEMPRE vencer qualquer edição concorrente que o peer tenha feito
        // offline (boot > qualquer edição anterior) — perda de dado. A deleção
        // aconteceu em ALGUM momento entre a última versão conhecida (mtime) e o
        // boot; carimbar no mtime da última versão conhecida é o limite inferior
        // conservador: se o peer não mexeu (mtime igual), o empate do caso 2 da
        // reconcile ainda propaga a deleção; se o peer editou mais novo, a edição
        // vence e ressuscita o arquivo. Guarda: mtime ausente/inválido -> `now`.
        const t = (files[rel] && Number.isFinite(files[rel].mtimeMs)) ? files[rel].mtimeMs : now;
        this.tombstones[rel] = t;
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
    this.watcher.on('addDir', (p) => this.dirSync.onLocalAddDir(p));
    this.watcher.on('unlinkDir', (p) => this.dirSync.onLocalRmDir(p));
  }

  attach(ws) {
    this.ws = ws;
    this.peerManifest = {};
    this.peerTombstones = {};
    this.receiver = new TransferReceiver(this.dir, {
      onComplete: (rel, meta, transferId) => {
        this.onRemoteFileWritten(rel, meta);
        // ACK fim-a-fim: confirma ao REMETENTE que a escrita foi promovida, para
        // ele limpar o inflight (peerManifest já estava otimisticamente correto).
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          this.ws.send(JSON.stringify({ type: MSG.ACK, transferId }));
        }
      },
      onReject: (rel, motivo, transferId) => {
        this.echo.cancelWrite(rel); // libera a supressão de um eco que não virá
        this.log(`recebimento rejeitado (${rel}): ${motivo}`);
        // NACK fim-a-fim: avisa o REMETENTE que NÃO temos o arquivo, para ele
        // reverter o peerManifest otimista e, se o motivo for recuperável,
        // reenviar uma vez (ver handler de MSG.NACK).
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          this.ws.send(JSON.stringify({ type: MSG.NACK, rel, reason: motivo, transferId }));
        }
      },
      log: this.log,
    });

    ws.send(JSON.stringify({ type: MSG.HELLO, version: PROTOCOL_VERSION, isHost: this.isHost, time: Date.now() }));
    ws.send(JSON.stringify({ type: MSG.MANIFEST, files: this.manifest, tombstones: this.tombstones, dirs: [...this.dirSync.dirs] }));

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
    this.delta.cancelPending();
    this.inflight.clear(); // reseta o cap de retry de ACK/NACK a cada conexão
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
        await this.dirSync.reconcileDirs(msg.dirs || []);
        await this.reconcile();
        break;
      case MSG.MKDIR:
        await this.dirSync.applyRemoteMkdir(msg.rel);
        break;
      case MSG.RMDIR:
        await this.dirSync.applyRemoteRmdir(msg.rel);
        break;
      case MSG.RENAME:
        await this.applyRemoteRename(msg.from, msg.to);
        break;
      case MSG.DELTA_REQ:
        await this.delta.handleDeltaReq(msg);
        break;
      case MSG.SIG:
        this.delta.resolveSig(msg);
        break;
      case MSG.DELTA:
        await this.delta.applyDelta(msg);
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
      case MSG.ACK:
        // O peer confirmou a escrita: nada a corrigir (peerManifest já otimista).
        // Só baixa o registro em voo correspondente.
        this.inflight.delete(msg.transferId);
        break;
      case MSG.NACK: {
        // O peer recusou a escrita: NÃO temos garantia de que ele tem o arquivo,
        // então revertemos o peerManifest otimista (ser honesto evita "achar que
        // entregou" e nunca reenviar). Pega rel/retries do inflight pelo
        // transferId (caminho de envio completo) ou cai no msg.rel (caminho DELTA,
        // que não usa o transferId de sendFile).
        const entry = msg.transferId !== undefined ? this.inflight.get(msg.transferId) : undefined;
        const rel = (entry && entry.rel) || msg.rel;
        const retries = entry ? entry.retries : 0;
        if (msg.transferId !== undefined) this.inflight.delete(msg.transferId);
        if (!rel) break;
        if (this.peerManifest) delete this.peerManifest[rel]; // o peer NÃO tem
        // Motivos PERSISTENTES (corretos): não reenviar — resync ocorre na próxima
        // edição/reconexão. 'versão local mais nova' é a regra "mais recente vence"
        // do peer; 'sem espaço em disco' é uma condição de recurso do peer.
        const persistente = msg.reason === 'sem espaço em disco' || msg.reason === 'versão local mais nova';
        if (persistente) {
          this.log(`NACK persistente (${msg.reason}) em ${rel}: não reenvio`);
          break;
        }
        // Recuperável (erro de escrita, hash/tamanho divergente, delta inválido):
        // reenvia UMA vez. Cap de 1 retry por transferId/rel por conexão evita
        // loop infinito. allowDelta:false é OBRIGATÓRIO: este handler roda DENTRO
        // da fila serial de mensagens; esperar SIG do delta aqui travaria a fila
        // (mesmo motivo do applyRemoteDelete/reconcile).
        if (retries < 1) {
          this.log(`NACK recuperável (${msg.reason || 'sem motivo'}) em ${rel}: reenviando (retry ${retries + 1})`);
          await this.pushFile(rel, { allowDelta: false });
          // Marca o retry no novo registro em voo (criado pelo pushFile acima),
          // procurando pelo rel, para que um segundo NACK não reenvie de novo.
          for (const [tid, e] of this.inflight) {
            if (e.rel === rel && e.retries === 0) { e.retries = retries + 1; break; }
          }
          // Caso o reenvio tenha caído no caminho DELTA (sem inflight), o cap por
          // rel não persiste; mas allowDelta:false aqui garante envio COMPLETO,
          // que registra inflight — então o cap vale.
        } else {
          this.log(`NACK em ${rel}: limite de retry atingido, desisto até próxima edição/reconexão`);
        }
        break;
      }
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
      if (canDelta) sent = await this.delta.pushDelta(rel, meta, ws);
      if (!sent) {
        // Envio COMPLETO: registra em voo pelo transferId para casar o ACK/NACK.
        // (O caminho DELTA sinaliza NACK por rel sem transferId — ver onControl.)
        const transferId = await sendFile(ws, toAbs(this.dir, rel), rel, meta);
        if (this.ws === ws && transferId !== undefined) {
          this.inflight.set(transferId, { rel, meta, retries: 0 });
        }
      }
      // Set otimista do peerManifest: mantém-se mesmo em voo para evitar
      // tempestade de reenvio na janela até o ACK; um NACK reverte explicitamente.
      if (this.peerManifest && this.ws === ws) this.peerManifest[rel] = meta; // peer tem esta versão
    } catch (e) {
      this.log(`falha ao enviar ${rel}: ${e.message}`);
    } finally {
      this.sending--;
      this.maybeInSync();
    }
  }

  // pushDelta / handleDeltaReq / applyDelta + pendingSig ficam em DeltaTransport
  // (ver delta-transport.js). O SyncEngine só decide allowDelta e delega.

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
    this.liveRename.cancelPending(rel);

    // Eco de uma escrita que veio do peer? Consome e não reenvia (ver echo-suppress.js).
    if (this.echo.consumeEcho(rel, meta.hash)) {
      this.manifest[rel] = meta;
      this.scheduleSave();
      return;
    }

    // RENAME? Um unlink recente com o MESMO hash E TAMANHO = arquivo movido.
    // Exigir size também evita rename espúrio por colisão de hash entre arquivos
    // de identidades diferentes (que engoliria uma deleção real). Mandamos RENAME
    // (mover no peer) em vez de retransferir o conteúdo. Ver live-rename.js.
    const oldRel = this.liveRename.tryMatch(rel, meta.hash, meta.size);
    if (oldRel !== null) {
      this.manifest[rel] = meta;
      this.scheduleSave();
      if (this.peerManifest) { delete this.peerManifest[oldRel]; this.peerManifest[rel] = meta; }
      this.log(`rename: ${oldRel} -> ${rel}`);
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: MSG.RENAME, from: oldRel, to: rel }));
      }
      return;
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
    if (this.echo.consumeDelete(rel)) {
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
    // em seguida). Se nada aparecer, finaliza como deleção de verdade. Sem hash
    // (arquivo desconhecido) não há como casar rename: finaliza já. Ver live-rename.js.
    if (hash) {
      this.liveRename.registerUnlink(rel, hash, size, (r) => this.finalizeDelete(r));
    } else {
      this.finalizeDelete(rel);
    }
  }

  finalizeDelete(rel) {
    // A entrada em recentUnlinks (quando havia) já foi removida pelo detector ao
    // vencer a janela; aqui só registramos o tombstone e propagamos o delete.
    const now = Date.now();
    this.tombstones[rel] = now; // sobrevive à desconexão e propaga
    this.scheduleSave();
    this.sendDelete(rel, now);
  }

  // ---- Aplicação de mudanças vindas do peer ----

  // Anti-eco de escritas: delega ao EchoSuppressor (ver echo-suppress.js).
  expectWrite(rel, hash) { this.echo.expectWrite(rel, hash); }
  clearSuppressLater(rel, hash) { this.echo.clearSuppressLater(rel, hash); }

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
      this.echo.expectDelete(rel);
      await moveToTrash(this.dir, rel).catch(() => {}); // recuperação antes de apagar
      try { await fsp.rm(abs, { force: true }); } catch { /* corrida */ }
    }
    delete this.manifest[rel];
    this.tombstones[rel] = deletedAtLocal;
    if (this.peerManifest) delete this.peerManifest[rel];
    this.scheduleSave();
  }

  // ---- Diretórios (pastas vazias) ----
  // mkdir/rmdir local/remoto + reconcileDirs ficam em DirSync (ver dir-sync.js).

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
    this.echo.expectDelete(from);         // o unlink do origem será suprimido
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
    this.liveRename.clear();
    saveState(this.dir, { files: this.manifest, tombstones: this.tombstones }); // estado atualizado ao sair
    this.echo.clear();
    if (this.watcher) await this.watcher.close();
    await this.detach();
  }
}
