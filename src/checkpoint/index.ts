/**
 * L3 checkpoint — 公开面收口（模块边界纪律：跨模块消费经 index 再导出）。
 *
 * 官方快照·回退件（会话篇 §5.3）：工作区快照（sha256 blob 内容寻址仓 +
 * per-run manifest）+ /rewind 两段回退（files first → fork+adopt）。
 * 件本体 createCheckpointApp；词汇 CHECKPOINT_EVENT_TYPES 供测试/门禁消费。
 */

export { createCheckpointApp, checkpointConfig, type CheckpointAppDeps } from './app.js';
export { CHECKPOINT_EVENT_TYPES } from './events.js';
export { createGitAnchorTracker, type GitProbeFace, type GitProbeState, type GitProbeDelta } from './git-anchor.js';
export {
  MAX_SNAPSHOT_FILE_BYTES,
  type CheckpointManifest,
  type ManifestFileEntry,
  type ManifestInventory,
  listSessionManifests,
  listAllManifests,
  ensureLayout,
} from './store.js';
export { captureSnapshot, prunePlan, executePrune, type CaptureContext, type CaptureMeta } from './snapshot.js';
export { restoreWorkspace, type RestoreReport } from './restore.js';
