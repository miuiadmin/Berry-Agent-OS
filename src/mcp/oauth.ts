import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthConfig } from './contract.js';
import type { EventBus } from '../contracts/infrastructure.js';
import { getAppHome } from '../utils/paths.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('mcp-oauth');

// ─── Token Storage ──────────────────────────────────────────────

interface StoredAuth {
  tokens?: { accessToken: string; refreshToken?: string; expiresAt?: number };
  clientInfo?: { clientId: string; clientSecret?: string; expiresAt?: number };
  codeVerifier?: string;
  state?: string;
  metadata?: Record<string, unknown>;
}

function getAuthDir(): string {
  const dir = join(getAppHome(), 'mcp-auth');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function getAuthPath(serverName: string): string {
  return join(getAuthDir(), `${serverName}.json`);
}

function loadAuth(serverName: string): StoredAuth {
  const path = getAuthPath(serverName);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAuth(serverName: string, auth: StoredAuth): void {
  const path = getAuthPath(serverName);
  writeFileSync(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

// ─── OAuth Provider ─────────────────────────────────────────────

export class McpOAuthProvider implements OAuthClientProvider {
  private auth: StoredAuth;
  private lastMtime = 0;
  private _codeVerifier: string;
  private _state: string;

  constructor(
    private readonly serverName: string,
    private readonly config: McpOAuthConfig,
    private readonly callbackServer: OAuthCallbackServer,
    private readonly eventBus?: EventBus,
  ) {
    this.auth = loadAuth(serverName);
    this._codeVerifier = this.auth.codeVerifier ?? randomBytes(32).toString('base64url');
    this._state = this.auth.state ?? randomBytes(16).toString('base64url');
    this.updateMtime();
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.config.redirectPort}/mcp/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'BerryAgent',
      client_uri: 'https://github.com/berryagent',
    };
  }

  clientInformation() {
    if (this.config.clientId) {
      return { client_id: this.config.clientId, client_secret: this.config.clientSecret };
    }
    return this.auth.clientInfo
      ? { client_id: this.auth.clientInfo.clientId, client_secret: this.auth.clientInfo.clientSecret }
      : undefined;
  }

  async saveClientInformation(info: { client_id: string; client_secret?: string }) {
    this.auth.clientInfo = {
      clientId: info.client_id,
      clientSecret: info.client_secret,
    };
    this.persist();
  }

  tokens() {
    this.checkExternalRefresh();
    const t = this.auth.tokens;
    if (!t) return undefined;
    if (t.expiresAt && Date.now() > t.expiresAt) return undefined;
    return { access_token: t.accessToken, token_type: 'bearer', refresh_token: t.refreshToken };
  }

  async saveTokens(tokens: { access_token: string; token_type: string; refresh_token?: string; expires_in?: number }) {
    this.auth.tokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    };
    this.persist();
  }

  codeVerifier() {
    return this._codeVerifier;
  }

  async saveCodeVerifier(codeVerifier: string) {
    this._codeVerifier = codeVerifier;
    this.persist();
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    const url = authorizationUrl.toString();
    logger.info({ serverName: this.serverName, url }, 'MCP OAuth: 请在浏览器中授权');
    this.eventBus?.emit('mcp.auth_required', { serverName: this.serverName, authUrl: url });
    openBrowser(url);
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'tokens' || scope === 'all') {
      delete this.auth.tokens;
    }
    if (scope === 'client' || scope === 'all') {
      delete this.auth.clientInfo;
    }
    if (scope === 'verifier' || scope === 'all') {
      this._codeVerifier = randomBytes(32).toString('base64url');
    }
    this.persist();
  }

  private persist(): void {
    this.auth.codeVerifier = this._codeVerifier;
    this.auth.state = this._state;
    saveAuth(this.serverName, this.auth);
    this.updateMtime();
  }

  private updateMtime(): void {
    try {
      const path = getAuthPath(this.serverName);
      if (existsSync(path)) {
        this.lastMtime = statSync(path).mtimeMs;
      }
    } catch { /* ignore */ }
  }

  private checkExternalRefresh(): void {
    try {
      const path = getAuthPath(this.serverName);
      if (!existsSync(path)) return;
      const currentMtime = statSync(path).mtimeMs;
      if (currentMtime > this.lastMtime) {
        this.auth = loadAuth(this.serverName);
        this.lastMtime = currentMtime;
        logger.debug({ serverName: this.serverName }, 'OAuth token 已被外部刷新');
      }
    } catch { /* ignore */ }
  }
}

// ─── OAuth Callback Server ──────────────────────────────────────

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OAuthCallbackServer {
  private server: Server | null = null;
  private pending = new Map<string, PendingAuth>();

  constructor(private readonly port: number = 19876) {}

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

      if (url.pathname !== '/mcp/oauth/callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (!state || !this.pending.has(state)) {
        res.writeHead(400);
        res.end('Invalid or expired state parameter');
        return;
      }

      const entry = this.pending.get(state)!;
      this.pending.delete(state);
      clearTimeout(entry.timer);

      if (error) {
        entry.reject(new Error(`OAuth error: ${error}`));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>');
        return;
      }

      if (!code) {
        entry.reject(new Error('No authorization code received'));
        res.writeHead(400);
        res.end('Missing code');
        return;
      }

      entry.resolve(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authorization Successful</h1><p>You can close this window.</p></body></html>');
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        logger.debug({ port: this.port }, 'OAuth 回调服务器已启动');
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  waitForCallback(state: string, timeoutMs = 300_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(state);
        reject(new Error('OAuth 回调超时'));
      }, timeoutMs);

      this.pending.set(state, { resolve, reject, timer });
    });
  }

  stop(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('OAuth 服务器关闭'));
    }
    this.pending.clear();
    this.server?.close();
    this.server = null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) logger.warn({ err, url }, '无法自动打开浏览器，请手动访问');
  });
}
