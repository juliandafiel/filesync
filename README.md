# filesync

Sincronizador de **uma pasta** em tempo real entre dois PCs, estilo "Google Drive
desktop" mas minimalista: você compartilha uma pasta e gera um **link**; o outro
PC usa o link para entrar. Toda alteração feita de um lado é refletida no outro.

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
- **Deleções offline** não são detectadas: se você apagar um arquivo com o app
  desligado, ele pode ser ressuscitado pelo outro lado na próxima conexão. Apague
  com o app rodando para a deleção propagar.
- Symlinks são ignorados nesta versão.
- O túnel padrão (`localtunnel`) usa um serviço público gratuito; para algo mais
  robusto, dá para trocar o provider em `src/tunnel.js` (ex: `cloudflared`).
  A criptografia E2E protege o conteúdo mesmo que o túnel seja não-confiável.
- **Retomada de transferência interrompida** ainda não é feita no meio do arquivo:
  se a conexão cair durante um envio grande, ele recomeça (mitigado pelo delta
  sync, que reenvia só os blocos faltantes na próxima vez). Arquivos `.tmp`
  parciais são limpos automaticamente.
- Normalização Unicode (NFC/NFD) não é forçada para não quebrar nomes
  byte-exatos no Linux; o app **avisa** sobre colisões de maiúsculas/acentos.
