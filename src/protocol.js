// Tipos de mensagem e framing do protocolo de sincronização.
//
// O canal é um único WebSocket. Mensagens de controle viajam como frames de
// TEXTO (JSON). O conteúdo dos arquivos viaja como frames BINÁRIOS, cada um
// prefixado por um cabeçalho de 4 bytes (uint32 BE) com o transferId, para
// associar o chunk ao arquivo correto mesmo com transferências intercaladas.

export const MSG = {
  HELLO: 'hello',
  MANIFEST: 'manifest',
  FILE_BEGIN: 'file-begin',
  FILE_END: 'file-end',
  DELETE: 'delete',
  MKDIR: 'mkdir',     // criar diretório (inclusive vazio)
  RMDIR: 'rmdir',     // remover diretório vazio
  RENAME: 'rename',   // mover arquivo sem retransferir conteúdo
  DELTA_REQ: 'delta-req', // pede a assinatura (rsync) do arquivo antigo do peer
  SIG: 'sig',         // resposta: assinatura por blocos do arquivo antigo
  DELTA: 'delta',     // ops (copiar bloco / dados literais) para reconstruir
  REJECT: 'reject',
  // ACK/NACK fim-a-fim: o RECEPTOR confirma (ACK) ou recusa (NACK) uma escrita.
  // Sem isto, o remetente marcava peerManifest otimista mesmo quando o receptor
  // rejeitava (disco cheio, erro de escrita, hash divergente, versão local mais
  // nova) — peerManifest mentia e o arquivo não era reenviado. Ver sync-engine.js.
  ACK: 'ack',
  NACK: 'nack',
};

export const PROTOCOL_VERSION = 1;

// Cabeçalho binário: 4 bytes (uint32 BE) = transferId, resto = bytes do chunk.
export function encodeChunk(transferId, chunk) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(transferId, 0);
  return Buffer.concat([header, chunk]);
}

export function decodeChunk(buf) {
  const transferId = buf.readUInt32BE(0);
  const data = buf.subarray(4);
  return { transferId, data };
}
