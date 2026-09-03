/**
 * DEP 废弃登记簿不变式锁（契约篇 §6.13.6/§6.13.7，第八十七批批 3）。
 *
 * 现役空册——本套测试**空转锁**注册簿形状不变式：迭代 DEPRECATIONS 逐行执法，
 * 首条真实废弃登记日起本套自动生效（机制常驻）。词汇登记效果（reserved 词入
 * SessionEvent 目录）即刻实锁。
 */
import { describe, expect, it } from 'vitest';
import { compareApiVersions, isValidApiVersion } from './api.js';
import { DEP_ID_FORMAT, DEPRECATIONS } from './deprecations.js';
import { listSessionEventTypes } from './session-events.js';

describe('DEP 注册簿不变式（空转锁——首条登记日起实锁）', () => {
  it('每行 DEP 编号格式合法且全册唯一', () => {
    const seen = new Set<string>();
    for (const entry of DEPRECATIONS) {
      // 格式：DEP- 三位数字（§6.13.6 编号唯一）
      expect(DEP_ID_FORMAT.test(entry.dep), `DEP 编号格式非法：${entry.dep}`).toBe(true);
      // 唯一：注册簿是删除合法性的唯一凭证，重复编号 = 凭证歧义
      expect(seen.has(entry.dep), `DEP 编号重复：${entry.dep}`).toBe(false);
      seen.add(entry.dep);
    }
  });

  it('symbol 字段为 module::symbol 坐标形（两段非空）', () => {
    for (const entry of DEPRECATIONS) {
      // 与 check-api/快照 keyOf 同键形——join 键形态错即对照面全灭
      const parts = entry.symbol.split('::');
      expect(parts.length, `symbol 应为 module::symbol 两段：${entry.symbol}`).toBe(2);
      expect(parts[0]!.length > 0, `symbol 模块段为空：${entry.symbol}`).toBe(true);
      expect(parts[1]!.length > 0, `symbol 符号段为空：${entry.symbol}`).toBe(true);
    }
  });

  it('introducedIn/removalIn 均为合法 apiVersion（MAJOR.MINOR）', () => {
    for (const entry of DEPRECATIONS) {
      expect(isValidApiVersion(entry.introducedIn), `introducedIn 格式非法：${entry.introducedIn}`).toBe(true);
      expect(isValidApiVersion(entry.removalIn), `removalIn 格式非法：${entry.removalIn}`).toBe(true);
    }
  });

  it('废弃窗 ≥ 3 个 minor 且同 MAJOR（拍板⑤：窗口 = 3 minor）', () => {
    for (const entry of DEPRECATIONS) {
      const [iMajor, iMinor] = entry.introducedIn.split('.').map(Number) as [number, number];
      const [rMajor] = entry.removalIn.split('.').map(Number) as [number, number];
      // 跨 MAJOR 的删除走大版本收剑（§6.13.6 两级架构），不走代内废弃窗
      expect(rMajor, `${entry.dep}：废弃窗不得跨 MAJOR`).toBe(iMajor);
      // removalIn ≥ introducedIn + 3 minor（数值比较经 compareApiVersions 同语义）
      expect(
        compareApiVersions(entry.removalIn, `${iMajor}.${iMinor + 3}`) >= 0,
        `${entry.dep}：废弃窗不足 3 minor（${entry.introducedIn} → ${entry.removalIn}）`,
      ).toBe(true);
    }
  });

  it('replacement 恒非空（三色面的指引位——废弃不给替代 = 断头路）', () => {
    for (const entry of DEPRECATIONS) {
      expect(entry.replacement.length > 0, `${entry.dep}：replacement 不得为空`).toBe(true);
    }
  });
});

describe('废弃遥测词汇登记（§6.13.7）', () => {
  it('apps/deprecation-used 以 log-only + reserved 入 SessionEvent 目录', () => {
    // import 本模块即触发登记（模块装载序）——这里断言效果非副作用
    const def = listSessionEventTypes().find((d) => d.type === 'apps/deprecation-used');
    expect(def).toBeDefined();
    expect(def?.category).toBe('log-only');
    expect(def?.tier).toBe('stable');
    // reserved：宿主写点（批 4 废弃桥入口）缺席的显式豁免标记
    expect(def?.reserved).toBe(true);
  });
});
