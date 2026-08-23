/**
 * L0 contracts — typebox 宿主再导出面（契约篇 §1.2 生态读码补钉 pi-12）。
 *
 * 插件写 parameters/config schema 的唯一取用路径 = 宿主注入的 typebox：
 * ①经虚拟模块 `typebox` 直取（加载器注入宿主实例）；②经宿主公共面
 * `berryagent`（= contracts 导出面）的再导出取。两条路同一实例——插件禁自装
 * typebox（peerDependencies 声明 + 加载器虚拟注入防双实例；pi 生态
 * rpiv-ask-user-question 的 Static 双实例 + `as unknown as` 裸 cast 实证反例）。
 */

/** schema 构建器（Type.Object/Type.String/… —— 唯一合法构建路径） */
export { Type } from 'typebox';
/** schema 静态推导类型（插件参数/配置面类型标注） */
export type { Static, TSchema } from 'typebox';
/** 校验/默认值/错误格式化面（行 config 启动校验、工具参数校验共用） */
export { Value } from 'typebox/value';
