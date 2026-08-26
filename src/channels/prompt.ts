/**
 * L4 channels — 提问队列（headless 可测）。
 *
 * TUI 等单输入框通道的阻塞式交互基建：同一时刻只有一个提问占用输入框
 * （prompt 模式），后续提问排队；用户提交的文本先经 handleSubmit——
 * prompt 期间被消费为答案并回显，非 prompt 期返回 false 交正常输入流
 * （命令/消息）。与 UiBackend 的 input/confirm 实现共用。
 *
 * S5 两级出队（契约篇 §5.4 提问队列落地面）：ask 携带 priority
 * （interactive > background）——出队时 interactive 者先出。多应用并行下
 * 后台 run 的提问不再队头阻塞用户在场的对话。
 *
 * S5 取消收场（冷读闸 F5）：cancelAll 把在身/排队提问全部以 undefined 收场
 * （fail-closed）——驱动 abort/quit 时队首永不搁浅；消费方（io 工具/审批
 * confirm 面）把 undefined 读作取消语义。
 */

/** 提问优先级（S5 两级出队——interactive 者先出） */
export type PromptPriority = 'interactive' | 'background';

/** 提问队列的出屏回调（壳注入：问题行上屏 / 答案回显行上屏） */
export interface PromptIo {
  /** 提问上屏（轮到本提问时调用一次） */
  show(question: string): void;
  /** 用户答案回显上屏 */
  echo(answer: string): void;
}

/** 提问队列面 */
export interface PromptQueue {
  /**
   * 排队提问（轮到时经 io.show 上屏；resolve 于用户提交答案——取消收场时
   * resolve undefined）。缺省 interactive 优先出队。
   */
  ask(question: string, opts?: { readonly priority?: PromptPriority }): Promise<string | undefined>;
  /**
   * 用户提交路由：prompt 期间消费为当前答案（echo + resolve）返回 true；
   * 无提问在身返回 false（调用方走命令/消息路径）。
   */
  handleSubmit(text: string): boolean;
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
  let current: { question: string; resolve: (answer: string | undefined) => void } | null = null;
  /** 排队中的后续提问 */
  const waiting: { question: string; priority: PromptPriority; resolve: (answer: string | undefined) => void }[] = [];

  /**
   * 弹出下一个提问占屏（无在身提问且有排队时）——两级出队：先找最早的
   * interactive，无才取队首（background 者不插队但不被后来 interactive 压死；
   * 同级保持 FIFO）。
   */
  const advance = (): void => {
    if (current || waiting.length === 0) return;
    const nextInteractive = waiting.findIndex((item) => item.priority === 'interactive');
    const index = nextInteractive === -1 ? 0 : nextInteractive;
    current = waiting.splice(index, 1)[0]!;
    io.show(current.question);
  };

  return {
    ask(question, opts) {
      return new Promise<string | undefined>((resolve) => {
        waiting.push({ question, priority: opts?.priority ?? 'interactive', resolve });
        advance();
      });
    },

    handleSubmit(text) {
      if (!current) return false;
      const prompt = current;
      current = null;
      io.echo(text);
      prompt.resolve(text);
      advance();
      return true;
    },

    pending() {
      return current !== null;
    },

    cancelAll() {
      // 在身提问先收（释放输入框占屏——下游 handleSubmit 即回到 false），
      // 排队者随后逐个收；全部 resolve undefined = 消费方的取消语义
      const stranded = current !== null ? [current, ...waiting.splice(0)] : waiting.splice(0);
      current = null;
      for (const item of stranded) item.resolve(undefined);
    },
  };
}
