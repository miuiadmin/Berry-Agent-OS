
import { useEffect } from "react";
import { useT } from "@/lib/i18n";

/**
 * 设置浏览器标签页标题。
 * 有标题时显示 "{title} | Berry"，无标题时显示 "Berry 仪表盘"。
 * 使用 i18n 字典确保品牌名和默认标题跟随当前语言。
 * 依赖 t 函数，切换语言时标题自动更新。
 */
export function useDocumentTitle(title: string) {
  const t = useT();
  useEffect(() => {
    document.title = title ? `${title} | ${t("brand.name")}` : t("brand.dashboard");
  }, [title, t]);
}
