import "dotenv/config";
import { runControlPlaneTick } from "../services/controlPlaneReconciler";
import { CONTROL_PLANE_INTERVAL_MS } from "../lib/control-plane/config";
import { logError, logInfo } from "../lib/observability/structuredLogger";

const sleep = (ms : number) => new Promise((resolve) => setTimeout(resolve,ms));

async function main(){
    logInfo({
        operation: "control_plane.worker.started",
        status: "STARTED",
        reason: null,
        meta: {},
    });

    while(true){
        const startedAt = Date.now();

        try{
            const result = await runControlPlaneTick();
            logInfo({
                operation: "control_plane.worker.tick_completed",
                status: "SUCCESS",
                reason: null,
                meta: {
                    result,
                },
            });
        } catch(err){
            logError({
                operation: "control_plane.worker.tick_failed",
                status: "FAILED",
                reason: err instanceof Error ? err.message : "Unknown control-plane tick error",
                meta: {},
            });
        }

        const elapsed = Date.now() - startedAt;
        const delay = Math.max(0, CONTROL_PLANE_INTERVAL_MS - elapsed);

        await sleep(delay);
    }
}

main().catch((err) => {
  logError({
        operation: "control_plane.worker.fatal",
        status: "FAILED",
        reason: err instanceof Error ? err.message : "Unknown fatal worker error",
        meta: {},
    });
  process.exit(1);
});