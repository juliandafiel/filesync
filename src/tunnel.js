// Provider de túnel. Padrão: localtunnel (sem binário externo).
// Estruturado para permitir trocar de provider depois (ex: cloudflared).
import localtunnel from 'localtunnel';

// Abre um túnel público para a porta local e devolve { url, close }.
export async function openTunnel(port) {
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
