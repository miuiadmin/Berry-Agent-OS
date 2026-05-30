export interface ICronScheduler {
  start(): void;
  stop(): void;
  catchUp(): Promise<void>;
  isRunning(taskId: string): boolean;
}
