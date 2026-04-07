export const AUTOSCALING_CONFIG = {
    ASG_NAME : "mycodeserver-asg",
    MIN_IDLE : 2,
    MAX_IDLE : 5,
    MAX_TOTAL_INSTANCES : 10,
    IDLE_TIMEOUT_MINUTES : 10,
    SCALE_UP_LOCK_KEY : "lock:asg:scale-up",
    SCALE_UP_LOCK_TTL_MS : 15_000,
} as const;