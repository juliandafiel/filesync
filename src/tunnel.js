// Provider de túnel. Devolve sempre { url, close, onError }.
//
// Selecionável por variável de ambiente FILESYNC_TUNNEL:
//   - "localtunnel" (padrão): usa a lib localtunnel, sem binário externo.
//   - "cloudflared": usa o binário `cloudflared` (quick tunnel *.trycloudflare.com).
//
// Use cloudflared quando o loca.lt for bloqueado pela rede (ex: firewalls
// corporativos que classificam loca.lt como "anonymizer"). O binário precisa
// estar no PATH ou apontado por CLOUDFLARED_BIN.
import localtunnel from 'localtunnel';
import { spawn } from 'node:child_process';

// Abre um túnel público para a porta local e devolve { url, close, onError }.
export async function openTunnel(port) {
  const provider = (process.env.FILESYNC_TUNNEL || 'localtunnel').toLowerCase();
  if (provider === 'cloudflared') return openCloudflared(port);
  return openLocaltunnel(port);
}

async function openLocaltunnel(port) {
  const tunnel = await localtunnel({ port });
  return {
    url: tunnel.url, // ex: https://abc.loca.lt
    close: () => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, 3000); // não trava se 'close' não disparar
      tunnel.once('close', finish);
      tunnel.close();
    }),
    onError: (cb) => tunnel.on('error', cb),
  };
}

// cloudflared imprime a URL do quick tunnel no stderr, dentro de uma "caixa".
// Capturamos a primeira *.trycloudflare.com e resolvemos com ela.
function openCloudflared(port) {
  const bin = process.env.CLOUDFLARED_BIN || 'cloudflared';
  const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let resolved = false;
    let buf = '';
    const errHandlers = []; // preenchido por onError() após o resolve

    const timer = setTimeout(() => {
      if (resolved) return;
      proc.kill('SIGKILL');
      reject(new Error('cloudflared não retornou uma URL em 30s (binário instalado e rede ok?)'));
    }, 30000);
    timer.unref?.();

    const onData = (d) => {
      if (resolved) return;
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (!m) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        url: m[0],
        close: () => new Promise((res) => {
          let done = false;
          const finish = () => { if (!done) { done = true; clearTimeout(t); res(); } };
          const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(); }, 3000);
          t.unref?.();
          proc.once('close', finish);
          proc.kill('SIGTERM');
        }),
        onError: (cb) => errHandlers.push(cb),
      });
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => {
      if (!resolved) { clearTimeout(timer); reject(e); }
      else errHandlers.forEach((cb) => cb(e));
    });
    proc.on('exit', (code) => {
      const e = new Error(`cloudflared encerrou (código ${code}) — o link expirou; reinicie o "share"`);
      if (!resolved) { clearTimeout(timer); reject(e); }
      else errHandlers.forEach((cb) => cb(e));
    });
  });
}
