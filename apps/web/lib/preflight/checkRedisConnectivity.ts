import { assertEnvPresent } from "../config/env";
import { redis, withDistributedLock } from "../../services/redisManager";
import type { PreflightCheckResult } from "./types";

export const checkRedisConnectivity = async (): Promise<PreflightCheckResult> => {
  const probeKey = `preflight:redis:probe:${Date.now()}`;
  const lockKey = `preflight:redis:lock:${Date.now()}`;

  try {
    assertEnvPresent(["REDIS_URL"]);

    const pingResult = await redis.ping();

    await redis.set(probeKey, "ok", "PX", 10_000);
    const stored = await redis.get(probeKey);

    const lockResult = await withDistributedLock(lockKey, 5_000, async () => {
      return "LOCK_OK";
    });

    await redis.del(probeKey, lockKey);

    if (stored !== "ok") {
      return {
        name: "redis-connectivity",
        status: "FAIL",
        summary: "Redis responded, but set/get probe returned unexpected data",
        fatal: true,
        details: {
          pingResult,
          stored,
        },
      };
    }

    if (lockResult !== "LOCK_OK") {
      return {
        name: "redis-connectivity",
        status: "FAIL",
        summary: "Redis lock round-trip failed",
        fatal: true,
        details: {
          pingResult,
          lockResult,
        },
      };
    }

    return {
      name: "redis-connectivity",
      status: "PASS",
      summary: "Redis ping, key probe, and lock round-trip succeeded",
      fatal: true,
      details: {
        pingResult,
      },
    };
  } catch (err) {
    return {
      name: "redis-connectivity",
      status: "FAIL",
      summary: "Redis preflight failed",
      fatal: true,
      details: {
        error: err instanceof Error ? err.message : "Unknown Redis preflight error",
      },
    };
  }
};