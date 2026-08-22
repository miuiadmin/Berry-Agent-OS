/**
 * L0 contracts — 跨模块公共契约（零依赖层，拓扑检查强制：不得 import 任何其他模块与三方包）。
 * 词汇纪律见内核篇 §5：新词先进词汇表再用，禁止双词汇漂移。
 */

export * from './errors.js';
export * from './events.js';
