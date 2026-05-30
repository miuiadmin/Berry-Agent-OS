export interface BlocklistResult {
  blocked: boolean;
  reason?: string;
}

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/, reason: '禁止删除根目录' },
  { pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/($|\s)/, reason: '禁止递归删除根目录' },
  { pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/($|\s)/, reason: '禁止递归删除根目录' },
  { pattern: /mkfs\./, reason: '禁止格式化磁盘' },
  { pattern: /dd\s+.*of=\/dev\//, reason: '禁止直接写入设备' },
  { pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;?\s*:/, reason: '禁止 fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: '禁止写入块设备' },
  { pattern: /chmod\s+-R\s+777\s+\/($|\s)/, reason: '禁止全局权限修改' },
  { pattern: /curl\s+.*\|\s*(sudo\s+)?bash/, reason: '禁止从网络管道执行脚本' },
  { pattern: /wget\s+.*\|\s*(sudo\s+)?bash/, reason: '禁止从网络管道执行脚本' },
  { pattern: /shred\s+/, reason: '禁止 shred 销毁文件' },
  { pattern: /wipefs\s+/, reason: '禁止擦除文件系统签名' },
];

const FAST_SAFE = /^[a-zA-Z0-9 _.-]+$/;

export function checkBlocklist(command: string): BlocklistResult {
  if (command.length < 4 || FAST_SAFE.test(command)) {
    return { blocked: false };
  }

  const fragments = normalizeCommand(command);
  for (const fragment of fragments) {
    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(fragment)) {
        return { blocked: true, reason };
      }
    }
  }
  return { blocked: false };
}

export function normalizeCommand(command: string): string[] {
  const fragments: string[] = [command];

  const splitFragments = splitOnOperators(command);
  for (const frag of splitFragments) {
    fragments.push(frag);
  }

  const unwrapped = unwrapShellWrappers(command);
  for (const u of unwrapped) {
    fragments.push(u);
    for (const sub of splitOnOperators(u)) {
      fragments.push(sub);
    }
  }

  const substitutions = extractSubstitutions(command);
  for (const sub of substitutions) {
    fragments.push(sub);
  }

  const normalized = fragments.map(stripObfuscation);
  return [...new Set([...fragments, ...normalized])];
}

function splitOnOperators(cmd: string): string[] {
  return cmd.split(/\s*(?:;|&&|\|\||(?<!\|)\|(?!\|))\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

function unwrapShellWrappers(cmd: string): string[] {
  const results: string[] = [];
  const wrapperPattern = /(?:bash|sh|zsh|env\s+(?:bash|sh|zsh))\s+-c\s+(['"])(.*?)\1/g;
  let match;
  while ((match = wrapperPattern.exec(cmd)) !== null) {
    results.push(match[2]);
  }

  const unquotedWrapper = /(?:bash|sh|zsh|env\s+(?:bash|sh|zsh))\s+-c\s+(\S+)/g;
  while ((match = unquotedWrapper.exec(cmd)) !== null) {
    if (!match[1].startsWith("'") && !match[1].startsWith('"')) {
      results.push(match[1]);
    }
  }

  const evalPattern = /eval\s+(['"])(.*?)\1/g;
  while ((match = evalPattern.exec(cmd)) !== null) {
    results.push(match[2]);
  }

  return results;
}

function extractSubstitutions(cmd: string): string[] {
  const results: string[] = [];

  const dollarParen = /\$\(([^)]+)\)/g;
  let match;
  while ((match = dollarParen.exec(cmd)) !== null) {
    results.push(match[1]);
  }

  const backtick = /`([^`]+)`/g;
  while ((match = backtick.exec(cmd)) !== null) {
    results.push(match[1]);
  }

  return results;
}

function stripObfuscation(fragment: string): string {
  let s = fragment;
  s = s.replace(/\\(.)/g, '$1');
  s = s.replace(/(?<=\s|^)(['"])(\S+?)\1/g, '$2');
  s = s.replace(/\/(?:usr\/(?:local\/)?)?(?:s?bin)\//g, '');
  s = s.replace(/\bsudo\s+/g, '');
  return s;
}
