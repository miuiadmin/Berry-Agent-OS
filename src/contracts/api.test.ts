/**
 * API 治理契约纯函数测试（契约篇 §6.13.4/§6.13.10，第八十七批批 2）。
 *
 * 覆盖面：版本比较语义（禁字符串比较）/ 装载门四出口 / experimental import
 * 门禁裁决核 / 能力需求执法核 / HostFace 数据物化。装载门与 loader/context 的
 * 接线测试住 app 层（api-gate.test.ts）与 context 层——本文件只锁纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import { API_CAPABILITY_MISSING, API_VERSION_MISMATCH, API_VERSION_MALFORMED } from './errors.js';
import {
  CAPABILITIES,
  VIRTUAL_API_KEYS,
  adjudicateApiGate,
  assertExperimentalDeclared,
  compareApiVersions,
  isValidApiVersion,
  materializeHostFace,
  requireCapabilities,
} from './api.js';

/** AppError 断言便利：判据在 .code（注册码），message 只是人读面 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('应抛 AppError');
  } catch (err) {
    expect((err as { code?: unknown }).code).toBe(code);
  }
}

describe('compareApiVersions：MAJOR.MINOR 逐段数值比较（§6.13.4——禁字符串比较）', () => {
  it('数值语义："1.10" > "1.9"（字符串比较会倒挂——本测是该陷阱的回归锁）', () => {
    expect(compareApiVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareApiVersions('1.9', '1.10')).toBeLessThan(0);
  });
  it('major 优先：2.0 > 1.99', () => {
    expect(compareApiVersions('2.0', '1.99')).toBeGreaterThan(0);
  });
  it('相等 → 0（含前导零归一："1.0" == "1.00"）', () => {
    expect(compareApiVersions('1.0', '1.0')).toBe(0);
    expect(compareApiVersions('1.0', '1.00')).toBe(0);
  });
  it('格式非法 → API_VERSION_MALFORMED 单点抛（"1" / "1.0.0" / "v1.0"）', () => {
    // AppError 判据在 .code（message 是人读面）——toThrowError(字符串) 只比 message
    for (const bad of ['1', '1.0.0', 'v1.0', '1.x', '']) {
      expectCode(() => compareApiVersions(bad, '1.0'), API_VERSION_MALFORMED);
      expectCode(() => compareApiVersions('1.0', bad), API_VERSION_MALFORMED);
    }
  });
});

describe('isValidApiVersion：格式判定（清单校验面复用体）', () => {
  it('合法："1.0" / "2.13" / "0.1"', () => {
    for (const ok of ['1.0', '2.13', '0.1']) expect(isValidApiVersion(ok)).toBe(true);
  });
  it('非法：三段 / 单段 / 前缀 / 空串', () => {
    for (const bad of ['1.0.0', '1', 'v1.0', '', '1.', '.0', 'a.b']) {
      expect(isValidApiVersion(bad)).toBe(false);
    }
  });
});

describe('adjudicateApiGate：装载门四出口（§6.13.4——纯函数，冷读 B2 裁决形态）', () => {
  it('出口 4：api 块缺席 → legacy（不拒载；生效 target = 宿主当前；零实验键）', () => {
    const gate = adjudicateApiGate(undefined, '1.0', 'demo/app');
    expect(gate.status).toBe('legacy');
    expect(gate.effectiveTarget).toBe('1.0');
    expect(gate.experimentalKeys.size).toBe(0);
  });
  it('出口 1：宿主 < min → API_VERSION_MISMATCH 拒载（message 载 expected/actual/升级指引三段）', () => {
    try {
      adjudicateApiGate({ minApiVersion: '1.2' }, '1.0', 'demo/app');
      expect.unreachable('宿主低于地板应拒载');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('minApiVersion 1.2');
      expect((err as Error).message).toContain('宿主 API 面版本 1.0');
      expect((err as Error).message).toContain('升级指引');
      expect(String((err as { code?: unknown }).code)).toBe(API_VERSION_MISMATCH);
    }
  });
  it('出口 2：min ≤ 宿主 < target → admit 钳制（生效 target = 宿主——「跟新」非缺省）', () => {
    const gate = adjudicateApiGate({ minApiVersion: '1.0', targetApiVersion: '1.5' }, '1.2', 'a');
    expect(gate.status).toBe('admit');
    expect(gate.effectiveTarget).toBe('1.2'); // min(宿主 1.2, target 1.5)
  });
  it('出口 3：宿主 > target → admit 兼容态（生效 target = target，不警示）', () => {
    const gate = adjudicateApiGate({ minApiVersion: '1.0', targetApiVersion: '1.1' }, '1.9', 'a');
    expect(gate.status).toBe('admit');
    expect(gate.effectiveTarget).toBe('1.1');
  });
  it('粘性锚：target 缺省 = min 时点面（不声明恒持 min——effectiveTarget = min）', () => {
    const gate = adjudicateApiGate({ minApiVersion: '1.0' }, '1.7', 'a');
    expect(gate.status).toBe('admit');
    expect(gate.effectiveTarget).toBe('1.0');
  });
  it('宿主 == min == 地板线 → admit（边界含等：低于才拒）', () => {
    const gate = adjudicateApiGate({ minApiVersion: '1.0' }, '1.0', 'a');
    expect(gate.status).toBe('admit');
  });
  it('experimental 声明集透传（loader import 门禁数据源）', () => {
    const gate = adjudicateApiGate({ minApiVersion: '1.0', experimental: ['berryagent'] }, '1.0', 'a');
    expect(gate.experimentalKeys.has('berryagent')).toBe(true);
    expect(gate.experimentalKeys.has('typebox')).toBe(false);
  });
});

describe('assertExperimentalDeclared：实验键 import 门禁裁决核（§6.13.4 执法点）', () => {
  it('键表外的说明符不属本门禁（白名单三道另辖）——零动作', () => {
    expect(() => assertExperimentalDeclared('node:fs', new Set(), undefined)).not.toThrowError();
  });
  it('stable 键不要求声明（门禁只辖实验键）——零动作', () => {
    // 现役六键全 stable（§6.13.3）；stable 键未声明也放行是设计而非缺口
    expect(() => assertExperimentalDeclared('berryagent', new Set(), 'a')).not.toThrowError();
  });
  it('实验键未声明 → API_EXPERIMENTAL_UNDECLARED（首实验键上线日此腿激活——结构性探针）', () => {
    // 现役零实验键：用 monkeypatch 临时改键表形状不可行（readonly 冻结源），
    // 改以断言「当前键表无 experimental 键」钉住前提——该前提翻false 时（首实验键
    // 落码）本测红，提醒补真抛出腿测试（骨架测同查 5 机制：机制常驻，生效日即执法日）
    const experimentalKeys = VIRTUAL_API_KEYS.filter((k) => k.tier === 'experimental');
    expect(experimentalKeys).toHaveLength(0);
  });
});

describe('requireCapabilities：能力需求执法核（§6.13.10——server 形装载器消费）', () => {
  it('全部在场 → 零动作', () => {
    expect(() =>
      requireCapabilities(['memory.store', 'web.fetch'], new Set(['memory.store', 'web.fetch']), 'standalone', 'a'),
    ).not.toThrowError();
  });
  it('缺席即 API_CAPABILITY_MISSING（message 载缺席清单与形态）', () => {
    try {
      requireCapabilities(['memory.store', 'web.fetch'], new Set(['memory.store']), 'server', 'a');
      expect.unreachable('能力缺席应拒');
    } catch (err) {
      expect(String((err as { code?: unknown }).code)).toBe(API_CAPABILITY_MISSING);
      expect((err as Error).message).toContain('web.fetch');
      expect((err as Error).message).toContain('server');
    }
  });
  it('空需求恒过（无声明 = 无约束）', () => {
    expect(() => requireCapabilities([], new Set(), 'standalone', 'a')).not.toThrowError();
  });
});

describe('materializeHostFace：数据快照物化（§6.13.5——宿主与 worker 对岸同构）', () => {
  const face = materializeHostFace({
    version: '1.0.0-alpha.3',
    apiVersion: '1.0',
    formFactor: 'daemon',
    capabilities: ['memory.store', 'web.fetch'],
    experimentalKeys: [],
  });
  it('capabilities.has/list：成员判定 + 清单拷贝（list 每次新数组——外部改动不回渗）', () => {
    expect(face.capabilities.has('memory.store')).toBe(true);
    expect(face.capabilities.has('subagent.delegate')).toBe(false);
    const a = face.capabilities.list();
    const b = face.capabilities.list();
    expect(a).toEqual(['memory.store', 'web.fetch']);
    expect(a).not.toBe(b); // 拷贝非同一引用
  });
  it('experimental.enabled：键集成员判定', () => {
    expect(face.experimental.enabled('berryagent')).toBe(false);
  });
  it('标量三字段直读', () => {
    expect(face.version).toBe('1.0.0-alpha.3');
    expect(face.apiVersion).toBe('1.0');
    expect(face.formFactor).toBe('daemon');
  });
});

describe('目录真相源形状锁（§6.13.3——tier/since/formFactors 逐条完备）', () => {
  it('VIRTUAL_API_KEYS：六键全 stable + since 合法 + 全形态（「现役六键全 stable」拍板句的字面锁）', () => {
    expect(VIRTUAL_API_KEYS).toHaveLength(6);
    for (const k of VIRTUAL_API_KEYS) {
      expect(k.tier).toBe('stable');
      expect(isValidApiVersion(k.since)).toBe(true);
      expect(k.formFactors).toContain('standalone');
      expect(k.formFactors).toContain('daemon');
      expect(k.formFactors).toContain('server');
    }
  });
  it('CAPABILITIES：能力名唯一 + formFactors 非空 + 提供者行籍格式（builtin: 前缀）', () => {
    const names = CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length); // 能力名撞名 = 目录自破
    for (const c of CAPABILITIES) {
      expect(c.formFactors.length).toBeGreaterThan(0);
      expect(c.providedBy.startsWith('builtin:')).toBe(true);
    }
  });
});
