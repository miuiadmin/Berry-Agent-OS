/**
 * L3 webui — 官方件 `builtin:webui`（契约篇 §6.8 Web 通道第一刀，默认层
 * 第十四行，Ring 2 真·可卸件）。
 *
 * apply 形态 = **async**（contracts/app.ts AppApply 允许——本件是首个负载
 * 装载期监听的官方件）：enabled false（缺省）直接返还零监听——行惰性无害
 * （lsp 空 servers 同款先例：官方默认层带行但出厂零端口零惊喜）；enabled
 * true 则装配期 await listen——EADDRINUSE 在此映射 WEBUI_PORT_IN_USE、
 * 非回环 host 映射 WEBUI_BIND_FORBIDDEN，两者经 loader 统一走 apply 抛错
 * → 行 failed → 官方件失败行非空 = 启动断言拒启（fail-at-startup 执法非
 * 运行期警告；applyTimeoutMs 10s 挂起时钟罩住 listen 悬挂）。
 *
 * 三族信封源接线（行作用域回卷）：ctx.on('session/event') 订阅随行退订；
 * addDisplay 无注销器（chat 件 front 面是 Ring 1——/reload 不回卷）由
 * channel.closed 旗标自守；ui().attach 的 Disposer 挂 ctx.effect。
 */

import { AppError, WEBUI_BIND_FORBIDDEN, WEBUI_PORT_IN_USE } from '../contracts/errors.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import { WebuiChannel } from './channel.js';
import { createPendingApprovals } from './approvals.js';
import { createWebuiServer, isLoopbackBindValue } from './server.js';
import {
  DEFAULT_WEBUI_HOST,
  DEFAULT_WEBUI_PORT,
  WEBUI_APP_CONFIG_SCHEMA,
  type WebuiAppConfig,
  type WebuiAppDeps,
} from './types.js';

/**
 * 构造 webui 官方件（builtins 注册表 `builtin:webui` 行）。deps 全为组合根
 * 闭包（官方件特权——ToolsAppDeps 先例同构；构造点早于 ring1 装载，全部
 * 活取值形态，调用时点恒在装载后）。
 */
export function createWebuiApp(deps: WebuiAppDeps): BuiltinAppModule {
  return {
    name: 'webui',
    config: WEBUI_APP_CONFIG_SCHEMA,
    apply: (ctx: AppContext, config?: Readonly<Record<string, unknown>>) =>
      applyWebuiApp(ctx, config as WebuiAppConfig | undefined, deps),
  };
}

/** 件 apply 本体（异常上抛走加载器统一回卷 APP_APPLY_FAILED） */
async function applyWebuiApp(ctx: AppContext, config: WebuiAppConfig | undefined, deps: WebuiAppDeps): Promise<void> {
  // 配置缺省解析（enabled 缺省 false = 行惰性零监听——直接返还，不起任何资源）
  const cfg = config ?? {};
  if (cfg.enabled !== true) return;
  const port = cfg.port ?? DEFAULT_WEBUI_PORT;
  const host = cfg.host ?? DEFAULT_WEBUI_HOST;

  // 防线①绑定（fail-at-startup）：显式非回环 host = 拒（服务器形态双皮到位
  // 前不开——技术栈篇 §4.4 分界；Host/Origin 白名单值域与本判定三值对称）
  if (!isLoopbackBindValue(host)) {
    throw new AppError(
      WEBUI_BIND_FORBIDDEN,
      `webui 监听地址非回环值（host = ${host}）——单机形态只允许 127.0.0.1 / localhost / ::1（服务器形态双皮另批）`,
    );
  }

  // 通道半边（连接扇出 + 广播后端）+ pending 审批登记簿（刀三：镜像注册/claim
  // 桥/两端点消费面——随行生命周期）+ 服务半边（微路由——只造不启）
  const channel = new WebuiChannel();
  const approvals = createPendingApprovals();
  const { server, close } = createWebuiServer({
    port,
    host,
    deps,
    channel,
    approvals,
    // daemon token 鉴权物（daemon 刀一·P1）：daemon 形态组合根注入——/api 族
    // 全量执法 + cookie 桥；--port 手开形态缺省免鉴权（回环三防线即闭环）
    ...(deps.auth !== undefined ? { auth: deps.auth } : {}),
    // 静态根 = 本件目录（位置事实而非声明：tsc 直出形态下 dist/webui 即模块
    // 目录，vite 产物同目录共存；dev 形态缺 index.html = 静态 404 诊断态）
    staticRoot: import.meta.dirname,
    version: deps.version,
  });

  // 三族信封源接线（先接线后监听——boot 完成时三族源已全部就位）。session 总
  // 线镜像两消费同 handler：广播进 SSE 扇出 + pending 登记簿镜像入列（刀三：
  // asked 注册 / decided 标决——ask 落账先于 waterfall 派发的同步序保证 claim
  // 时条目恒在场）
  ctx.on('session/event', (payload: unknown) => {
    channel.onSessionEvent(payload);
    approvals.onMirror(payload);
  }); // 行作用域自动退订（/reload 回卷）
  deps.addDisplay(channel.displaySink); // 无注销器——closed 旗标自守（channel.dispose 后 no-op）
  const detach = deps.ui().attach(channel.backend); // UiService 广播面接入（notify/status 推全部连接）
  // claim 桥挂真身（刀三行面晚绑桥第一用例；daemon 刀一拓宽：claim + 帽面
  // 数据源 pendingCountBy 两键同挂——answerer 帽判据与竞速腿同一登记簿单源）；
  // 摘除器在 effect 回卷先调——holder 置空后竞速退回纯 TUI 腿
  const unmountClaim = deps.approvals.mountClaim({
    claim: approvals.claim,
    pendingCountBy: approvals.pendingCountBy,
  });

  // 回卷编舞（LIFO：本 effect 最先回卷）：先摘 claim 桥 → 登记簿卫生（未决
  // 不结算——见 approvals.ts 模块头）→ 摘广播后端 → 废弃通道（毁全部 SSE
  // 连接 + closed 旗标）→ server.close 收尾（连接已毁，close 即回）
  ctx.effect(() => () => {
    unmountClaim();
    approvals.settleAll();
    detach();
    channel.dispose();
    void close();
  });

  // 装配期监听（EADDRINUSE → WEBUI_PORT_IN_USE 拒启；其余 listen 错原样
  // 上抛走 loader 统一 APP_APPLY_FAILED——错误分类不越权收口）
  await new Promise<void>((resolveListen, rejectListen) => {
    const onListenError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('error', onListenError);
      if (err.code === 'EADDRINUSE') {
        rejectListen(
          new AppError(
            WEBUI_PORT_IN_USE,
            `webui 端口被占用（${host}:${port}）——fail-at-startup 拒启（换端口或停占用者）`,
          ),
        );
        return;
      }
      rejectListen(err);
    };
    server.once('error', onListenError);
    server.listen(port, host, () => {
      server.removeListener('error', onListenError);
      resolveListen();
    });
  });
}
