/**
 * L3 safety — Node 进程权限（PM）中层旗推导器（契约篇 §1.7 external 载体，
 * external carrier 落码批——第三十七批增补 2/4 的执行面）。
 *
 * external 域三层执法的中层：进程墙（fork per-行域）是真信任边界，PM 是
 * 「一年 3+ 绕过 CVE 的诚实定位 = 中层非墙」（PoC ⑫ UDS bind 逃逸实证），
 * OS 层（seatbelt/bwrap）尽力罩在其外。本件只做纯旗推导——把宿主推导的
 * 写白名单翻译成 node CLI 旗面，三层各司其职的参数面。
 *
 * 生产化底座 = PoC ⑧ 三坑（全部在此执法）：
 * - **坑一（darwin 路径形）**：PM 按归一化绝对路径匹配白名单——推导侧与
 *   运行时路径必须同形（realpathSync 归一；/var → /private/var symlink）；
 * - **坑二（v24 逗号拼接废弃）**：`--allow-fs-write=a,b` 整串被当单一字面
 *   路径白名单静默错形——**多根每根重复一旗**；
 * - **坑三（写根必须预建）**：写根目录不存在 → realpath 归一断链 → 根内
 *   写被 ERR_ACCESS_DENIED 拒（白名单**静默失效**形态）——推导期显式
 *   mkdirSync 预建（幂等；装载期一次性成本）。
 *
 * 读面裁定 = `--allow-fs-read=*`（全域可读）：PM 中层定位 = 防写 + 防
 * addon（`--allow-addons` 刻意不开——拒载即拒装，PoC ⑦ 实证）+ 防 child
 * （`--allow-child-process` 刻意不开——域内 spawn 强制经 ctx.exec，增补
 * 2c）。全域读在 PM 层放行不是漏：域代码按需 import 全 node_modules 树
 * （逐根枚举读面是维护陷阱；旧「tsx 预载链」措辞已随刀四载体去 tsx 化
 * 退役——理由不随载体加载链变）。
 *
 * **OS 层读/网面诚实边界（R1 P0-6 勘正，契约篇 §1.7 增补 10 R1 注记
 * 2026-08-29）**：现行两后端 profile 对 external 域的实际覆盖 = **防写不防
 * 读不防网**——seatbelt `(allow default)+(deny file-write*)` / bwrap
 * `--ro-bind / /` 无 net-ns。即 external 域 v1 可整读宿主 HOME（含
 * `~/.berry` 凭证库——env 白名单罩不住文件面直读）。读/网收窄需要
 * external 专属 profile 变体（deny file-read* 基线外 + net 拒绝式），与
 * 第 1② 条 `net` 同族推论——**无既定执法基线即不预造**：收窄面挂账随
 * net 执法基线批（首个真实消费者）一体定形。勿以「OS 层罩着读面」作
 * 依据——那是边界幻觉。
 *
 * 旗面经显式 execArgv 携带（生产首选——PoC 核对 B 裁定：cwd 无关、旗面
 * 全量可控、无实验性前缀依赖；node.config.json 备位不入产线）。
 */

import { mkdirSync, realpathSync } from 'node:fs';

/**
 * 推导 external 域子进程的 PM 旗面（execArgv 追加段）。
 *
 * @param writeRoots 写白名单根（宿主推导基线 ∩ 应用声明交集的产物——
 *   调用方已完成闩二校验；本函数信任输入只管翻译）
 * @param opts.tsTransform 域入口是 TS 源形态（dev 直跑）时为 true——载体
 *   引导器（carrier-launch.mjs）经 module.register 挂 `.js→.ts` 兜底
 *   resolve 钩子，node 的 loader 钩子跑在 AsyncLoaderHookWorker 专用线程，
 *   PM 缺省拒 Worker 构造，须补 `--allow-worker`（ERR_ACCESS_DENIED:
 *   WorkerThreads——刀四载体去 tsx 化实测勘正：旧理由「tsx→esbuild 转译
 *   线程」已随 tsx 退役，新理由 = node 自家 loader 线程，放行面同宽）。
 *   官方 SecurityWarning（worker 可弱化 PM）——dev 形态已知放行：进程墙 +
 *   OS 层仍在（PM 是中层非墙）。旧伴随参数 TSX_DISABLE_CACHE 已退役
 *   （载体零 tsx 无磁盘缓存面）。编译产物形态不补——PM 保持最紧（dist
 *   直载不经引导器，零钩子零线程）。
 * @returns execArgv 旗数组（`--permission` 领衔 + 全域读一旗 + 每写根一旗）
 */
export function derivePmFlags(writeRoots: readonly string[], opts?: { tsTransform?: boolean }): string[] {
  return [
    // PM 总开关必须领衔：allow-fs-* 是其子旗，缺总开关直接 ERR_MISSING_OPTION
    '--permission',
    // 读面全域（见头注裁定——R1 复盘批二注记勘正：现行两后端 profile 对
    // external 域实际防写不防读不防网，读面全域是诚实边界非「OS 层管读」）
    '--allow-fs-read=*',
    // 写面：坑三预建（幂等）+ 坑一归一 + 坑二每根一旗
    ...writeRoots.map((root) => `--allow-fs-write=${prepareRoot(root)}`),
    // TS 源形态（dev）：载体引导器的 loader 钩子线程（编译产物形态不开）
    ...(opts?.tsTransform === true ? ['--allow-worker'] : []),
  ];
}

/**
 * 写根预备：预建目录（坑三——不存在则白名单静默失效）+ realpath 归一
 * （坑一——与子进程运行时路径同形）。输入应已是绝对路径（基线推导产物
 * 保证）；归一失败（真实不可能——已预建）原样返回保守值。
 */
function prepareRoot(root: string): string {
  try {
    mkdirSync(root, { recursive: true });
    return realpathSync(root);
  } catch {
    return root;
  }
}
