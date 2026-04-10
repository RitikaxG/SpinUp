export const CONTROL_PLANE_INTERVAL_MS = 20_000;

export const HEALTH_TIMEOUT_MS = 5_000;
export const CONTAINER_STATUS_TIMEOUT_MS = 5_000;

export const HEARTBEAT_FAILURE_THRESHOLD = 3;

// Tick-level lock for the worker loop
export const CONTROL_PLANE_TICK_LOCK_TTL_MS = 15_000;

// Runtime mutation lock must outlive provisioning waits
export const PROJECT_RUNTIME_LOCK_TTL_MS = 240_000;