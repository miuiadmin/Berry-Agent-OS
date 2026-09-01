/**
 * 载体域 TS 源形态 resolve 钩子（刀四载体去 tsx 化——CI 首跑红根因①修面）。
 *
 * 职责：TS 源码里 `import './x.js'` 式说明符的 `.js→.ts` 兜底改写。Node 原生
 * type-strip 直载 .ts 时不重写指示符（v24 实测既知——刀三落码注），本钩子
 * 在 nextResolve 失败（MODULE_NOT_FOUND）时对**相对说明符**尝试 `.ts` 改写
 * 一次；非相对说明符（裸包名/node: 内建）与改写仍失败的情形原样抛出原错。
 *
 * 形态约束（勿破）：
 * - 纯 JS 零依赖——本文件不经 tsc/vitest 变换，dev 直载、dist 不需要
 *  （编译产物形态 .js 指示符天然命中，不进引导器链）；
 * - 由 carrier-launch.mjs 经 module.register 从**入口代码**注册——钩子在
 *   worker 线程内注册即生效（tsx 的 `--import=tsx` 钩子在 node 22 worker
 *   线程不挂、esbuild 子进程又被 external 域 PM 旗拒杀——这正是去 tsx 化
 *   的根因，勿退回）。
 */

/**
 * resolve 钩子：先走 Node 缺省解析，失败且是相对 .js 说明符时兜底 .ts。
 * @param {string} specifier 导入说明符
 * @param {{parentURL?: string, conditions?: string[]}} context 解析上下文
 * @param {Function} nextResolve 链上下一钩（Node 缺省解析）
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // 只兜底相对说明符的 .js 尾缀（含查询串形态 ./x.js?v=1）；裸包名/
    // node: 内建/绝对 URL 的失败不是「TS 源 .js 指示符」问题，原样上抛
    if (specifier.startsWith('.') && /\.js(\?|$)/.test(specifier)) {
      try {
        return await nextResolve(specifier.replace(/\.js(\?|$)/, '.ts$1'), context);
      } catch {
        /* 改写也失败——落回原错（保持错误面真实） */
      }
    }
    throw err;
  }
}
