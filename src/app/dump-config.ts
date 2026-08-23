/**
 * L5 app — `berry dump-config` 组合树诊断（打印实际生效装配，不跑对话）。
 *
 * persist:false（不开库不建会话——诊断面零副作用）；凭证配置状态不在此列
 * （需要读库，走 run 面的后续诊断命令——M1 不做）。输出人读文本。
 */

import { createBerryRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { dataDir } from './paths.js';
import { VERSION } from './version.js';

/**
 * 组合树打印主流程。
 * @param options 组合根选项透传（与生产同参——诊断的就是实际生效组合）
 * @returns 进程退出码（恒 0）
 */
export async function dumpConfigMain(options: RuntimeOptions = {}): Promise<number> {
  const runtime = createBerryRuntime({ ...options, interactive: false, persist: false });
  try {
    const lines = [
      `Berry ${VERSION}`,
      `数据目录：${dataDir()}`,
      `工作区：${runtime.workspace}`,
      `模型：${runtime.model}`,
      `沙箱档：${runtime.sandboxMode}`,
      `审批档：${runtime.approval.policyMode}`,
      `工具（${runtime.tools.list().length}）：${runtime.tools
        .list()
        .map((t) => t.name)
        .join('、')}`,
      `技能发现位置：${runtime.skillLocations.map((l) => l.dir).join('、') || '（无）'}`,
      `技能（${runtime.skills.list().length}）：${
        runtime.skills
          .list()
          .map((s) => s.name)
          .join('、') || '（无）'
      }`,
      `系统提示词：${runtime.systemPrompt.length} 字符`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  } finally {
    await runtime.shutdown();
  }
}
