export type PreflightCheckStatus = "PASS" | "FAIL";

export type PreflightCheckResult = {
  name: string;
  status: PreflightCheckStatus;
  summary: string;
  details: Record<string, unknown>;
  fatal: boolean;
};

export type E2EPreflightReport = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  results: PreflightCheckResult[];
};