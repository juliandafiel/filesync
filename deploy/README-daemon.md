# Rodando o filesync em segundo plano (always-on)

Duas opcoes: o daemon embutido (`src/daemon.js`) ou systemd.

## Opcao A: daemon embutido

O modulo `src/daemon.js` faz spawn de um processo node destacado rodando
`bin/cli.js`, redireciona a saida para um log (append) e grava o PID num
arquivo de PID. O processo continua vivo mesmo apos o terminal fechar.

```js
import { startDetached, stopDaemon, daemonStatus } from './src/daemon.js';

const pidFile = '/tmp/filesync.pid';
const logFile = '/tmp/filesync.log';

// inicia (ex.: compartilhar uma pasta)
const pid = startDetached({ args: ['share', '/home/jaco/sync'], logFile, pidFile });
console.log('rodando em', pid);

// checar estado
daemonStatus(pidFile); // { running: true, pid }

// parar
stopDaemon(pidFile);   // true se matou, false se nao havia processo
```

- `startDetached({ args, logFile, pidFile })` -> retorna o `pid`. Cria as
  pastas do log/pid se preciso, abre o log em append e chama `child.unref()`.
- `stopDaemon(pidFile)` -> `true` se havia um processo e ele foi sinalizado,
  `false` se nao havia (ou ja tinha saido). Sempre remove o pidFile.
- `daemonStatus(pidFile)` -> `{ running, pid }`, usando `process.kill(pid, 0)`.

## Opcao B: systemd (recomendado para always-on de verdade)

Use o template `deploy/filesync.service`, substituindo os placeholders:

- `<PASTA>` = caminho absoluto da pasta sincronizada.
- `<LINK_OU_ARGS>` = args do CLI, ex.: `share /home/jaco/sync` ou
  `join https://meu-link.loca.lt /home/jaco/sync`.

### Modo usuario (sem root)

```sh
mkdir -p ~/.config/systemd/user
cp deploy/filesync.service ~/.config/systemd/user/filesync.service
# edite os placeholders
systemctl --user daemon-reload
systemctl --user enable --now filesync
loginctl enable-linger "$USER"   # mantem rodando apos logout
journalctl --user -u filesync -f # acompanhar logs
```

### Modo sistema (root)

```sh
sudo cp deploy/filesync.service /etc/systemd/system/filesync.service
# edite os placeholders (e considere User=)
sudo systemctl daemon-reload
sudo systemctl enable --now filesync
journalctl -u filesync -f
```
