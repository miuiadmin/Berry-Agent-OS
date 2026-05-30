import { describe, it, expect } from 'vitest';
import {
  isCompatible,
  createHandshakeResponse,
  PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
} from './protocol-version.js';

describe('Protocol versioning', () => {
  describe('isCompatible', () => {
    it('same version is compatible', () => {
      expect(isCompatible('1.0.0')).toBe(true);
    });

    it('higher major is compatible', () => {
      expect(isCompatible('2.0.0')).toBe(true);
    });

    it('same major, higher minor is compatible', () => {
      expect(isCompatible('1.5.0')).toBe(true);
    });

    it('lower major is incompatible', () => {
      expect(isCompatible('0.9.0')).toBe(false);
    });

    it('invalid version string is incompatible', () => {
      expect(isCompatible('abc')).toBe(false);
      expect(isCompatible('')).toBe(false);
    });
  });

  describe('createHandshakeResponse', () => {
    it('returns ok=true for compatible version', () => {
      const resp = createHandshakeResponse('1.0.0');
      expect(resp.ok).toBe(true);
      expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(resp.serverCapabilities).toEqual([...SERVER_CAPABILITIES]);
      expect(resp.error).toBeUndefined();
    });

    it('returns ok=false for incompatible version', () => {
      const resp = createHandshakeResponse('0.1.0');
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('Incompatible');
      expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it('type is always handshake_ack', () => {
      expect(createHandshakeResponse('1.0.0').type).toBe('handshake_ack');
      expect(createHandshakeResponse('0.0.1').type).toBe('handshake_ack');
    });
  });
});
