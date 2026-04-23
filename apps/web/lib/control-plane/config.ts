export const CONTROL_PLANE_INTERVAL_MS = 20_000;

export const HEALTH_TIMEOUT_MS = 5_000;
export const CONTAINER_STATUS_TIMEOUT_MS = 5_000;

export const HEARTBEAT_FAILURE_THRESHOLD = 3;

/**
 * Worker lock must outlive a slow heartbeat + warm-pool reconcile cycle.
 * Keep it comfortably above the interval so overlapping ticks cannot start.
 */
export const CONTROL_PLANE_TICK_LOCK_TTL_MS = Math.max(
  CONTROL_PLANE_INTERVAL_MS * 3,
  60_000,
);

/**
 * Worst-case runtime boot path can exceed:
 * - allocation wait (~180s)
 * - public IP wait (~60s)
 * - VM agent health wait (~30s)
 * - workspace ready wait (~300s)
 *
 * Keep the runtime lock above the full provisioning window.
 */
export const PROJECT_RUNTIME_LOCK_TTL_MS = 10 * 60_000;