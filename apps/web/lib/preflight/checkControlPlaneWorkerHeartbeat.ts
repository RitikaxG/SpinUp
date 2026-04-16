import { CONTROL_PLANE_INTERVAL_MS } from "../control-plane/config";
import { readControlPlaneWorkerHeartbeat } from "../../services/redisManager";
import type { PreflightCheckResult } from "./types";

export const checkControlPlaneWorkerHeartbeat =
  async (): Promise<PreflightCheckResult> => {
    try {
      const heartbeat = await readControlPlaneWorkerHeartbeat();

      if (!heartbeat) {
        return {
          name: "control-plane-worker-heartbeat",
          status: "FAIL",
          summary: "No control-plane worker heartbeat found in Redis",
          fatal: true,
          details: {},
        };
      }

      const lastSeenAtMs = Date.parse(heartbeat.lastSeenAt);

      if (Number.isNaN(lastSeenAtMs)) {
        return {
          name: "control-plane-worker-heartbeat",
          status: "FAIL",
          summary: "Control-plane worker heartbeat exists but timestamp is invalid",
          fatal: true,
          details: {
            heartbeat,
          },
        };
      }

      const ageMs = Date.now() - lastSeenAtMs;
      const freshnessBudgetMs = CONTROL_PLANE_INTERVAL_MS * 2 + 5_000;

      if (ageMs > freshnessBudgetMs) {
        return {
          name: "control-plane-worker-heartbeat",
          status: "FAIL",
          summary: "Control-plane worker heartbeat is stale",
          fatal: true,
          details: {
            ageMs,
            freshnessBudgetMs,
            heartbeat,
          },
        };
      }

      return {
        name: "control-plane-worker-heartbeat",
        status: "PASS",
        summary: "Control-plane worker heartbeat exists and is fresh",
        fatal: true,
        details: {
          ageMs,
          freshnessBudgetMs,
          heartbeat,
        },
      };
    } catch (err) {
      return {
        name: "control-plane-worker-heartbeat",
        status: "FAIL",
        summary: "Control-plane worker heartbeat preflight failed",
        fatal: true,
        details: {
          error:
            err instanceof Error
              ? err.message
              : "Unknown control-plane heartbeat preflight error",
        },
      };
    }
  };