# filesync

Sincronizador **P2P minimalista de uma pasta** entre **dois PCs**, em tempo real,
por **linha de comando**: você compartilha uma pasta e gera um **link**; o outro
PC usa o link (via túnel público) para entrar. Toda alteração feita de um lado é
refletida no outro, enquanto os dois estiverem online.

- 🔄 Sincronização **bidirecional** em tempo real (cria, edita, apaga).
- 🌐 Funciona **pela internet** via túnel automático (link `https`/`wss` público).
- 🔌 **Porta configurável**.
- 🚫 **Ignora arquivos** com sintaxe estilo `.gitignore` (`.syncignore`). `.git` já é ignorado por padrão.
- ⚖️ Conflito resolvido por **"mais recente vence"** (data de modificação, com ajuste de diferença de relógio) — mas só sobrescreve se o **hash** realmente diferir.
- ⚡ **Varredura rápida** com cache de hashes (estilo git/rsync): só recalcula o SHA-256 de arquivos que mudaram.
- 🔒 **Criptografia ponta-a-ponta** (AES-256-GCM): o túnel/relay nunca vê o conteúdo. A passphrase vai no fragmento do link (`#k=`), que não é enviado ao servidor.
- 🧬 **Delta sync (rsync)**: editar um arquivo grande transfere só os blocos que mudaram.
- 🗑️ **Lixeira local** (`.filesync-trash/`): toda versão sobrescrita ou apagada vai para a lixeira antes (recuperável por 30 dias).
- 📁 Sincroniza **pastas vazias** e detecta **renomeações** (move sem retransferir).
- 🩺 **Integridade garantida** (hash + tamanho), **keepalive** (detecta conexão morta), **checagem de espaço** em disco, **link estável** entre reinícios e **deleções offline** propagadas.
- 🖥️ Pode rodar em **segundo plano** (`filesync daemon`).

## Para quem isto serve (e para quem não serve)

**Serve** se você quer sincronizar **uma pasta entre dois PCs** por linha de
comando, em tempo real, com criptografia ponta-a-ponta, sem instalar um serviço
pesado nem confiar o conteúdo a uma nuvem.

**Não serve** se você precisa de mais de dois dispositivos, de uma interface
gráfica, ou de sync assíncrono entre máquinas que raramente estão online ao
mesmo tempo: aqui **os dois PCs precisam estar online juntos** para sincronizar,
o transporte depende de um **túnel público gratuito** (`localtunnel`) e a CLI é
a única interface. Para N dispositivos, GUI e sync mais robusto, o
[Syncthing](https://syncthing.net) é a alternativa madura.

## Requisitos

- Node.js 18+ (testado em v24).

## Instalação

```bash
cd filesync
npm install
# opcional: deixar o comando global
npm link
```

## Uso

### PC 1 — compartilhar a pasta

```bash
filesync share /caminho/da/pasta --port 4000
# opções: --no-tunnel (só rede local), --checksum (rehashear tudo ao iniciar)
```

Ele imprime um **link** como:

```
https://abc123.loca.lt#t=SEU_TOKEN
```

### PC 2 — entrar pelo link

```bash
filesync join "https://abc123.loca.lt#t=SEU_TOKEN" /caminho/da/pasta/local
```

Pronto. A partir daí, qualquer mudança nos dois lados é sincronizada.

### Ver o que seria sincronizado

```bash
filesync status /caminho/da/pasta
```

### Rodar em segundo plano (always-on)

```bash
filesync daemon start  /caminho/da/pasta --port 4000
filesync daemon status /caminho/da/pasta
filesync daemon stop   /caminho/da/pasta
```

O link aparece no log (o caminho é mostrado ao iniciar). Para autostart no boot,
veja o template em `deploy/filesync.service` (systemd).

### Só na rede local (sem túnel)

```bash
filesync share /caminho/da/pasta --port 4000 --no-tunnel
# no outro PC, use o IP da máquina:
filesync join "ws://192.168.0.10:4000#t=SEU_TOKEN" /caminho/da/pasta
```

## Ignorar arquivos

Crie um `.syncignore` na raiz da pasta (sintaxe `.gitignore`):

```
node_modules/
*.log
*.tmp
```

`.git/` e os arquivos internos do app são sempre ignorados.

## Como funciona

```
PC A (share)                 túnel público (wss)              PC B (join)
 chokidar ─┐                                                  ┌─ chokidar
 manifesto │   <── WebSocket: eventos + transferência ──>     │ manifesto
 pasta   ──┘                                                  └── pasta
```

- Uma única conexão WebSocket (criptografada pelo túnel) carrega tanto os
  **eventos** (JSON) quanto a **transferência de arquivos** (chunks binários).
- Ao conectar, os dois lados trocam um **manifesto** (`caminho → hash, tamanho,
  mtime`) e reconciliam: quem tem a versão mais nova (por `mtime`) envia — mas
  **só se o hash diferir**, então conteúdo idêntico nunca é sobrescrito.
  Na primeira sync nada é apagado (união); depois disso, deleções são propagadas.
- **Algoritmo rápido**: a varredura faz só um `stat` por arquivo. Se tamanho e
  `mtime` batem com o cache salvo em `.filesync-state.json`, o hash anterior é
  reaproveitado — só arquivos novos/alterados são re-hasheados. Use `--checksum`
  para forçar o rehash de tudo.
- **Deleções feitas com o app desligado são detectadas**: no boot, o que estava
  no estado salvo (`.filesync-state.json`) e não aparece mais na varredura atual
  vira um *tombstone*, então a deleção é propagada na próxima conexão em vez de o
  arquivo ser ressuscitado pelo outro lado.
- O conteúdo é gravado em arquivo temporário, **validado por hash + tamanho** e
  só então renomeado (escrita atômica). O watcher tem **supressão de eco** para
  não reenviar o que acabou de receber.

## Testes

```bash
node test/e2e.mjs
```

Sobe host + cliente no mesmo processo (sem túnel) e verifica sync inicial,
edição, subpastas, deleção, ignore de `.git` e ausência de loop de eco.

## Limitações conhecidas

- **Um peer por vez** no host (feito para 2 PCs).
- "Mais recente vence" usa `mtime` absoluto, então depende dos **relógios** dos
  dois PCs estarem próximos. Com relógios muito dessincronizados, uma edição mais
  nova pode perder para uma mais antiga. (Mitigado: se o hash for igual, nada é
  sobrescrito.)
- Symlinks são ignorados nesta versão.
- O túnel padrão (`localtunnel`) usa um serviço público gratuito; para algo mais
  robusto, dá para trocar o provider em `src/tunnel.js` (ex: `cloudflared`).
  A criptografia E2E protege o conteúdo mesmo que o túnel seja não-confiável.
- **Retomada de transferência interrompida** ainda não é feita no meio do arquivo:
  se a conexão cair durante um envio grande, ele recomeça do **zero**. Na
  reconciliação pós-queda o delta sync fica **desligado** de propósito (para
  evitar deadlock), então o arquivo é reenviado **inteiro**; o delta só atua em
  edições ao vivo posteriores. Arquivos `.tmp` parciais são limpos
  automaticamente.
- Normalização Unicode: a **chave lógica** de cada caminho é normalizada para
  **NFC** na comparação/manifesto/protocolo, de modo que o mesmo nome em NFC
  (Linux/Windows) e NFD (macOS) seja tratado como **um único arquivo** e não
  divirja. Os **bytes do nome no disco são preservados** (não há renomeação
  forçada NFC→NFD). O app também **avisa** sobre colisões de maiúsculas/acentos.
