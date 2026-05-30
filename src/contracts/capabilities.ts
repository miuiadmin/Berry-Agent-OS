export type CapabilityAction =
  | 'capability.skills.list'
  | 'capability.plugins.list'
  | 'capability.plugins.inspect'
  | 'capability.plugins.validate'
  | 'capability.plugins.dry_run';

export interface CapabilityRequestPayload {
  action: CapabilityAction;
  payload: Record<string, unknown>;
}

export interface CapabilityResponsePayload {
  ok: boolean;
  result?: unknown;
  error?: string;
}
