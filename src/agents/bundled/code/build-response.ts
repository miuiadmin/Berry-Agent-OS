/**
 * Code Agent 任务结果 → 用户可见回复 的纯格式化函数。
 *
 * 从 entry.ts 提取：buildUserResponse 是无副作用的纯字符串拼接函数，与 agent 启动入口
 * （entry.ts 顶层 startModuleAgent 调用）解耦后可独立单测，避免 import entry.ts 触发
 * agent 启动副作用（AGENT_NAME/IPC/config 全链路初始化）。
 */

/** buildUserResponse 的输入：runTaskPhases 结果的呈现相关子集 */
export interface BuildUserResponseInput {
  /** 各阶段记录，implementation 阶段的 summary 优先作为正文 */
  phases: Array<{ phase: string; success: boolean; summary: string }>;
  /** 任务整体是否成功（测试是否通过等） */
  success: boolean;
  /** 兜底正文（无 implementation summary 时用） */
  summary: string;
  /** 实际产生文件改动的列表（edit_code/write_file 成功调用的目标文件） */
  filesChanged?: string[];
  /** 测试结果，用于标注测试状态 */
  testResult?: { passed: boolean };
}

/**
 * 从 code agent 任务结果中构建用户友好的回复文本。
 *
 * 优先使用 implementation phase 的 LLM 输出（自然语言描述），而非 lastPhase.summary
 * （可能是 "测试失败: ..." 等 terse 文本）。文件变更要么列出实际改动，要么（implementation
 * 任务却没改文件）诚实说明未执行——避免 Brain 把"只规划未执行"的空结果误当正常完成批准。
 *
 * @param result runTaskPhases 返回的完整结果
 * @returns 用户可见的自然语言回复
 */
export function buildUserResponse(result: BuildUserResponseInput): string {
  const parts: string[] = [];
  const filesChanged = result.filesChanged ?? [];

  // 优先找 implementation phase 的 summary（LLM 的完整自然语言输出）
  const implPhase = result.phases.find((p) => p.phase === 'implementation');
  const mainText = implPhase?.summary || result.summary;
  if (mainText) parts.push(mainText);

  // 文件变更：要么列出实际改动的文件，要么（implementation 任务却没改文件）诚实说明未执行。
  if (filesChanged.length > 0) {
    parts.push(`\n变更的文件：${filesChanged.join(', ')}`);
  } else if (implPhase) {
    // implementation 任务（full/implement）却未产生任何文件改动 = 只规划未执行（如模型只输出计划没调工具）。
    // 必须显式暴露，让 Brain/用户看到真相后重新决策（追问/重新委派），而非把"空结果"误当正常完成批准。
    // 这是诚实汇报兜底，配合 task-phases prompt 执行强约束；analyze/test 任务无 implementation phase，
    // filesChanged:[] 是预期，不触发警告。
    parts.push('\n⚠️ 未执行任何文件改动（计划已制定但未落地到文件）。如需我实际修改，请明确告知。');
  }

  // 如果测试失败但文件已创建，标注测试状态（不覆盖正文）
  if (!result.success && result.testResult && !result.testResult.passed && filesChanged.length > 0) {
    parts.push('\n⚠️ 自动测试未通过，但文件已成功创建。');
  }

  return parts.join('\n');
}
