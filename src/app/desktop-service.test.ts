/**
 * app — 桌面服务面测试（第八十五批批 C，契约篇 §6.11）。
 *
 * holder 语义（壳后端与服务消费方的解耦点）：attach 挂 face / detach 摘 /
 * backToDesktop 路由到在挂 face；未挂面诚实拒绝（ok:false）不炸。
 * 附零引擎静态声明：desktop-service.ts（Ring 1 行装载体）不 import src/desktop/
 * 任何件——引擎与壳后端都不入行，行只装服务面（拓扑面之外的文本面执法）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopApp, createDesktopService } from './desktop-service.js';
import type { BuiltinAppModule } from '../contracts/app.js';

describe('createDesktopService holder（服务面三动词）', () => {
  it('未挂 face：backToDesktop 诚实拒绝（ok:false——不炸不静默）', () => {
    const service = createDesktopService();
    const result = service.backToDesktop();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('桌面');
  });

  it('attach 后路由：backToDesktop 直通 face 同款回执；detach 后恢复拒绝', () => {
    const service = createDesktopService();
    const face = { backToDesktop: vi.fn(() => ({ ok: true as const })) };
    service.attach(face);
    expect(service.backToDesktop()).toEqual({ ok: true });
    expect(face.backToDesktop).toHaveBeenCalledTimes(1);
    service.detach();
    expect(service.backToDesktop().ok).toBe(false);
    expect(face.backToDesktop).toHaveBeenCalledTimes(1); // detach 后不再路由
  });

  it('attach 幂等替换：二次 attach 以最后挂者为准（新壳接管旧壳的形态）', () => {
    const service = createDesktopService();
    const first = { backToDesktop: vi.fn(() => ({ ok: true as const })) };
    const second = { backToDesktop: vi.fn(() => ({ ok: false as const, error: '新壳未起屏' })) };
    service.attach(first);
    service.attach(second);
    expect(service.backToDesktop().ok).toBe(false); // 第二个 face 的回执
    expect(first.backToDesktop).not.toHaveBeenCalled();
  });
});

describe('createDesktopApp（Ring 1 desktop 行装载体）', () => {
  it('零依赖件形态：name=desktop、apply provide desktop 服务（scope 真跑）', async () => {
    const app: BuiltinAppModule = createDesktopApp();
    expect(app.name).toBe('desktop');
    // 最小 scope 探针：provide 落名可 tryGet（真实装载序在 assembly 全栈锁——
    // 此处锁行 apply 的 provide 键与值形态；回卷由 ctx 作用域 LIFO 面（context
    // 模块）自担，apply 本体无返回）
    const provided: Array<[string, unknown]> = [];
    const scope = {
      provide: (key: string, value: unknown) => {
        provided.push([key, value]);
      },
    };
    const result = app.apply(scope as never);
    expect(result).toBeUndefined();
    expect(provided).toHaveLength(1);
    expect(provided[0]![0]).toBe('desktop');
    expect(typeof (provided[0]![1] as { backToDesktop: unknown }).backToDesktop).toBe('function');
  });

  it('零引擎声明：desktop-service.ts 不 import src/desktop/ 任何件（行装载体纯服务面）', () => {
    // 批 C 摆位执法：Ring 1 行只装服务 holder——引擎（src/desktop/）与壳后端
    // （desktop-shell.ts，宿主入口侧）都不入行；装载失败不连坐渲染栈
    const source = readFileSync(new URL('./desktop-service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+'\.\.\/desktop\//);
    expect(source).not.toMatch(/import\s+.*desktop\/(engine|index|components)/);
  });
});
