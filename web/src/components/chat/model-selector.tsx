/**
 * ModelSelector — 模型切换选择器。
 *
 * 移动端：底部 sheet（可拖拽手柄）；桌面端：下拉浮层。
 * 支持搜索过滤 + 手动输入 model ID + 跳转 Provider 设置。
 */

import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useModelConfig } from "./use-model-config";

/** 面板内搜索/手动输入的统一样式（移动端 16px 防 iOS 缩放；移动端 h-10=40px 最小触控目标） */
const INPUT_BASE = "h-10 rounded-md border border-input bg-muted/50 text-[16px] outline-none focus:border-ring focus:ring-1 focus:ring-ring/30 md:h-auto md:py-1.5 md:text-xs";

/** 模型对象最小契约（FlatModel 满足此结构；用最小接口避免耦合具体类型） */
interface ModelOption {
  id: string;
  name: string;
  channelId: string;
}

/** 不区分大小写的子串匹配（用于按 name/id 过滤模型） */
function matches<T extends ModelOption>(model: T, query: string): boolean {
  const q = query.toLowerCase();
  return model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q);
}

export function ModelSelector() {
  const { currentModel, channels, allModels, switchModel } = useModelConfig();
  const t = useT();
  const navigate = useNavigate();
  /** 选择器面板是否展开 */
  const [open, setOpen] = useState(false);
  /** 手动输入的 model ID */
  const [editModel, setEditModel] = useState("");
  /** 搜索过滤词 */
  const [filter, setFilter] = useState("");

  /** 打开面板时重置输入态，避免上次残留 */
  const handleOpen = () => { setEditModel(""); setFilter(""); setOpen(true); };
  /** 选择模型切换并关闭面板 */
  const handleSwitch = (model: string, channelId?: string) => {
    switchModel(model, channelId);
    setOpen(false);
  };

  /** 手动输入 model ID 并切换（空值忽略） */
  const handleManualSwitch = () => {
    const trimmed = editModel.trim();
    if (trimmed) { switchModel(trimmed); setOpen(false); }
  };

  /**
   * 跳转 Provider 设置页。
   * 用 react-router 编程式导航（而非整页 <a href>），保留 SPA 状态——
   * 之前用 <a href="/settings?tab=providers"> 是整页跳转，会丢失当前对话的流式生成状态。
   * SPA 内路由切换不会卸载聊天 store，stream 中切走再切回仍能续接。
   */
  const handleOpenProviders = () => {
    setOpen(false);
    navigate("/settings?tab=providers");
  };

  /** 根据搜索词过滤模型（匹配 name 或 id） */
  const filtered = useMemo(
    () => (filter ? allModels.filter((m) => matches(m, filter)) : allModels),
    [allModels, filter],
  );
  /** filtered 中能匹配到任一渠道分组的模型（filtered 可能有匹配但 channelId 不在 channels 里，此时无分组可渲染） */
  const visibleChannelModels = useMemo(
    () => {
      const channelIds = new Set(channels.map((c) => c.id));
      return filtered.filter((m) => channelIds.has(m.channelId));
    },
    [filtered, channels],
  );

  return (
    <div className="relative">
      {/* 触发按钮（移动端 44px 触控目标） */}
      <button type="button" onClick={handleOpen}
        className="flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:min-h-0">
        <span className="max-w-[100px] truncate text-[11px] md:max-w-[140px] md:text-xs">{currentModel}</span>
        <ChevronDown className="size-3" />
      </button>

      {open && (
        <>
          {/* 透明遮罩（点击关闭面板） */}
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} aria-hidden="true" />

          {/* 面板：移动端底部 sheet / 桌面端下拉浮层 */}
          <div className="fixed inset-x-0 bottom-0 z-50 flex max-h-[70vh] flex-col rounded-t-2xl border border-border bg-background shadow-lg md:absolute md:bottom-auto md:inset-x-auto md:right-0 md:top-full md:mt-1 md:w-80 md:rounded-lg md:max-h-[400px]">
            {/* 移动端拖拽手柄 */}
            <div className="flex justify-center pt-2 md:hidden">
              <div className="h-1 w-8 rounded-full bg-muted-foreground/30" />
            </div>

            {/* 标题 + 当前模型 */}
            <div className="shrink-0 px-4 pb-1 pt-2 md:px-3 md:pt-3">
              <div className="text-sm font-medium">{t("chat.switchModel")}</div>
              <div className="text-[11px] text-muted-foreground">{t("chat.currentModel")}: {currentModel}</div>
            </div>

            {/* 搜索框 */}
            <div className="shrink-0 px-4 pb-2 md:px-3">
              <input type="text" placeholder={t("chat.searchModels")} aria-label={t("chat.searchModels")}
                value={filter} onChange={(e) => setFilter(e.target.value)}
                className={cn("w-full px-3 py-2", INPUT_BASE)} autoFocus />
            </div>

            {/* 模型列表（按渠道分组） */}
            <div className="flex-1 overscroll-contain overflow-y-auto px-2 md:px-1">
              {filtered.length === 0 || visibleChannelModels.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">{t("chat.noModels")}</div>
              ) : (
                channels.map((ch) => {
                  const chModels = filtered.filter((m) => m.channelId === ch.id);
                  if (!chModels.length) return null;
                  return (
                    <div key={ch.id} className="mb-1">
                      <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{ch.name}</div>
                      {chModels.map((m) => (
                        <button type="button" key={m.id}
                          onClick={() => handleSwitch(m.id, ch.id)}
                          className="flex w-full min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent md:min-h-0 md:py-1.5">
                          <div className="min-w-0">
                            <div className="truncate">{m.name}</div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">{m.id}</div>
                          </div>
                          {/* 当前选中模型标识 */}
                          {m.id === currentModel && <span className="ml-2 size-1.5 shrink-0 rounded-full bg-brand" />}
                        </button>
                      ))}
                    </div>
                  );
                })
              )}
            </div>

            {/* 手动输入 model ID */}
            <div className="shrink-0 border-t border-border px-4 py-2 md:px-3">
              <div className="flex gap-1.5">
                <input type="text" placeholder={t("chat.orEnterModelId")}
                  value={editModel} onChange={(e) => setEditModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleManualSwitch(); }}
                  className={cn("flex-1 px-2.5 py-2", INPUT_BASE)} />
                <Button size="sm" onClick={handleManualSwitch} disabled={!editModel.trim()}
                  className="min-h-[44px] md:min-h-0">
                  {t("common.apply")}
                </Button>
              </div>
            </div>

            {/* Provider 设置跳转（react-router 编程式导航，避免整页跳转丢失流式状态） */}
            <div className="shrink-0 border-t border-border px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:px-3 md:pb-2">
              <button type="button" onClick={handleOpenProviders}
                className="min-h-[44px] md:min-h-0 text-[11px] text-brand hover:underline">
                {t("chat.configureProviders")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
