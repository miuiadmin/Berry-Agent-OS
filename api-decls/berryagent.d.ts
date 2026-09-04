/**
 * 虚拟模块 `berryagent` 的类型面（API 治理公开面——语义见 docs/应用开发指南.md「API 稳定性与兼容性」节，第八十七批批 2）。
 *
 * 内容恒为一行再导出——真身在 dist/contracts/*.d.ts（tsconfig.api.json 声明发射
 * 产物，公开根 src/contracts/index.ts 传递闭包）。应用侧 tsconfig paths 把
 * `berryagent` 映到本文件（模板见同目录 tsconfig.paths.json）——沙盒 tsc 可解析
 * 虚拟键，类型面不再靠运行时注入后猜。
 */
export * from '../contracts/index.js';
