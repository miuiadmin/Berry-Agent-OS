/**
 * 版本常量与代号（与 package.json version/codename 同步；单独成文件避免 ESM 下
 * import JSON 的解析差异）。
 *
 * 代号体系（技术栈篇 §8.1，2026-08-31 第五十批拍板）：每个 major 版本一个
 * 英文代号——取自中国考古文化年代序列（从最早的新石器文化到青铜时代，暗合
 * 「Agent 在 Berry 里慢慢变老」的版本叙事）。prerelease 不换代号，minor 不
 * 换代号，仅 major 跃迁时进入下一个文化时代。beta 起对外亮代号。
 *
 * 已拍序列（七代）：
 *   1.x Peiligang（裴李岗）· 2.x Hemudu（河姆渡）· 3.x Yangshao（仰韶）
 *   4.x Liangzhu（良渚）· 5.x Erlitou（二里头）· 6.x Sanxingdui（三星堆）
 *   7.x Yinxu（殷墟）
 */
export const VERSION = '1.0.0-alpha.2';

/** 当前 major 版本的文化代号（品牌资产——--version / README 徽章 / Release 随附） */
export const CODENAME = 'Peiligang';

/** 版本 + 代号的完整串（`--version` / TUI 标题消费面） */
export const VERSION_WITH_CODENAME = `${VERSION} "${CODENAME}"`;
