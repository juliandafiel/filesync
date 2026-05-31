// Detecta conexão WebSocket morta via ping/pong.
//
// A cada intervalMs enviamos ws.ping(). Consideramos a conexão VIVA com base em
// QUALQUER atividade: pong recebido, mensagem recebida, OU dados ainda no buffer
// de saída (transferência em andamento). Isso evita falso-positivo durante um
// envio grande por túnel lento — onde o frame de ping fica preso atrás dos dados
// no buffer e o pong demora a voltar. Só após timeoutMs SEM nenhuma atividade e
// COM o buffer vazio é que a conexão é dada como morta (onDead uma única vez).
export function startKeepalive(ws, { intervalMs = 15000, timeoutMs = 40000, onDead } = {}) {
  let lastAlive = Date.now();
  let dead = false; // garante que onDead dispare no máximo uma vez

  const alive = () => { lastAlive = Date.now(); };
  const onPong = () => alive();
  const onMessage = () => alive(); // qualquer frame recebido = conexão viva
  ws.on('pong', onPong);
  ws.on('message', onMessage);

  const interval = setInterval(() => {
    const idle = Date.now() - lastAlive > timeoutMs;
    const sending = (ws.bufferedAmount || 0) > 0; // dados em trânsito = vivo
    if (idle && !sending) {
      if (!dead) {
        dead = true;
        stop();
        if (typeof onDead === 'function') onDead();
      }
      return;
    }
    if (sending) alive(); // enquanto envia, renova o relógio de vida
    ws.ping();
  }, intervalMs);
  if (typeof interval.unref === 'function') interval.unref();

  // Remove o timer e os listeners; idempotente.
  function stop() {
    clearInterval(interval);
    ws.removeListener('pong', onPong);
    ws.removeListener('message', onMessage);
  }

  return stop;
}
