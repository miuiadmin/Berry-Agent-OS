/**
 * L4 exec — 子进程环境白名单（契约篇 §1.2 E 组执法面②，2026-08-25 exec 纵切
 * 规范先行定稿）：**deny-by-default**——宿主 spawn 子进程只透传白名单变量，
 * `ExecOptions.env` 声明式变更表（inherit/set/unset）在白名单之上叠加。
 *
 * 永不透传两类（inherit 名单命中 = EXEC_ENV_FORBIDDEN 响亮拒）：
 * - 凭证族：变量名后缀 `_AUTH_TOKEN`/`_API_KEY`/`_ACCESS_TOKEN`/`_SECRET`/
 *   `_TOKEN`/`_PASSWORD`（大小写不敏感）；
 * - 宿主保留前缀：`ANTHROPIC_*`/`OPENAI_*`/`APP_*`（大小写不敏感）。
 *
 * 纪律同源声明：与运行时骨架篇 §6.6 `scrubbedParentEnv` 同族异向——那边是
 * 「宿主收编外部 agent」的凭证清洗剥离，这边是「宿主 spawn 子进程」的
 * 白名单注入——**env 面永远显式声明、永不隐式继承**。
 */

import { AppError, EXEC_ENV_FORBIDDEN } from '../contracts/errors.js';
import type { ExecEnvTable } from '../contracts/exec.js';

/**
 * 初始白名单（v1 起点，随实证增补——契约篇 §1.2 拍板清单）：
 * 机器运行必需族 + 证书定位 + 代理（大小写各列）。
 * 过窄 bash 基本不可用（无 PATH 子命令全废、无 HOME git/ssh 全废）——
 * 白名单只装「子进程自身运转」所需，不装业务语义。
 */
const ENV_ALLOWLIST_EXACT: ReadonlySet<string> = new Set([
  // 机器运行必需族
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'TZ',
  'LANG',
  // 证书定位（企业代理环境 git/npm 必需）
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // 代理（小写为大写的主流惯例并存——两者都常见，显式双列）
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);

/** 前缀型白名单（locale 族——LC_ALL/LC_CTYPE/… 逐一枚举不如前缀） */
const ENV_ALLOWLIST_PREFIXES: readonly string[] = ['LC_'];

/** 凭证族后缀（大小写不敏感匹配——应用经 exec 走私 env 的主通道） */
const ENV_FORBIDDEN_SUFFIXES: readonly string[] = [
  '_AUTH_TOKEN',
  '_API_KEY',
  '_ACCESS_TOKEN',
  '_SECRET',
  '_TOKEN',
  '_PASSWORD',
];

/** 宿主保留前缀（大小写不敏感——宿主自身配置面永不进子进程） */
const ENV_RESERVED_PREFIXES: readonly string[] = ['ANTHROPIC_', 'OPENAI_', 'APP_'];

/** 变量名是否在初始白名单内（exact 或前缀族命中） */
export function isEnvNameAllowlisted(name: string): boolean {
  if (ENV_ALLOWLIST_EXACT.has(name)) return true;
  for (const prefix of ENV_ALLOWLIST_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 变量名是否命中禁运两类（凭证族后缀 / 宿主保留前缀——大小写不敏感）
 */
export function isEnvNameForbidden(name: string): boolean {
  const upper = name.toUpperCase();
  for (const suffix of ENV_FORBIDDEN_SUFFIXES) {
    if (upper.endsWith(suffix)) return true;
  }
  for (const prefix of ENV_RESERVED_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

/* ---------------- 宿主主动注入通道（契约篇 §1.2 E 组执法面②，2026-08-31
 * 第四十四批灵感 8）----------------
 *
 * 白名单之外，**宿主自身**可向子进程注入身份标识变量（区别于 env 透传：
 * 注入值是宿主创作的值，不是把宿主 process.env 搬进子进程）。词表封闭——
 * v1 恰两件，新词随实证增补 = 规范先行修契约篇，非码面自由扩展：
 * - `APP_SESSION_ID`：发起执行的当前会话 id（无会话语境 = 诚实缺席不注入）；
 * - `AI_AGENT`：运行时标识（生态互认位——子进程可探测「跑在 AI agent 会话里」；
 *   值 = 'berry' 是与 bin.berry 同族的对外呈现值位，非代码标识符——
 *   去品牌化红线不适用，上位允许位清单已同批扩项）。
 *
 * inherit 名单命中注入词名照旧按禁运拒（APP_SESSION_ID 撞 APP_* 保留前缀即
 * EXEC_ENV_FORBIDDEN——inherit 走宿主 env 面本就禁运，注入值不经此路）。
 */

/** 注入值位：运行时标识（用户可见对外呈现值——与 bin.berry 同位，非标识符） */
export const HOST_INJECT_AI_AGENT_VALUE = 'berry';

/**
 * 宿主注入值合成器（两消费面单源：bash 工具按会话装配直传 sessionId，
 * ctx.exec 服务按桥帧守卫三态解析后传入）。
 * @param sessionId 发起执行的当前会话 id；undefined = 无会话语境
 * （调度 tick 等）——APP_SESSION_ID 诚实缺席，AI_AGENT 恒在
 */
export function hostInjectRecord(sessionId: string | undefined): Record<string, string> {
  return {
    AI_AGENT: HOST_INJECT_AI_AGENT_VALUE,
    ...(sessionId !== undefined ? { APP_SESSION_ID: sessionId } : {}),
  };
}

/**
 * 构造子进程环境：白名单隐式透传 + 宿主主动注入 + 变更表叠加。
 *
 * 层序（契约篇 §1.2）：白名单 → 宿主注入 → inherit → set → unset——
 * 注入层在变更表之前，故行显式 set 同名可覆盖注入值、unset 可摘除
 * （身份披露是语境不是安全边界，应用显式改写合法）。
 *
 * @param processEnv 宿主进程环境（注入式——测试可换脚本身）
 * @param table 声明式变更表（缺省 = 纯白名单透传）
 * @param hostInject 宿主主动注入值（hostInjectRecord 产物；缺省 = 无注入）
 * @returns 子进程 env 对象（spawn env 参数直接可用）
 * @throws AppError(EXEC_ENV_FORBIDDEN) inherit 名单命中禁运名——响亮拒，
 *         机器堵的是名单走私；set 显式值任意名合法不在此列
 */
export function buildChildEnv(
  processEnv: NodeJS.ProcessEnv,
  table?: ExecEnvTable,
  hostInject?: Readonly<Record<string, string>>,
): Record<string, string> {
  // 第一层：白名单隐式透传（deny-by-default——不在名单内的宿主变量不出现在子进程）
  const child: Record<string, string> = {};
  for (const name of Object.keys(processEnv)) {
    if (!isEnvNameAllowlisted(name)) continue;
    const value = processEnv[name];
    if (value !== undefined) child[name] = value;
  }

  // 第 1.5 层：宿主主动注入（白名单之后、变更表之前——见函数头注层序）
  if (hostInject !== undefined) {
    for (const [name, value] of Object.entries(hostInject)) {
      child[name] = value;
    }
  }

  if (!table) return child;

  // 第二层：inherit 显式追加（值取宿主环境；禁运名响亮拒——这是机器执法点）
  for (const name of table.inherit ?? []) {
    if (isEnvNameForbidden(name)) {
      throw new AppError(
        EXEC_ENV_FORBIDDEN,
        `env.inherit 名单命中禁运变量：${name}（凭证族后缀或宿主保留前缀不透传；确需传递请经 config/凭证库正路取得后用 env.set 显式给值）`,
      );
    }
    const value = processEnv[name];
    if (value !== undefined) child[name] = value; // 宿主无此名 = 无可透传，跳过
  }

  // 第三层：set 显式值（任意名合法——值来源纪律归执法面①，机器不猜)
  for (const [name, value] of Object.entries(table.set ?? {})) {
    child[name] = value;
  }

  // 第四层：unset 显式移除（可撤白名单内的名字）
  for (const name of table.unset ?? []) {
    delete child[name];
  }

  return child;
}
