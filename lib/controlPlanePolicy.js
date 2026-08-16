export const CONTROL_PLANE_SCHEMA_VERSION = 6;
export const LIFETIMES_MS = Object.freeze({
  packet: 30 * 60_000,
  resultRecovery: 30 * 60_000,
  checkpoint: 24 * 60 * 60_000,
  inactivity: 2 * 60 * 60_000,
  absoluteRun: 24 * 60 * 60_000,
  metadata: 90 * 24 * 60 * 60_000,
});
export const RUN_STATES = new Set(['active','recovery_required','ready_for_delivery','completed','failed','deletion_requested','deleted','expired']);
export const TERMINAL_REQUEST_STATES = new Set(['completed','failed','deletion_requested']);
export function effectiveExpiry(lastActivity, absoluteDeadline) {
  return new Date(Math.min(new Date(lastActivity).getTime() + LIFETIMES_MS.inactivity, new Date(absoluteDeadline).getTime()));
}
