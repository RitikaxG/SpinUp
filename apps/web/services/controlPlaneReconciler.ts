import { CONTROL_PLANE_TICK_LOCK_TTL_MS } from "../lib/control-plane/config"
import { reconcileWarmPool } from "./asgManager"
import { controlPlaneLockKeys, withDistributedLock } from "./redisManager"
import { runHeartbeatReconcile } from "./runtimeHeartbeatManager"

export const runControlPlaneTick = async () => {
    const locked = await withDistributedLock(
        controlPlaneLockKeys.tick(),
        CONTROL_PLANE_TICK_LOCK_TTL_MS,
        async () => {
            const heartbeat = await runHeartbeatReconcile();
            const warmpool = await reconcileWarmPool();

            return {
                ran : true,
                heartbeat,
                warmpool,
                timestamp : new Date().toISOString(),
            }
        }
    );

    if(!locked){
        return {
            ran : false,
            skipped : true,
            reason : "Another control-plane tick is already in progress",
            timestamp : new Date().toISOString(),
        }
    };

    return locked;
}