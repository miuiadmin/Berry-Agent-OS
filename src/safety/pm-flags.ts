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
 * 读面裁定 = `--allow-fs-read=*`（全域可读）：三层分工下读 profile 归 OS
 * 层（seatbelt/bwrap 管），PM 中层定位 = 防写 + 防 addon（`--allow-addons`
 * 刻意不开——拒载即拒装，PoC ⑦ 实证）+ 防 child（`--allow-child-process`
 * 刻意不开——域内 spawn 强制经 ctx.exec，增补 2c）。全域读在 PM 层放行
 * 不是漏：OS 层罩着，且 tsx 预载链要读全 node_modules 树（逐根枚举读面
 * 是维护陷阱）。
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
 * @param opts.tsTransform 域入口是 TS 源形态（dev 直跑）时为 true——tsx 预载
 *   链的 esbuild 转译走 worker 线程服务，PM 缺省拒 Worker 构造，须补
 *   `--allow-worker`（E6 实测两坑：另需 env TSX_DISABLE_CACHE=1 关 tsx 磁盘
 *   缓存的 mkdir）。编译产物形态不补——PM 保持最紧。官方对 --allow-worker
 *   有 SecurityWarning（worker 可弱化 PM）——dev 形态的已知放行：进程墙 +
 *   OS 层仍在（PM 是中层非墙），入册见契约篇 §1.7 external carrier 落码批注记。
 * @returns execArgv 旗数组（`--permission` 领衔 + 全域读一旗 + 每写根一旗）
 */
export function derivePmFlags(writeRoots: readonly string[], opts?: { tsTransform?: boolean }): string[] {
  return [
    // PM 总开关必须领衔：allow-fs-* 是其子旗，缺总开关直接 ERR_MISSING_OPTION
    '--permission',
    // 读面全域（见头注裁定——OS 层管读 profile）
    '--allow-fs-read=*',
    // 写面：坑三预建（幂等）+ 坑一归一 + 坑二每根一旗
    ...writeRoots.map((root) => `--allow-fs-write=${prepareRoot(root)}`),
    // TS 源形态（dev）：tsx→esbuild 转译需 worker 线程服务（编译产物形态不开）
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
