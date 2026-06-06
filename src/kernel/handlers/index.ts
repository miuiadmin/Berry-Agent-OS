export { registerAllHandlers } from './unified-handlers.js';
// R8-2：handleMessage / handleChannelMessage 已统一迁入 unified-handlers.ts，
// 不再从 messaging-handlers 导出（messaging-handlers.ts 已删除）。
export { handleMessage, handleChannelMessage } from './unified-handlers.js';
