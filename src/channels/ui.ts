/**
 * L4 channels — ctx.ui 聚合器（技术栈篇 §4.3 定稿清单 + 降级规则）。
 *
 * 聚合在线通道的 UI 后端：非交互原语（notify/setStatus）广播全部通道；
 * 阻塞式原语（confirm/select/input）挑首个支持的后端应答，通道不支持时
 * 按降级规则回落（select→input、setWidget→notify、confirm→input 降级为
 * 同一规则的自然延伸），无任何交互通道时 fail-soft 返回保守值——应用
 * 不感知通道能力差异。
 *
 * 语义纪律（§4.3）：阻塞式交互若用于授权场景，须走 approval seam 同一条
 * 审批日志——那是调用方（审批 answerer）的接线责任，不在本聚合器。
 */

import type { Disposer } from '../context/types.js';
import type { InputOptions, NotifyOptions, UiAskOptions, UiBackend, UiChoice, UiService } from './types.js';

/** 解析 confirm 的 y/n 文本答案（未识别 → undefined，调用方决定重问或保守值） */
export function parseBooleanAnswer(text: string): boolean | undefined {
  const v = text.trim().toLowerCase();
  if (['y', 'yes', '是'].includes(v)) return true;
  if (['n', 'no', '否'].includes(v)) return false;
  return undefined;
}

/** 组装 ctx.ui 聚合器（隔离案一第一刀 #3：广播循环逐后端异常隔离，消 P19——坏后端不毒调用方、不截断后续后端） */
export function createUiService(opts?: { onError?: (err: unknown, op: 'notify' | 'setStatus') => void }): UiService {
  /** 广播异常诊断回调（装配层接 logger——「没生效必须有信号」纪律） */
  const onError = opts?.onError;
  /** 单后端调用隔离壳：抛错上报后继续——广播语义是「尽力达全部通道」非事务 */
  const callIsolated = (op: 'notify' | 'setStatus', invoke: () => void): void => {
    try {
      invoke();
    } catch (err) {
      onError?.(err, op);
    }
  };
  /** 在线后端（接入序即优先序） */
  const backends: UiBackend[] = [];

  /** 首个支持指定能力且当前在线的后端（能力键须在 UiBackend 可选成员内） */
  const firstCapable = <K extends 'confirm' | 'input' | 'select'>(
    cap: K,
  ): (UiBackend & Required<Pick<UiBackend, K>>) | undefined => {
    for (const backend of backends) {
      if (backend[cap]) return backend as UiBackend & Required<Pick<UiBackend, K>>;
    }
    return undefined;
  };

  /** select 降级到 input：把选项展开成编号清单让用户输 value/序号/label。
   *  signal 透传进 input（channels 批刀 A）——降级路径与原生路径同一撤销面 */
  const selectViaInput = async (
    message: string,
    choices: readonly UiChoice[],
    opts?: UiAskOptions,
  ): Promise<string> => {
    const backend = firstCapable('input');
    if (!backend) return ''; // 无任何交互通道：fail-soft 空值
    const menu = choices.map((c, i) => `${i + 1}) ${c.label} (${c.value})`).join('  ');
    const answer = await backend.input(`${message}\n${menu}`, opts);
    const trimmed = answer.trim();
    // 命中序号 / value / label 任一即采纳；不匹配 → 空值（调用方按无效处理）
    const byIndex = choices[Number(trimmed) - 1];
    if (byIndex) return byIndex.value;
    return choices.find((c) => c.value === trimmed || c.label === trimmed)?.value ?? '';
  };

  /** confirm 降级到 input：y/n 文本解析；未识别 → 保守 false。signal 同透传 */
  const confirmViaInput = async (message: string, opts?: UiAskOptions): Promise<boolean> => {
    const backend = firstCapable('input');
    if (!backend) return false; // fail-closed：无人可答即不确认
    const answer = await backend.input(`${message} [y/n]`, opts);
    return parseBooleanAnswer(answer) ?? false;
  };

  const service: UiService = {
    notify(message: string, notifyOpts?: NotifyOptions) {
      for (const backend of backends) callIsolated('notify', () => backend.notify(message, notifyOpts));
    },

    async confirm(message: string, opts?: UiAskOptions) {
      const backend = firstCapable('confirm');
      if (backend) return backend.confirm(message, opts);
      return confirmViaInput(message, opts);
    },

    async select(message: string, choices: readonly UiChoice[], opts?: UiAskOptions) {
      const backend = firstCapable('select');
      if (backend) return backend.select(message, choices, opts);
      return selectViaInput(message, choices, opts);
    },

    async input(message: string, opts?: InputOptions) {
      const backend = firstCapable('input');
      if (!backend) return ''; // fail-soft：无交互通道
      return backend.input(message, opts);
    },

    setStatus(status: string) {
      for (const backend of backends) callIsolated('setStatus', () => backend.setStatus(status));
    },

    setWidget(node: unknown) {
      // 首个支持 setWidget 的后端渲染；不支持 → 降级为 notify（§4.3 降级规则）
      for (const backend of backends) {
        if (backend.setWidget) {
          backend.setWidget(node);
          return;
        }
      }
      service.notify(`[widget] 自定义渲染不受支持，已降级通知（${typeof node}）`);
    },

    hasAudience(): boolean {
      // 观众探针（基建大扫 #44 修订 R-2）：语义 =「有人可收」非「通道在场」——
      // 后端可选自报 hasAudience()，不实现者缺省真（TUI 在场即有人）；webui 报
      // 在线连接数（常开零连接 = 无观众）。无头进程 backends 空 → some 自然
      // false，notify 静默 no-op，通知类消费方（obs 告警）不耗冷却
      return backends.some((b) => (b.hasAudience ? b.hasAudience() : true));
    },

    attach(backend: UiBackend): Disposer {
      backends.push(backend);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const index = backends.indexOf(backend);
        if (index >= 0) backends.splice(index, 1);
      };
    },
  };
  return service;
}
