/**
 * L4 channels — 提问队列（headless 可测）。
 *
 * TUI 等单输入框通道的阻塞式交互基建：同一时刻只有一个提问占用输入框
 * （prompt 模式），后续提问排队；用户提交的文本先经 handleSubmit——
 * prompt 期间被消费为答案并回显，非 prompt 期返回 false 交正常输入流
 * （命令/消息）。与 UiBackend 的 input/confirm/select 实现共用（刀 2 起
 * select 亦经本队列统一排队——overlay 是队首提问的呈现形态之一，答案走
 * answerSelect 回填，单占面模型不变）。
 *
 * S5 两级出队（契约篇 §5.4 提问队列落地面）：ask 携带 priority
 * （interactive > background）——出队时 interactive 者先出。多应用并行下
 * 后台 run 的提问不再队头阻塞用户在场的对话。
 *
 * S5 取消收场（冷读闸 F5）：cancelAll 把在身/排队提问全部以 undefined 收场
 * （fail-closed）——驱动 abort/quit 时队首永不搁浅；消费方（io 工具/审批
 * confirm 面）把 undefined 读作取消语义。
 *
 * channels 批刀 A（契约篇 §6.8）：ask 增可选 signal——per-ask 撤销面。abort
 * 与取消收场同一语义（resolve undefined，消费方取保守值 confirm→false /
 * select·input→''）；在身提问经 io.dismiss 撤销说明行收屏，排队者静默出队。
 * 结算单漏斗：应答/取消收场/abort 任一路先到即置 settled，其余路径（含迟到
 * abort）全 no-op——监听随结算摘除，防 stale 信号误伤后续提问。
 */

import type { UiChoice } from './types.js';

/** 提问优先级（S5 两级出队——interactive 者先出） */
export type PromptPriority = 'interactive' | 'background';

/**
 * 单选呈现规格（刀 2 select 原生实装，技术栈篇 §4.3 实现矩阵）：select 提问
 * 的占屏形态 = overlay 单选列表（非文本输入框），答案经队列 answerSelect
 * 回填——单占面模型不变，overlay 只是队首提问的呈现形态之一。
 */
export interface PromptSelectSpec {
  /** 选项集（value 程序值 / label 展示文案——回显用 label） */
  readonly choices: readonly UiChoice[];
}

/** ask 可选参（S5 优先级 + channels 批刀 A 撤销信号 + 刀 2 单选呈现） */
export interface PromptAskOptions {
  /** 出队优先级（缺省 interactive——用户在场的对话先出） */
  readonly priority?: PromptPriority;
  /**
   * per-ask 撤销信号（channels 批刀 A）：abort 即本提问以 undefined 收场
   * （与 cancelAll 同一取消语义）。传入时已 aborted = 同步立即结算——不
   * enqueue 不占屏（已 aborted 的信号永不再发事件，只挂监听 = 本提问永不
   * 收场的死路。真实命中面 = 两态 confirm 腿在 abort 之后才发出——如 run
   * 已打断时新 ask 进 answerer；三态路保守收场自 interrupt 小刀起直收
   * 'cancel' 不再降级发第二条 confirm，见 answerApproval 判据注释）。
   */
  readonly signal?: AbortSignal;
  /**
   * 单选呈现（刀 2）：在场时占屏走 io.showSelect（overlay 形态）、答案走
   * answerSelect 回填——不经 handleSubmit 文本路径（overlay 占焦期编辑器
   * 收不到键，文本路径结构性不可达）。
   */
  readonly select?: PromptSelectSpec;
}

/** 提问队列的出屏回调（壳注入：问题行上屏 / 答案回显行上屏 / 撤销说明行） */
export interface PromptIo {
  /** 提问上屏（轮到本提问时调用一次） */
  show(question: string): void;
  /** 用户答案回显上屏 */
  echo(answer: string): void;
  /**
   * 撤销说明行上屏（channels 批刀 A）：在身提问被 signal abort 时调用——
   * 替代答案回显位置的收屏行（文案 = abort reason）。可选：无此回调的壳
   * 照常收场，只是不显式擦行（提问行残留屏幕，语义已由 resolve undefined 收口）。
   */
  dismiss?(question: string, reason: string): void;
  /**
   * 单选占屏（刀 2）：select 提问轮到队首时替代 show——壳呈现 overlay 单选
   * 列表。可选：未实现者回落 show（问题行照上屏，答案仍可经 answerSelect
   * 程序面回填——headless 测试面形态）。
   */
  showSelect?(question: string, spec: PromptSelectSpec): void;
  /**
   * 单选占屏撤销（刀 2）：在身 select 被取消收场（cancelAll/signal abort）
   * 时收起 overlay。可选：不实现者仅少收屏动作（队列语义已由 resolve
   * undefined 收口）。
   */
  hideSelect?(): void;
}

/** 撤销说明缺省文案（abort 未携带 reason 字符串时——如无参 abort() 的 DOMException） */
const DEFAULT_DISMISS_REASON = '该提问已被撤销';

/**
 * abort reason → 撤销说明文案：字符串 reason 原样用；Error 取 message（无参
 * abort() 的缺省 DOMException〔name === 'AbortError'〕是实现缀语非人话文案，
 * 回落通用）；其余形态回落通用。
 */
function dismissReasonOf(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (typeof reason === 'string' && reason !== '') return reason;
  if (reason instanceof Error && reason.name !== 'AbortError' && reason.message !== '') {
    return reason.message;
  }
  return DEFAULT_DISMISS_REASON;
}

/** 队列条目（在身/排队共用形状）——settled 旗 + detach 桩构成结算单漏斗 */
interface PromptEntry {
  readonly question: string;
  readonly priority: PromptPriority;
  /** 单选呈现规格（刀 2；undefined = 文本提问形态） */
  readonly select?: PromptSelectSpec;
  readonly resolve: (answer: string | undefined) => void;
  /** 已结算旗：应答/取消收场/abort 任一路先到即置位，后续路径全 no-op */
  settled: boolean;
  /** 摘除 abort 监听（无 signal 者恒为 no-op 桩——统一漏斗形态免判空） */
  detach: () => void;
}

/** 提问队列面 */
export interface PromptQueue {
  /**
   * 排队提问（轮到时经 io.show 上屏；resolve 于用户提交答案——取消收场或
   * signal abort 时 resolve undefined）。缺省 interactive 优先出队。
   */
  ask(question: string, opts?: PromptAskOptions): Promise<string | undefined>;
  /**
   * 用户提交路由：prompt 期间消费为当前答案（echo + resolve）返回 true；
   * 无提问在身返回 false（调用方走命令/消息路径）。
   */
  handleSubmit(text: string): boolean;
  /**
   * 单选答案回填（刀 2）：在身提问为 select 形态时结算为给定值（'' = 取消
   * 保守值——与撤销面同语义），回显 label 后放行下一提问。非 select 在身/
   * 无提问在身 = no-op 返回 false（防御面：select 占焦期文本提交结构性
   * 不可达，此处不冒充文本答案路径）。
   */
  answerSelect(value: string): boolean;
  /** 是否有提问在身（通道据此切换输入框占位提示） */
  pending(): boolean;
  /**
   * 取消收场（S5 冷读闸 F5）：在身 + 排队全部 resolve undefined（fail-closed
   * ——驱动 abort/quit 时调；队首永不搁浅）。幂等——无提问在身为 no-op。
   */
  cancelAll(): void;
}

/** 组装提问队列 */
export function createPromptQueue(io: PromptIo): PromptQueue {
  /** 在身占屏的提问（null = 非 prompt 模式） */
  let current: PromptEntry | null = null;
  /** 排队中的后续提问 */
  const waiting: PromptEntry[] = [];

  /**
   * 结算单漏斗（channels 批刀 A）：一切 resolve 路径（应答/取消收场/abort）
   * 必经此处——settled 旗防双结算，摘监听防迟到 abort 误伤。返回是否真的
   * 完成了本次结算（供调用面区分首到/迟到）。
   */
  const settle = (entry: PromptEntry, answer: string | undefined): boolean => {
    if (entry.settled) return false;
    entry.settled = true;
    entry.detach();
    entry.resolve(answer);
    return true;
  };

  /**
   * 弹出下一个提问占屏（无在身提问且有排队时）——两级出队：先找最早的
   * interactive，无才取队首（background 者不插队但不被后来 interactive 压死；
   * 同级保持 FIFO）。不变式：settled 条目必已离开 current/waiting（onAbort
   * 与 cancelAll 在 settle 前先摘出）——此处无需再滤。
   */
  const advance = (): void => {
    if (current || waiting.length === 0) return;
    const nextInteractive = waiting.findIndex((item) => item.priority === 'interactive');
    const index = nextInteractive === -1 ? 0 : nextInteractive;
    current = waiting.splice(index, 1)[0]!;
    // 占屏分形态（刀 2）：select 走 showSelect（overlay）——壳未实现者回落
    // 文本问题行（headless 形态；答案仍经 answerSelect 程序面回填）
    if (current.select !== undefined && io.showSelect !== undefined) {
      io.showSelect(current.question, current.select);
    } else {
      io.show(current.question);
    }
  };

  return {
    ask(question, opts) {
      return new Promise<string | undefined>((resolve) => {
        const signal = opts?.signal;
        const entry: PromptEntry = {
          question,
          priority: opts?.priority ?? 'interactive',
          select: opts?.select,
          resolve,
          settled: false,
          detach: () => {},
        };
        // 预置 aborted 同步结算（冷读 blocker 2 修死）：不 enqueue 不占屏——
        // 已 aborted 的信号永不再发事件，只挂监听 = 本提问永不收场的死路
        if (signal?.aborted) {
          entry.resolve(undefined);
          return;
        }
        if (signal !== undefined) {
          // abort 分三档：在身（dismiss 收屏 + 释放输入框）/排队（静默出队）/
          // 已结算（no-op——迟到 abort）。在身判定用对象同一性（current ===
          // entry），排队判定用 indexOf——两态间的窗口（advance 切换瞬间）由
          // settled 旗兜底：任一路先结算，另一路即 no-op
          const onAbort = () => {
            if (entry.settled) return; // 迟到 abort：应答/取消收场已先到
            if (current === entry) {
              current = null;
              // select 在身先收 overlay（刀 2：占屏形态随取消收场撤销——
              // dismiss 行照常落〔原因文案〕，overlay 收起归 hideSelect）
              if (entry.select !== undefined) io.hideSelect?.();
              io.dismiss?.(entry.question, dismissReasonOf(signal));
              settle(entry, undefined);
              advance();
            } else {
              const index = waiting.indexOf(entry);
              if (index !== -1) waiting.splice(index, 1);
              settle(entry, undefined);
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          entry.detach = () => signal.removeEventListener('abort', onAbort);
        }
        waiting.push(entry);
        advance();
      });
    },

    handleSubmit(text) {
      if (!current) return false;
      // select 在身防御面（刀 2，结构性不可达——overlay 占焦，编辑器收不到
      // 键）：文本不冒充单选答案，交正常输入流（宁可当普通消息投递也不静默
      // 吞用户文本）；真答案路径 = answerSelect
      if (current.select !== undefined) return false;
      const prompt = current;
      current = null;
      io.echo(text);
      settle(prompt, text);
      advance();
      return true;
    },

    answerSelect(value) {
      // 入口收窄的规格先落 const（current 置空后 TS 收窄随可变引用丢失——别名保收窄）
      const spec = current?.select;
      if (current === null || spec === undefined) return false;
      const prompt = current;
      current = null;
      // 回显分档（刀 2）：选定值回显 label（人读文案——value 是程序值）；'' 取消
      // 不回显（取消可视化归壳：overlay 收起即见 + 壳自落取消行）
      if (value !== '') {
        const label = spec.choices.find((choice) => choice.value === value)?.label;
        io.echo(label ?? value);
      }
      settle(prompt, value);
      advance();
      return true;
    },

    pending() {
      return current !== null;
    },

    cancelAll() {
      // 在身提问先收（释放输入框占屏——下游 handleSubmit 即回到 false），
      // 排队者随后逐个收；全部 resolve undefined = 消费方的取消语义。
      // 经 settle 单漏斗：signal 提问的 abort 监听同笔摘除（防 cancelAll 后
      // 迟到 abort 触发已结算条目的 dismiss 路径）。select 在身先收 overlay
      //（刀 2：占屏形态随取消收场撤销——退出/停机路上 overlay 不滞屏）
      if (current?.select !== undefined) io.hideSelect?.();
      const stranded = current !== null ? [current, ...waiting.splice(0)] : waiting.splice(0);
      current = null;
      for (const item of stranded) settle(item, undefined);
      advance();
    },
  };
}
