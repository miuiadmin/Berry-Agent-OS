/**
 * L5 app — `berry dump-config` 组合树诊断（打印实际生效装配，不跑对话）。
 *
 * persist:false（不开库不建会话——诊断面零副作用）；凭证配置状态不在此列
 * （需要读库，走 run 面的后续诊断命令——M1 不做）。输出人读文本：
 * 组合树逐行带装载状态（activated/failed/skipped/unresolved）——「我到底跑的
 * 是什么」的一屏答案（契约篇 §5.1）。插件装载失败 = 启动断言在组合根抛出，
 * 此处捕获后尽力先打印纯合成的树（零副作用解析）再列失败清单，退出码 1。
 */

import { createBerryRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { loadComposition, OVERLAY_FILENAME, type CompositionReport } from './composition.js';
import { createBuiltinRegistry } from './builtins.js';
import { createSubagentChildFactory } from './subagent-factory.js';
import type { PluginStatusRow } from './composition.js';
import { AppError, COMPOSITION_ROW_INVALID, PLUGIN_LOAD_FAILED, describeError } from '../contracts/errors.js';
import { dataDir } from './paths.js';
import { VERSION } from './version.js';
import { createContext } from '../context/context.js';
import { createLlmRuntime, createStreamFn } from '../llm/index.js';
import { defaultConvertToLlm } from './convert.js';
import { DEFAULT_MODEL } from './assembly.js';

/**
 * 组合树文本渲染（dump 面共用：纯合成无状态版 + 装载后带状态版）。
 * @param composition 组合树装载产物
 * @param statuses 装载状态（缺省 = 纯计划形态——合成期/失败兜底路径用）
 */
function renderCompositionTree(composition: CompositionReport, statuses?: readonly PluginStatusRow[]): string {
  const statusById = new Map((statuses ?? []).map((row) => [row.id, row]));
  const lines = composition.plan.map((row) => {
    const status = statusById.get(row.id);
    if (row.skip) return `  - ${row.id}：${status ? `${status.status}（${row.skip}）` : `skipped（${row.skip}）`}`;
    if (row.unresolved !== undefined) {
      return `  - ${row.id}：unresolved——${row.unresolved}`;
    }
    const tag =
      status?.status === 'activated' && status.name
        ? `activated（name: ${status.name}）`
        : status
          ? `${status.status}`
          : 'planned';
    return `  - ${row.id}：${tag}  ${row.entry ?? ''}`;
  });
  const head = `组合树（${composition.rows.length} 行；官方默认层 + ${OVERLAY_FILENAME} 后写胜出）：`;
  return lines.length > 0 ? [head, ...lines].join('\n') : `${head}\n  （空树——无插件行）`;
}

/**
 * 组合树打印主流程。
 * @param options 组合根选项透传（与生产同参——诊断的就是实际生效组合）
 * @returns 进程退出码（0 = 全激活/显式跳过；1 = 装载失败清单）
 */
export async function dumpConfigMain(options: RuntimeOptions = {}): Promise<number> {
  try {
    const runtime = await createBerryRuntime({ ...options, interactive: false, persist: false });
    try {
      const lines = [
        `Berry ${VERSION}`,
        `数据目录：${dataDir()}`,
        `工作区：${runtime.workspace}`,
        `模型：${runtime.model}`,
        `沙箱档：${runtime.sandboxMode}`,
        `审批档：${runtime.approval.policyMode}`,
        renderCompositionTree(runtime.composition, runtime.plugins.list()),
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
  } catch (err) {
    // 启动断言失败（插件装载/组合树校验）——诊断面捕获后打印树与清单，不裸抛
    if (err instanceof AppError && (err.code === PLUGIN_LOAD_FAILED || err.code === COMPOSITION_ROW_INVALID)) {
      process.stdout.write(`Berry ${VERSION}\n数据目录：${dataDir()}\n`);
      // 树尽力打印：纯合成解析零副作用（插件 import 失败也能看到树本身）；
      // 内置注册表同构传入（无 store 诊断态）——builtin: 行解析不失真
      //（subagent 真工厂构造全惰性——委派永不发生，占位依赖零副作用；chat 为
      // 纯树合成的占位件——apply 永不跑，只需注册表键在）
      try {
        process.stdout.write(
          renderCompositionTree(
            loadComposition(
              options.compositionDir ?? dataDir(),
              createBuiltinRegistry({
                workspace: () => process.cwd(),
                subagentFactory: createSubagentChildFactory({
                  getSession: () => undefined,
                  streamFn: createStreamFn(createLlmRuntime()),
                  model: options.model ?? process.env['APP_MODEL'] ?? DEFAULT_MODEL,
                  convertToLlm: (messages) => defaultConvertToLlm(messages),
                  workspace: process.cwd(),
                  sandboxMode: options.sandboxMode ?? 'workspace-write',
                  rootCtx: createContext({ name: 'dump-diag' }),
                }),
                getSession: () => undefined,
                // 诊断面无会话——boot 降级永不触发（惰性取值恒 false 占位）
                wasResumed: () => false,
                // chat 占位件：纯树合成只查注册表键（形状/装载均不发生）——
                // apply 为空实现占位，构造期零副作用
                chat: {
                  name: 'chat',
                  apply: async () => undefined,
                },
              }),
            ),
          ) + '\n',
        );
      } catch {
        // 合成本身失败——跳过树，错误信息即诊断
      }
      process.stdout.write(`${describeError(err)}\n`);
      return 1;
    }
    throw err;
  }
}
