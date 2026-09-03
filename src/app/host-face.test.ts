/**
 * 宿主自省面构建器测试（API 治理 §6.13.5，第八十七批批 2）。
 *
 * 锁三件：readHostVersionFields 包根真读 + 失格 fail-loud + 进程内缓存；
 * readHostFaceData 形态过滤（capabilities 按形态、experimentalKeys = 键表
 * experimental 子集）；buildHostFace 物化产物 = m5 桥接纪律可过桥形态（纯 JSON
 * 数据底座——对岸 materializeHostFace 同构重建）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, VIRTUAL_API_KEYS, materializeHostFace } from '../contracts/api.js';
import { buildHostFace, readHostFaceData, readHostVersionFields } from './host-face.js';

/** 包根 package.json（测试自读对照——锚定「宿主面真读包根」而非复述字面量） */
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')) as {
  version: string;
  apiVersion: string;
};

describe('readHostVersionFields：包根真读 + 失格 fail-loud', () => {
  it('version/apiVersion 与包根 package.json 逐字一致（fs 直读——非 import.meta 断言）', () => {
    const fields = readHostVersionFields();
    expect(fields.version).toBe(pkg.version);
    expect(fields.apiVersion).toBe(pkg.apiVersion);
  });
  it('进程内缓存：两次调用同引用（boot 期一次读的机器形态）', () => {
    expect(readHostVersionFields()).toBe(readHostVersionFields());
  });
  // 缺 version / 非法 apiVersion 的 fail-loud 腿不可注入测（PKG_ROOT 是编译期锚、
  // 包根真值由 release 契约 1 + apiVersion 格式红在本测第一条间被锁）——留注不硬测
});

describe('readHostFaceData：能力清单形态过滤 + 实验键子集派生', () => {
  it('standalone 形态：capabilities = 目录中 formFactors 含 standalone 的全量（本构建面语义）', () => {
    const data = readHostFaceData('standalone');
    const expected = CAPABILITIES.filter((c) => c.formFactors.includes('standalone')).map((c) => c.name);
    expect(data.capabilities).toEqual(expected);
    expect(data.formFactor).toBe('standalone');
  });
  it('daemon 形态：同法派生（形态差登记日此对照先红——构建面分叉的回归锁）', () => {
    const data = readHostFaceData('daemon');
    const expected = CAPABILITIES.filter((c) => c.formFactors.includes('daemon')).map((c) => c.name);
    expect(data.capabilities).toEqual(expected);
  });
  it('experimentalKeys = 键表 tier=experimental 子集（目录即声明面，不第二处登记）', () => {
    const data = readHostFaceData('standalone');
    const expected = VIRTUAL_API_KEYS.filter((k) => k.tier === 'experimental').map((k) => k.key);
    expect(data.experimentalKeys).toEqual(expected);
  });
});

describe('buildHostFace：物化 + m5 桥接纪律（数据随桥走、方法面各岸自派生）', () => {
  it('HostFaceData 是纯 JSON（可结构化克隆过桥——方法不进数据面）', () => {
    const data = readHostFaceData('daemon');
    const over = structuredClone(data);
    expect(over).toEqual(data);
  });
  it('对岸物化同构：materializeHostFace(readHostFaceData(x)) 与 buildHostFace(x) 行为一致', () => {
    const hostSide = buildHostFace('daemon');
    const workerSide = materializeHostFace(readHostFaceData('daemon'));
    expect(workerSide.version).toBe(hostSide.version);
    expect(workerSide.apiVersion).toBe(hostSide.apiVersion);
    expect(workerSide.formFactor).toBe(hostSide.formFactor);
    expect(workerSide.capabilities.list()).toEqual(hostSide.capabilities.list());
  });
  it('has 问答与清单一致（本构建面有无，非组合树挂载态——两问不混）', () => {
    const face = buildHostFace('standalone');
    for (const name of readHostFaceData('standalone').capabilities) {
      expect(face.capabilities.has(name)).toBe(true);
    }
    expect(face.capabilities.has('no.such.capability')).toBe(false);
  });
});
