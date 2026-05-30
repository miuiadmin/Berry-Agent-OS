export const PROTOCOL_VERSION = '1.0.0';
export const MIN_COMPATIBLE_VERSION = '1.0.0';

export const SERVER_CAPABILITIES = [
  'streaming',
  'backpressure',
  'schema_validation',
  'sequence_numbers',
  'ack',
] as const;

export type ServerCapability = (typeof SERVER_CAPABILITIES)[number];

export interface HandshakeResponse {
  type: 'handshake_ack';
  ok: boolean;
  protocolVersion: string;
  serverCapabilities: string[];
  error?: string;
}

export function isCompatible(clientVersion: string): boolean {
  const [clientMajor] = clientVersion.split('.').map(Number);
  const [minMajor] = MIN_COMPATIBLE_VERSION.split('.').map(Number);
  if (Number.isNaN(clientMajor) || Number.isNaN(minMajor)) return false;
  return clientMajor >= minMajor;
}

export function createHandshakeResponse(clientVersion: string): HandshakeResponse {
  if (!isCompatible(clientVersion)) {
    return {
      type: 'handshake_ack',
      ok: false,
      protocolVersion: PROTOCOL_VERSION,
      serverCapabilities: [...SERVER_CAPABILITIES],
      error: `Incompatible protocol version ${clientVersion}. Minimum: ${MIN_COMPATIBLE_VERSION}`,
    };
  }
  return {
    type: 'handshake_ack',
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    serverCapabilities: [...SERVER_CAPABILITIES],
  };
}
