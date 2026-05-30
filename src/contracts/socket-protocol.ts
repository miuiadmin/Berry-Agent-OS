export type ProgressStatus = 'thinking' | 'using_tool' | 'reviewing' | 'routing' | 'dispatching' | 'asking' | 'streaming' | 'done';

export interface SocketProgressEvent {
  type: 'progress';
  status: ProgressStatus;
  summary: string;
  taskId?: string;
}

export interface SocketTextDeltaEvent {
  type: 'text_delta';
  text: string;
  taskId?: string;
}

export interface SocketResultEvent {
  type: 'result';
  response: string;
  sessionId: string;
  taskId: string;
}

export interface SocketErrorEvent {
  type: 'error';
  error: string;
  code?: string;
}

export interface PermissionListEvent {
  type: 'permissions.list';
  sessionId?: string;
}

export interface PermissionResolveEvent {
  type: 'permissions.approve' | 'permissions.deny' | 'permissions.cancel';
  requestId: string;
  reason?: string;
  allowSession?: boolean;
}

export interface SocketInterruptEvent {
  type: 'interrupt';
  sessionId: string;
  reason?: string;
}

export interface SocketInterruptedEvent {
  type: 'interrupted';
  sessionId: string;
  taskId?: string;
  partialResponse?: string;
}

// --- Socket request/response type map ---

export interface AgentsListRequest {
  type: 'agents.list';
  source?: string;
  status?: string;
}

export interface AgentsInspectRequest {
  type: 'agents.inspect';
  name: string;
}

export interface AgentsInstallRequest {
  type: 'agents.install';
  dir: string;
}

export interface AgentsRemoveRequest {
  type: 'agents.remove';
  name: string;
  force?: boolean;
}

export interface AgentsUpgradeRequest {
  type: 'agents.upgrade';
  name: string;
}

export interface AgentsEnableRequest {
  type: 'agents.enable';
  name: string;
}

export interface AgentsDisableRequest {
  type: 'agents.disable';
  name: string;
  reason?: string;
}

export interface AgentsReloadRequest {
  type: 'agents.reload';
}

export type SocketRequestType =
  | 'handshake'
  | 'status'
  | 'health'
  | 'logs.level.get'
  | 'logs.level.set'
  | 'permissions.list'
  | 'permissions.approve'
  | 'permissions.deny'
  | 'permissions.cancel'
  | 'model.override'
  | 'model.get'
  | 'evolution.dispatch'
  | 'message'
  | 'interrupt'
  | 'agents.list'
  | 'agents.inspect'
  | 'agents.install'
  | 'agents.remove'
  | 'agents.upgrade'
  | 'agents.enable'
  | 'agents.disable'
  | 'agents.reload'
  | 'daemon.register'
  | 'daemon.heartbeat'
  | 'daemon.task.claim'
  | 'daemon.task.started'
  | 'daemon.task.progress'
  | 'daemon.task.result'
  | 'daemon.disconnect';
