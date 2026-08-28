# PoC 结论记档：worker 分域三可证伪项（第二十七批刀一）

> 2026-08-26 实跑。环境：Node v24.18.0 / darwin（本机）。判定基准 = 契约篇 §1.7「PoC 闸」。
> 三炮全 PASS → **go**；同日冷读闸回写闭合 + **hello 过界补票兑现**（见末节）——双闸全关，
> 刀二（worker 分域运行时）只待刀〇b 落地即可动工。
>
> 运行方式：`node tools/poc-worker/1-jiti.mjs`（②③④ 同款），退出码 0/1 = PASS/FAIL。

## 可证伪项①：jiti 能否在 worker_threads 内装载 TS 插件 → **PASS**

- worker realm 自建 `createJiti(import.meta.url, { moduleCache: false })`，与宿主装载器（`src/context/loader.ts`）同款配置。
- 阶段一：装载 TS 金样插件（named + default 导出）并调用 → 全对。
- 阶段二：改写插件文件后**同实例**再 import → 拿到新代码（`moduleCache:false` 重载语义在 worker 域成立）——`/reload` 语义基底可用。
- 结论：刀二「worker 内 jiti」路径成立，装载器核心机制可原样搬进 worker realm。

## 可证伪项②：typebox schema 跨 MessagePort 结构化克隆保真 → **PASS**

- 双 realm 各自 import 同一物理包（跨 realm 双实例——正是 §1.7「每 realm 单实例」要验证的形态）。
- 方向一（worker 造 schema → 主 realm 用自己实例 `Value.Check`）：合法值过、非法值拒。
- 方向二（主 realm 造 → worker 校验）：同上。
- **symbol 键存活数 = 0**（两侧皆是）：typebox 1.3.7 schema 是纯 JSON 形对象，结构化克隆无损——「schema 对象直接过界」路径成立，无需退到 JSON 描述串化形态。
- 踩坑记档：typebox 1.x 校验面在 `typebox/value` 子路径（`import { Value } from 'typebox/value'`），根导出无 `Value`——与宿主再导出面（`src/contracts/typebox.ts`）一致。

## 可证伪项③：better-sqlite3 worker 多线程 + WAL 互见 → **PASS**

- 连接不跨线程（不可克隆），主线程与 worker **各自打开自己的连接**指向同一文件——正是落码形态。
- WAL 跨连接可见性双向实证：worker 读到主线程已提交行；主线程回读 worker 提交行。
- worker 内 `:memory:` 纯内存库建表读写正常（future 插件自带内存库形态）。
- native 模块在 worker_threads 内加载、运行、close 全程无崩溃。

## 对刀二的直接输入

1. **bootstrap 形态定案**：worker 内 jiti + 自 import typebox/better-sqlite3 全部可用——worker realm 可以完整重建 `berryagent` 虚拟面（jiti 虚拟注入照搬 `src/context/loader.ts` 现行机制）。
2. **schema 过界零折损**：工具 parameters/config schema 可作为消息 payload 直接过界，宿主侧守门管道用自己实例校验。
3. **物理面不需要跨线程连接**：worker 侧插件若用 SQLite，自开连接即可（WAL 互见）；宿主连接永不外借。

## hello 过界补票（闸门第四项·完整性尾款）→ **PASS**

> 冷读裁决：完整 hello 过界（ctx 桩 RPC 往返，含一次同步面调用 + 一次 signal→cancel 取消传播）
> 为刀二桥模块首 commit 前置——三炮只证机制件可用，协议本体的两隐性假设只有过界才能暴露。
> 已于同日兑现（`4-hello.mjs` 三件：宿主编排面 / worker 桩侧 / TS 金样插件过 jiti），六断言全 PASS。

- **① 同步面调用（同步阻抗）**：插件（TS，worker 域内 jiti 装载）经桩 `await ctx.tools.call('echo', …)`
  过界往返——调用点同步形态、底层 ask/result 两跳。**同步函数过界结构性不可能**，Promise 面是唯一形态——
  这不是实现限制是物理限制（结构化克隆无函数），刀二代理桩的 API 面据此定形。
- **② 取消传播（signal→cancel）**：`AbortSignal` 不可克隆——**信号本体永不过界，过界的是 `{kind:'cancel', callId}`**。
  桩在 abort 监听器里**本地立即结算**（拒绝 `BRIDGE_CANCELLED`，实测 4ms，不等宿主往返）+ 发取消消息；
  宿主收 cancel 掐断在途工作（slow 工具 workedMs=108 < 1000——编排 80ms 档 + 25ms 档间隔，量级正合）；
  宿主随后仍发出的迟到 result 由桩侧**迟到丢弃分支**吸收（lateResults 恰 1，无二次结算、无未处理拒绝）。
- **对刀二的直接定形**：迟到纪律（迟到不复活）与「本地结算不等往返」两条桩语义，就是 §1.7 桥接协议 v0
  cancel 条款的执行面；错误信封 `{code, message}` 纯 JSON 可克隆，与宿主 AppError 面同构。
- **边界注记（教学点）**：协作式 yield（25ms 档查 signal）才可取消；**紧密同步循环收不到任何消息**——
  协议 cancel 对其无效，那是 watchdog terminate（刀〇b 四时钟族）的辖区。cancel 与 terminate 分工即此。

---

# PoC 结论记档：fork 域九炮+半炮+两核对（第三十七批·external carrier 前置闸）

> 2026-08-28/29 实跑。环境：Node v24.18.0 / darwin 27（本机无 22 线——22 线可用性判断见核对 A/B）。
> 判定基准 = d37 报告 §3 题 5 PoC 清单（四补炮 + 对抗冷读四新炮 + 半炮 + 两核对）。
> 运行方式：`node tools/poc-worker/N-xxx.mjs`（5–13 号），退出码 0/1 = PASS/FAIL（⑫⑬ 记档型见各自条目）。

## ⑤ jiti-in-fork → **PASS**

- fork 子进程内 `createJiti(import.meta.url, { moduleCache: false })`（与宿主装载器同款配置）装载 TS 插件，
  named + default 导出全对；改写插件文件后同实例再 import 拿到新代码——`/reload` 重载语义在 fork 域成立。
- 与 worker 域（第二十七批①）同结论：装载器核心机制可原样搬进 fork 域。

## ⑥ typebox 过 fork channel → **PASS**

- 父子两进程各自 import 同一物理 typebox（跨进程双实例），schema 对象经 IPC（structured clone）双向过界，
  对侧用自己实例 `Value.Check`：合法值过、非法值拒；**symbol 键存活数 = 0**——schema 纯 JSON 形零折损。
- 与 worker 域（第二十七批②）同结论：工具 parameters schema 可直接作 IPC payload，无需串化降级。

## ⑦ better-sqlite3 PM 禁令 → **PASS**

- PM 下（`--permission` 无 `--allow-addons`）：子进程 `createRequire` 引入 better-sqlite3 →
  `ERR_DLOPEN_DISABLED`（native addon 被 PM 拒载——**拒载即拒装语义在引擎层现成**，d37 题 3 OS 层
  fail-closed 拒装的底座证据）。
- 加 `--allow-addons` 开闸后 `:memory:` 建表插查 round-trip 正常——白名单放行形态同款可用。

## ⑧ PM 白名单推导器 → **PASS**（三坑全记档）

- 推导器 `derivePmFlags(roots)` 四探测全过：读白名单内通 / 写白名单内通 / 读外拒 / 写外拒
  （拒码均 `ERR_ACCESS_DENIED`）。
- **坑一（darwin 路径形）**：tmpdir 在 `/var`（→ `/private/var` 的 symlink），PM 按归一化绝对路径匹配——
  白名单与子进程运行时路径须同形：两侧统一 `realpathSync` 归一。
- **坑二（v24 实证）**：`--allow-fs-read=a,b` 逗号拼接多路径已废弃（warning「no longer valid」）——
  整串被当单一字面路径，白名单静默错形 → **多根必须每根重复一旗**（`--allow-fs-read=a --allow-fs-read=b`）。
- **坑三（v24 实证）**：写白名单根目录若不存在，realpath 归一断链 → 根内写被 `ERR_ACCESS_DENIED` 拒
  （而非 ENOENT）——白名单静默失效形态 → **写根必须预建**。
- `--permission` 总开关必须领衔（漏则 `ERR_MISSING_OPTION: --permission is required`）。
- 附记（bad option 形态，只记档不判 FAIL）：`--permission-audit` 与 `--config-file` 在 v24.18.0 均为
  bad option（版本线见核对 A/B）。

## ⑨ fork 树杀建组 → **PASS**

- `fork(childPath, [], { detached: true, stdio: [...,'ipc'] })`：子自成组长（pgid==pid），域内再 spawn 的
  孙进程继承 pgid，`process.kill(-pgid, 'SIGKILL')` 整组收割（孙死透 ESRCH 实证）。
- 对照组：非 detached fork 与父同进程组——**负 pid 杀会误伤父域**：建组是树杀唯一正解
  （exec 腿 spawn 默认 detached 建组的既有语义，fork 腿须显式 `detached:true` 才同构——原研究「直接复用」
  断言由本炮坐实为「显式建组后同构」）。
- Node 语义记档：fork 显式 stdio 数组须含 `'ipc'` 席位（否则 `process.send` undefined）；`child.killed`
  只表示「发过信号」不表示「死了」，判活只看 `child.exitCode === null`。

## ⑩ NDJSON stdio 背压与大 payload → **PASS**

- 大 payload：1MiB 单行 JSON 过 pipe，父侧重算 sha256 对照无损（`recvLen > 1MiB` 同断）。
- 洪泛：2KiB×N 行连续灌，子侧 `write()` 返 false（背压信号出现）且父侧 seq 无缺口
  （`seqs.every((s,i)=>s===i)`）——**NDJSON over pipe 在背压下不丢行不乱序**，64KiB 护栏的跨进程
  传输底座成立。

## ⑪ 信号编舞三段传导 → **PASS**

- 景一乖子：SIGTERM handler 打告别行 + 50ms 收尾自然退——**告别行先于 exit、signal===null**（宽限期内
  自然退，无需升级）。
- 景二赖子：空 handler 吞 SIGTERM → 父宽限 600ms 后升级 SIGKILL → 子被强杀（signal===SIGKILL）。
- 景三 PM 子：`--permission` 沙箱内的子照常收 SIGTERM 并告别——**PM 管文件系统与 addon，不管信号投递**
  （d37 判词实证）。
- 教学点：赖子景升级判据只看 `exitCode === null`——`child.killed` 在发过 SIGTERM 后恒 true，拿它判活
  会把升级分支挡死（挂死形态）。

## ⑫ UDS bind 逃逸负向炮 → **跑齐（跑 A 逃逸实证 + 跑 B 正路 PASS）**

- 跑 A（写白名单只给 allowedDir）：PM 子在白名单外目录——**同目录普通文件写拒
  （`ERR_ACCESS_DENIED`）而 UDS bind 通**（socket 文件落在白名单外目录）→ **PM 对 UDS bind 不设防，
  CVE-2026-21711 同型实证**——「PM 只能当中层，不能当墙」自证：fs 白名单语义管「路径访问」，不管
  bind() 创建 socket 文件这条 syscall 路。
- 跑 B（白名单内）：bind + 客户端回环 echo 正常——正路可用性复证（external 域 IPC 选 UDS 不受此判影响，
  判的是越界 bind）。
- 本炮判定对象是「PM 真实边界在哪」——跑 A 两走向都是有效记档；实测走向 = 逃逸侧。

## ⑬ 宿主 RSS 下 fork 冷启（半炮）→ **采集跑齐**

- 组一（基线 RSS≈46MB）：冷启中位 48.6ms；组二（驻留 +256MB）：47.0ms——**Δ 噪声级，darwin 下
  spawn 走 posix_spawn 路径与宿主 RSS 解耦**。
- val.town 14GB/300ms 数据是 Linux `fork()` 页表复制成本模型——**Linux 服务器形态才需把宿主胖瘦计入
  子域冷启预算**；darwin 开发机上不构成约束。全量重跑 Δ=1.3ms 同为噪声级，结论稳定。

## 两核对

### 核对 A：audit 八通道覆盖面 vs CVE 绕过清单 → **「覆盖 ⊇ 绕过」为假（结构性）**

- `--permission-audit` **v24.18.0 实证 bad option**（d37 报告 v26 口径成立；22 线更低版本同判不可用）——
  观测面在当前引擎线不可用，报告 §3 题 4 附注的降级路径（域内 SDK 捕获上报）是现实主路。
- 逐项对照（绕过清单 d37 §2 vs 八通道 fs/net/child/worker/inspector/wasi/addon/ffi），绕过分三类，三类都
  **不产生 deny 事件**：
  1. **裁决错误型**（CVE-2026-58043 radix-tree over-grant、CVE-2026-21715 realpathSync）：执法判 allow 时
     audit 照记 allowed——观测忠实记录错误裁决，发现不了绕过；
  2. **执法不管辖型**（CVE-2026-21711 UDS bind〔⑫已实证〕、已开 fd 绕过、`node:sqlite` 旁路）：操作不触发
     执法 → 无 audit 事件——**静默 ≠ 安全**；
  3. **通道外 API 型**（`process._debugProcess(pid)` 跨进程）：不走 child_process 执法面的跨进程操作。
- 结构性结论：audit 记录的是**执法器的裁决流**，通道枚举 ≠ 漏洞位置枚举——观测面继承执法盲区不是「可能」
  而是必然。deny 落账的价值收窄为**合规件越权尝试的审计**（正常件踩线被拒的记录），不是入侵检测；
  观测不得反哺围栏（d37 原判）由此更锋利。

### 核对 B：`--permission-audit` 与 node.config.json 可用性 → **PM 旗经 config 文件真生效（正名后）**

- `--permission-audit`：v24.18.0 bad option（实证）——版本线按 d37 v26 口径收口。
- config 文件正名 **`--experimental-config-file`**（23.10.0 引入 / 22.16.0 LTS 回移 / 24.0.0+——官方
  23.10.0 发布说明确认；`--config-file` 是 bad option）。schema 字段名 **`nodeOptions`**（对象，键 = 旗名
  不带 `--`）。
- **PM 旗真生效哨兵实证**：`{"nodeOptions":{"permission":true,"allow-fs-read":"*"}}` → 子进程无旗拉起，
  写探测 `ERR_ACCESS_DENIED`——PM 旗面可经 config 文件携带（本核对曾以错误字段名 `flags` 误判
  「解析但不应用」，正名后反转；v24.18 对未知字段静默忽略，**v26.1.0 才 throw-at-unknown-fields**——
  静默坑记档）。
- 限制三记：V8 旗硬错（`expose-gc` → "V8 flag not supported"——config 可带旗集受限）；cwd 自动发现
  **默认关**（须显式 `--experimental-default-config-file` 才读 cwd 的 node.config.json——实证：无旗时
  config 不被发现〔写通〕、显式旗时被发现并应用〔写拒〕。安全含义：应用目录自带 node.config.json
  不会被意外自动应用；但 carrier 若显式开此旗 = 把旗面交给应用目录控制——不可开）；官方原话
  「Node.js will not sanitize or perform validation on the user-provided configuration, so only ever
  use trusted configuration files」。
- **生产含义**：external carrier 传 PM 旗两路皆通——**显式 execArgv 首选**（cwd 无关、旗面全量可控、
  无实验性前缀依赖），config 文件为备（实验性前缀 + 未知字段静默坑 + 须可信文件）。与 e1 宿主沙箱
  「execArgv 随行」教训同向。

## 对 external carrier 落码的直接输入

1. **装载/类型/存储三件全可用**：fork 域 jiti 重载、schema 过 IPC 零折损、better-sqlite3 全进程可用
   （PM 下受 `--allow-addons` 管辖——external 域开关即引擎级拒载面）。
2. **PM 白名单推导器三坑即落码规范**：realpath 同形 / 每根一旗 / 写根预建——推导器代码（⑧）可直接搬。
3. **树杀编舞定形**：fork 腿显式 `detached:true` 建组 + 负 pid SIGKILL 收割；信号三段
   （告别→宽限 `exitCode===null` 判活→升级）+ PM 不拦信号——与 e1/bridge 既有编舞同构拼接。
4. **传输底座**：NDJSON over pipe 背压安全，64KiB 护栏可跨进程沿用；UDS 白名单内可用（越界 bind 是
   PM 的漏不是我们的）。
5. **PM 定位再收口**：中层非墙（⑫逃逸 + 核对 A 结构论证）——external 域执法面 = 进程墙（OS 层）+
   PM（fs/addon 中层）+ grants 交集（应用层），三层各司其职，PM 不单独扛。
