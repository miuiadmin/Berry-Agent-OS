/**
 * app — 应用商店服务面测试（第八十五批批 F，契约篇 §6.12）。
 *
 * 测法：真实临时目录（dataDir + 用户技能层双 tempdir——机器层全真：skill-store
 * 纯 fs+账本、overlay 走 saveOverlayRows 真往返）+ apps/skills 两窄面假身
 * （记账 + configure 落真盘）。精选载荷用随包真资产（apps/store-catalog）——
 * 清单形状与载荷完整性一并锁。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoreService, catalogSkillPayloadDir, STORE_APP_ID } from './store-app.js';
import { loadOverlayRows, saveOverlayRows } from './composition.js';
import { skillInstallSnapshot } from './skill-store.js';

/** 建临时目录束（dataDir + 用户技能层——每测试独立） */
function makeDirs(): { dataDir: string; userSkillsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'store-app-test-'));
  const dataDir = join(root, 'data');
  const userSkillsDir = join(root, 'skills');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(userSkillsDir, { recursive: true });
  return { dataDir, userSkillsDir };
}

/** apps 窄面假身：list 记账可换值；configure 真落 overlay 盘（mcp 合并语义走真文件往返） */
function makeApps(initialRows: readonly { id: string; status: string }[] = []) {
  const calls: string[] = [];
  let rows = [...initialRows];
  const apps = {
    async install(ref: string): Promise<{ id: string; message: string }> {
      calls.push(`install:${ref}`);
      rows = [...rows, { id: 'tool-echo', status: 'installed-unmounted' }];
      return { id: 'tool-echo', message: `装机完成（${ref}）` };
    },
    async mount(
      installId: string,
      opts?: { apps?: readonly string[] },
    ): Promise<{ id: string; apps: string[]; message: string }> {
      calls.push(`mount:${installId}:${(opts?.apps ?? []).join('+')}`);
      rows = rows.map((row) => (row.id === installId ? { id: row.id, status: 'mounted' } : row));
      return { id: installId, apps: [...(opts?.apps ?? [])], message: '行已写入' };
    },
    list(): readonly { id: string; status: string }[] {
      return rows;
    },
    async configure(id: string, patch: Readonly<Record<string, unknown>>): Promise<{ message: string }> {
      calls.push(`configure:${id}:${JSON.stringify(patch)}`);
      // 整值替换语义的真身半边：overlay 行集替换写回（mcp 行 config 整值换）
      const current = loadOverlayRows(dataDirHolder.dir);
      const next = current.filter((row) => row.id !== id);
      next.push({ id, config: { ...patch } } as (typeof current)[number]);
      saveOverlayRows(dataDirHolder.dir, next);
      return { message: '配置已写入' };
    },
  };
  /** dataDir 迟绑定槽（configure 需要真 dataDir——构造序先于目录束返回） */
  const dataDirHolder = { dir: '' };
  return {
    apps,
    calls,
    dataDirHolder,
    setRows: (next: readonly { id: string; status: string }[]) => (rows = [...next]),
  };
}

/** skills 窄面假身：refresh 记账（生效面编舞的断言锚） */
function makeSkills(): { face: { refresh(): void }; refreshCount(): number } {
  let count = 0;
  return { face: { refresh: () => void (count += 1) }, refreshCount: () => count };
}

/** 组装被测服务（真实目录 + 假窄面） */
function makeService(dirs: ReturnType<typeof makeDirs>) {
  const appsMade = makeApps();
  appsMade.dataDirHolder.dir = dirs.dataDir;
  const skills = makeSkills();
  const service = createStoreService({
    dataDir: dirs.dataDir,
    userSkillsDir: dirs.userSkillsDir,
    apps: appsMade.apps,
    skills: skills.face,
  });
  return { service, apps: appsMade, skills };
}

/** sources.json 原文（provenance 键域第四形直证） */
function readSources(dataDir: string): Record<string, unknown> {
  const path = join(dataDir, 'apps', 'sources.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('store-app：清单与常量', () => {
  it('STORE_APP_ID 定值 store（宿主投影分流判据单源）', () => {
    expect(STORE_APP_ID).toBe('store');
  });

  it('catalog 三市场形状：技能三件四态 none / MCP 两件未配置 / 应用条目状态随装机面派生', () => {
    const dirs = makeDirs();
    const { service } = makeService(dirs);
    const catalog = service.catalog();
    expect(catalog.skills.map((s) => s.name)).toEqual(['commit-message', 'code-review', 'release-notes']);
    expect(catalog.skills.every((s) => s.reviewed === true && s.state === 'none' && s.payloadReady === true)).toBe(
      true,
    );
    expect(catalog.mcp.map((m) => m.name).sort()).toEqual(['context7', 'sequential-thinking']);
    expect(catalog.mcp.every((m) => m.configured === false)).toBe(true);
    expect(catalog.apps.map((a) => a.id)).toEqual(['tool-echo']);
    expect(catalog.apps[0]!.state).toBe('none');
    // apps 面有装机行 → 状态派生翻 installed（list 单真源的派生面）
    const { service: s2, apps: a2 } = makeService(makeDirs());
    a2.setRows([{ id: 'tool-echo', status: 'installed-unmounted' }]);
    expect(s2.catalog().apps[0]!.state).toBe('installed');
  });
});

describe('store-app：技能件独立通道（装机两态 + 三清 + user-owned 执法）', () => {
  it('安装 = staged 零生效：目录在 + provenance 键 skills/<名> 落账 + 零 refresh（模型看不见）', async () => {
    const dirs = makeDirs();
    const { service, skills } = makeService(dirs);
    const result = await service.installSkill('commit-message');
    expect(typeof result).toBe('object');
    expect(existsSync(join(dirs.dataDir, 'apps', 'skills', 'commit-message', 'SKILL.md'))).toBe(true);
    expect(readSources(dirs.dataDir)['skills/commit-message']).toBeDefined();
    expect(
      skillInstallSnapshot({ dataDir: dirs.dataDir, userSkillsDir: dirs.userSkillsDir }, 'commit-message').state,
    ).toBe('staged');
    expect(skills.refreshCount()).toBe(0); // 安装零生效——refresh 不触发
  });

  it('挂载 = 进用户技能层 + refresh 生效；卸挂载回仓库态', async () => {
    const dirs = makeDirs();
    const { service, skills } = makeService(dirs);
    await service.installSkill('code-review');
    await service.mountSkill('code-review');
    expect(existsSync(join(dirs.userSkillsDir, 'code-review', 'SKILL.md'))).toBe(true);
    expect(skills.refreshCount()).toBe(1); // 挂载即重扫（渐进披露面生效）
    expect(
      skillInstallSnapshot({ dataDir: dirs.dataDir, userSkillsDir: dirs.userSkillsDir }, 'code-review').state,
    ).toBe('mounted');
    await service.unmountSkill('code-review');
    expect(existsSync(join(dirs.userSkillsDir, 'code-review'))).toBe(false);
    expect(
      skillInstallSnapshot({ dataDir: dirs.dataDir, userSkillsDir: dirs.userSkillsDir }, 'code-review').state,
    ).toBe('staged');
    expect(skills.refreshCount()).toBe(2); // 卸挂载同样重扫
  });

  it('卸载三清：staged + 用户层副本 + 账本条目全清（snapshot 归 none）', async () => {
    const dirs = makeDirs();
    const { service } = makeService(dirs);
    await service.installSkill('release-notes');
    await service.mountSkill('release-notes');
    const result = await service.uninstallSkill('release-notes');
    expect(typeof result).toBe('object');
    expect(existsSync(join(dirs.dataDir, 'apps', 'skills', 'release-notes'))).toBe(false);
    expect(existsSync(join(dirs.userSkillsDir, 'release-notes'))).toBe(false);
    expect(readSources(dirs.dataDir)['skills/release-notes']).toBeUndefined();
    expect(
      skillInstallSnapshot({ dataDir: dirs.dataDir, userSkillsDir: dirs.userSkillsDir }, 'release-notes').state,
    ).toBe('none');
  });

  it('未装先挂拒（装机两态不可跳步）；user-owned 拒装（不覆盖用户自有内容）', async () => {
    const dirs = makeDirs();
    const { service } = makeService(dirs);
    const jump = await service.mountSkill('commit-message');
    expect(typeof jump).toBe('string'); // 账本无记录即拒
    // 用户层自有同名：安装检视与执行都拒
    mkdirSync(join(dirs.userSkillsDir, 'commit-message'), { recursive: true });
    writeFileSync(join(dirs.userSkillsDir, 'commit-message', 'SKILL.md'), '自有技能');
    const inspect = service.skillInstallInspect('commit-message');
    expect(typeof inspect).toBe('string');
    expect(inspect).toContain('不覆盖用户自有内容');
  });
});

describe('store-app：两段式披露（inspect 段 + provenance 面）', () => {
  it('技能安装检视：receipt 带 provenance/两态说明 + confirm 段（run 即安装）', async () => {
    const dirs = makeDirs();
    const { service } = makeService(dirs);
    const inspect = service.skillInstallInspect('commit-message');
    expect(typeof inspect).toBe('object');
    if (typeof inspect === 'object') {
      expect(inspect.lines.join('\n')).toContain('skills/commit-message');
      expect(inspect.lines.join('\n')).toContain('已审');
      expect(inspect.confirm).toBeDefined();
      const run = await inspect.confirm!.run();
      expect(typeof run).toBe('object'); // 确认段执行 = 安装回执
      expect(existsSync(join(dirs.dataDir, 'apps', 'skills', 'commit-message'))).toBe(true);
    }
  });

  it('技能卸载检视：三清披露 + confirm 段（run 即三清）', async () => {
    const dirs = makeDirs();
    const { service } = makeService(dirs);
    await service.installSkill('commit-message');
    const inspect = service.skillUninstallInspect('commit-message');
    expect(typeof inspect).toBe('object');
    if (typeof inspect === 'object') {
      expect(inspect.title).toContain('三清');
      expect(inspect.confirm).toBeDefined();
      await inspect.confirm!.run();
      expect(readSources(dirs.dataDir)['skills/commit-message']).toBeUndefined();
    }
  });

  it('精选外名词诚实拒（外源接入不做——§6.12 反目标）', () => {
    const { service } = makeService(makeDirs());
    expect(typeof service.skillInstallInspect('no-such-skill')).toBe('string');
    expect(typeof service.appInstallInspect('no-such-app')).toBe('string');
  });
});

describe('store-app：MCP 市场（servers 键合并写入/删键）', () => {
  it('添加走绝对路径执法 + 合并写入（既有键保留）+ 移除只删本键', async () => {
    const dirs = makeDirs();
    const { service, apps } = makeService(dirs);
    // 相对路径拒（v1 须绝对路径——commandHint 是参考非装机值）
    const rel = await service.addMcpServer('context7', 'npx -y @upstash/context7-mcp');
    expect(typeof rel).toBe('string');
    expect(rel).toContain('绝对路径');
    // 首键写入（configure 走真 overlay 往返）
    const add1 = await service.addMcpServer('context7', '/opt/bin/context7-mcp');
    expect(typeof add1).toBe('object');
    // 第二键写入——首键保留（合并语义经真文件往返验证）
    await service.addMcpServer('sequential-thinking', '/opt/bin/seq-mcp');
    const servers = (
      loadOverlayRows(dirs.dataDir).find((r) => r.id === 'mcp')?.config as { servers: Record<string, unknown> }
    ).servers;
    expect(Object.keys(servers).sort()).toEqual(['context7', 'sequential-thinking']);
    // 移除只删本键
    const remove = await service.removeMcpServer('context7');
    expect(typeof remove).toBe('object');
    const after = (
      loadOverlayRows(dirs.dataDir).find((r) => r.id === 'mcp')?.config as { servers: Record<string, unknown> }
    ).servers;
    expect(Object.keys(after)).toEqual(['sequential-thinking']);
    // 幂等拒：再移除已删键诚实拒
    expect(typeof (await service.removeMcpServer('context7'))).toBe('string');
    expect(apps.calls.filter((c) => c.startsWith('configure:mcp:')).length).toBe(3); // 两增一删
  });

  it('服务器名词法执法（MCP_SERVER_NAME_PATTERN 同源）', async () => {
    const { service } = makeService(makeDirs());
    const bad = await service.addMcpServer('bad name!', '/abs/x');
    expect(typeof bad).toBe('string');
  });
});

describe('store-app：应用市场（appsService 既有管道单源）', () => {
  it('安装 = install 管道（仓库态零生效回执）+ 挂载 = mount 管道（写行）', async () => {
    const dirs = makeDirs();
    const { service, apps } = makeService(dirs);
    const inspect = service.appInstallInspect('tool-echo');
    expect(typeof inspect).toBe('object');
    if (typeof inspect === 'object') {
      const installed = await inspect.confirm!.run();
      expect(typeof installed).toBe('object');
      expect(apps.calls[0]).toMatch(/^install:.*tool-echo/); // 精选 local 直引解析为绝对路径
    }
    const mount = await service.mountApp('tool-echo', ['chat']);
    expect(typeof mount).toBe('object');
    expect(apps.calls.at(-1)).toBe('mount:tool-echo:chat');
    // 空目标拒
    expect(typeof (await service.mountApp('tool-echo', []))).toBe('string');
  });
});

describe('store-app：载荷完整性（随包真资产）', () => {
  it('精选技能载荷目录在包且含 SKILL.md', () => {
    for (const name of ['commit-message', 'code-review', 'release-notes']) {
      expect(existsSync(join(catalogSkillPayloadDir(name), 'SKILL.md'))).toBe(true);
    }
  });
});
