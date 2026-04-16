import "dotenv/config";
import { runControlPlaneTick } from "../services/controlPlaneReconciler";
import { CONTROL_PLANE_INTERVAL_MS } from "../lib/control-plane/config";
import { logError, logInfo } from "../lib/observability/structuredLogger";
import { writeControlPlaneWorkerHeartbeat } from "../services/redisManager";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await writeControlPlaneWorkerHeartbeat({
    status: "STARTED",
    lastResult: { phase: "boot" },
  });

  logInfo({
    operation: "control_plane.worker.started",
    status: "STARTED",
    reason: null,
    meta: {},
  });

  while (true) {
    const startedAt = Date.now();

    try {
      const result = await runControlPlaneTick();

      await writeControlPlaneWorkerHeartbeat({
        status: "SUCCESS",
        lastResult: result,
      });

      logInfo({
        operation: "control_plane.worker.tick_completed",
        status: "SUCCESS",
        reason: null,
        meta: {
          result,
        },
      });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : "Unknown control-plane tick error";

      await writeControlPlaneWorkerHeartbeat({
        status: "FAILED",
        lastError: reason,
      });

      logError({
        operation: "control_plane.worker.tick_failed",
        status: "FAILED",
        reason,
        meta: {},
      });
    }

    const elapsed = Date.now() - startedAt;
    const delay = Math.max(0, CONTROL_PLANE_INTERVAL_MS - elapsed);

    await sleep(delay);
  }
}

main().catch(async (err) => {
  const reason =
    err instanceof Error ? err.message : "Unknown fatal worker error";

  try {
    await writeControlPlaneWorkerHeartbeat({
      status: "FAILED",
      lastError: reason,
    });
  } catch {
    // best effort only
  }

  logError({
    operation: "control_plane.worker.fatal",
    status: "FAILED",
    reason,
    meta: {},
  });

  process.exit(1);
});