import { checkAutoscalingEnvironment } from "./checkAutoscalingEnvironment";
import { checkControlPlaneWorkerHeartbeat } from "./checkControlPlaneWorkerHeartbeat";
import { checkRedisConnectivity } from "./checkRedisConnectivity";
import { checkVmAgentEndpoints } from "./checkVmAgentEndpoints";
import type { E2EPreflightReport, PreflightCheckResult } from "./types";

const CHECKS: Array<() => Promise<PreflightCheckResult>> = [
  checkRedisConnectivity,
  checkAutoscalingEnvironment,
  checkControlPlaneWorkerHeartbeat,
  checkVmAgentEndpoints,
];

export const runE2EPreflight = async (): Promise<E2EPreflightReport> => {
  const startedAt = new Date().toISOString();
  const results: PreflightCheckResult[] = [];

  for (const runCheck of CHECKS) {
    const result = await runCheck();
    results.push(result);

    if (result.status === "FAIL" && result.fatal) {
      break;
    }
  }

  return {
    ok: results.every((result) => result.status === "PASS"),
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
};