/**
 * L4 channels — 提问队列（headless 可测）。
 *
 * TUI 等单输入框通道的阻塞式交互基建：同一时刻只有一个提问占用输入框
 * （prompt 模式），后续提问排队；用户提交的文本先经 handleSubmit——
 * prompt 期间被消费为答案并回显，非 prompt 期返回 false 交正常输入流
 * （命令/消息）。与 UiBackend 的 input/confirm 实现共用。
 */

/** 提问队列的出屏回调（壳注入：问题行上屏 / 答案回显行上屏） */
export interface PromptIo {
  /** 提问上屏（轮到本提问时调用一次） */
  show(question: string): void;
  /** 用户答案回显上屏 */
  echo(answer: string): void;
}

/** 提问队列面 */
export interface PromptQueue {
  /** 排队提问（FIFO；轮到时经 io.show 上屏；resolve 于用户提交答案） */
  ask(question: string): Promise<string>;
  /**
   * 用户提交路由：prompt 期间消费为当前答案（echo + resolve）返回 true；
   * 无提问在身返回 false（调用方走命令/消息路径）。
   */
  handleSubmit(text: string): boolean;
  /** 是否有提问在身（通道据此切换输入框占位提示） */
  pending(): boolean;
}

/** 组装提问队列 */
export function createPromptQueue(io: PromptIo): PromptQueue {
  /** 当前占屏的提问（null = 非 prompt 模式） */
  let current: { question: string; resolve: (answer: string) => void } | null = null;
  /** 排队中的后续提问 */
  const waiting: { question: string; resolve: (answer: string) => void }[] = [];

  /** 弹出队首提问占屏（无在身提问且有排队时） */
  const advance = (): void => {
    if (current || waiting.length === 0) return;
    current = waiting.shift()!;
    io.show(current.question);
  };

  return {
    ask(question) {
      return new Promise<string>((resolve) => {
        waiting.push({ question, resolve });
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
  };
}
