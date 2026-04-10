import "dotenv/config";
import { runControlPlaneTick } from "../services/controlPlaneReconciler";
import { CONTROL_PLANE_INTERVAL_MS } from "../lib/control-plane/config";

const sleep = (ms : number) => new Promise((resolve) => setTimeout(resolve,ms));

async function main(){
    console.log("[control-plane-worker] starting");

    while(true){
        const startedAt = Date.now();

        try{
            const result = await runControlPlaneTick();
            console.log("[control-plane-worker] tick result:", JSON.stringify(result));
        } catch(err){
            console.error(
                "[control-plane-worker] tick failed:",
                err instanceof Error ? err.message : err,
            );
        }

        const elapsed = Date.now() - startedAt;
        const delay = Math.max(0, CONTROL_PLANE_INTERVAL_MS - elapsed);

        return sleep(delay);
    }
}

main().catch((err) => {
  console.error(
    "[control-plane-worker] fatal error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});