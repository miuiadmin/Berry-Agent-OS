#!/usr/bin/env node
/**
 * CI 拓扑门禁（技术栈篇 §2.3 四件之一；内核篇 §4：18 模块单向 DAG——第十六批 goal 入册、
 * 2026-08-24 铭牌批 chat 件聚落入册、2026-08-25 exec 纵切入册）。
 *
 * 两条规则：
 * 1. 相对导入只允许走显式白名单边（模块 → 可依赖模块集合）；同模块内部互引自由。
 * 2. 裸导入（包名）按模块白名单放行；node:* 全模块放行。
 * 测试文件（*.test.ts）豁免跨模块检查（只许 import 本模块与 vitest），防止测试绕行。
 *
 * 边表对齐[内核与插件边界]篇 §4 模块表；模块落地时如与规范出入，以规范为准修本表。
 * 未落地的模块保留占位行——目录不存在即零检查，表先钉住方向。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 模块 → 允许 import 的其他模块（单向 DAG 白名单；同层仅 context 作为运行时基座可被引用） */
const MODULE_EDGES = {
  contracts: [],
  context: ['contracts'],
  session: ['contracts', 'context'],
  agent: ['contracts'],
  persist: ['contracts', 'context', 'session'],
  llm: ['contracts', 'context'],
  tools: ['contracts', 'context'],
  safety: ['contracts', 'context', 'session', 'tools'],
  skills: ['contracts', 'context'],
  subagent: ['contracts', 'context', 'agent', 'session'],
  // chat = 对话应用官方件聚落（铭牌批入册；不 import llm——StreamFn 经 contracts 注入）
  chat: ['contracts', 'context', 'agent', 'session', 'persist', 'tools', 'safety'],
  memory: ['contracts', 'context', 'session', 'persist'],
  goal: ['contracts', 'context', 'persist'],
  // exec = 工具族件聚落（第 18 模块，2026-08-25 exec 纵切；tools 不 import exec——
  // bash def 在组合根注册，检索族双装配点先例）
  exec: ['contracts', 'context', 'safety', 'tools'],
  scheduler: ['contracts', 'context', 'persist'],
  // mcp = stdio-only 客户端桥（2026-08-26 第一刀，契约篇 §6.6）：spawn/kill 经
  // 组合根闭包注入（app/mcp-spawn.ts）——结构上不见 exec/tools（冷读 #1）
  mcp: ['contracts', 'context'],
  // 历史投影经注入回调拉取（不依赖 session）；活体事件类型来自 agent 公开事件面
  channels: ['contracts', 'context', 'agent'],
  app: [
    'contracts',
    'context',
    'session',
    'agent',
    'persist',
    'llm',
    'tools',
    'safety',
    'skills',
    'subagent',
    'memory',
    'goal',
    'exec',
    'scheduler',
    'mcp',
    'channels',
    'chat',
  ],
};

/** 裸导入白名单：包名 → 允许引用它的模块（node:* 与测试专用包单独放行） */
const BARE_IMPORTS = {
  // context = 插件加载器（虚拟注入映射构造 + 行 config schema 校验 Value 面——契约篇 §1.2 落码注记③）
  typebox: ['contracts', 'context', 'tools', 'skills', 'safety', 'app', 'exec'],
  // berryagent = 加载器注入的虚拟模块名（非 npm 包；loader.test fixture 源码内的合法引用面）
  berryagent: ['context'],
  '@earendil-works/pi-ai': ['llm'],
  '@earendil-works/pi-tui': ['channels', 'app'],
  'better-sqlite3': ['persist'],
  yaml: ['app', 'skills'],
  ignore: ['skills', 'tools'], // tools = 检索族 gitignore 遍历（2026-08-25 检索族纵切；与 skills 同语义各自实现，第三消费者出现再议共享）
  jiti: ['context', 'app'],
};
const TEST_ONLY_BARE = new Set(['vitest']);

/** 递归收集 src 下全部 ts 文件 */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 提取文件中全部静态/动态 import 与 export-from 的说明符 */
function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** 文件所属模块（src 下第一级目录名；src 根不挂散文件——出现即报违规） */
function moduleOf(file) {
  const relativePath = file.slice(srcRoot.length + 1);
  const firstSegment = relativePath.split('/').at(0) ?? '';
  return firstSegment.endsWith('.ts') ? '(root-files)' : firstSegment;
}

const violations = [];
const seenModules = new Set();

for (const file of collect(srcRoot)) {
  const module = moduleOf(file);
  seenModules.add(module);
  const isTest = file.endsWith('.test.ts');
  const allowed = MODULE_EDGES[module];
  if (!allowed) {
    violations.push(`${relative(file)}：未知模块（不在 ${Object.keys(MODULE_EDGES).length} 模块白名单）`);
    continue;
  }

  for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('node:')) continue;

    if (spec.startsWith('.')) {
      // 相对导入：解析目标（NodeNext 源码以 .js 后缀指 .ts 文件——candidates 里做 .js→.ts 回替）
      const base = resolve(dirname(file), spec);
      const baseTs = base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : base;
      const candidates = [base, baseTs, `${base}.ts`, `${baseTs}.ts`, join(base, 'index.ts'), join(base, 'index.js')];
      const target = candidates.find((c) => {
        try {
          return statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!target) {
        violations.push(`${relative(file)}：相对导入无法解析 ${spec}`);
        continue;
      }
      const targetModule = moduleOf(target);
      if (targetModule === module) continue; // 同模块自由
      if (isTest) {
        if (module === '(root-files)' || MODULE_EDGES[module].includes(targetModule)) continue;
        violations.push(`${relative(file)}：测试文件跨模块引用 ${targetModule}（测试只许覆盖本模块）`);
        continue;
      }
      if (module !== '(root-files)' && !allowed.includes(targetModule)) {
        violations.push(
          `${relative(file)}：${module} → ${targetModule} 不在白名单边 ${allowed.join(', ') || '（无）'}`,
        );
      }
      continue;
    }

    // 裸导入：scoped 包归一到 @scope/name（子路径导入按包级白名单放行——同包 subpath 不算新依赖）
    const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/').at(0);
    if (TEST_ONLY_BARE.has(spec)) {
      if (!isTest) violations.push(`${relative(file)}：vitest 只许出现在测试文件`);
      continue;
    }
    const bareAllowed = BARE_IMPORTS[bare];
    if (!bareAllowed || !(bareAllowed.includes(module) || module === 'app')) {
      violations.push(`${relative(file)}：模块 ${module} 不允许裸导入 ${bare}`);
    }
  }
}

function relative(file) {
  return file.slice(srcRoot.length + 1);
}

if (violations.length > 0) {
  console.error(`拓扑检查未通过（${violations.length} 处违规）：`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `拓扑检查通过：${seenModules.size} 个模块（${[...seenModules].sort().join(', ')}），边表 ${Object.keys(MODULE_EDGES).length} 行`,
);
