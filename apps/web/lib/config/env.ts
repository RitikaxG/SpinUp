const getOptionalEnv = (name: string, fallback = "") => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
};

const getRequiredEnv = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const getOptionalNumberEnv = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid number`);
  }

  return parsed;
};

const getOptionalBooleanEnv = (name: string, fallback = false) => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "true";
};

const getOptionalEnumEnv = <T extends readonly string[]>(
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  if (!allowed.includes(value as T[number])) {
    throw new Error(
      `Environment variable ${name} must be one of: ${allowed.join(", ")}`,
    );
  }

  return value as T[number];
};

export const ENV = {
  REDIS_URL: getRequiredEnv("REDIS_URL"),
  AWS_REGION: getOptionalEnv("AWS_REGION", "ap-south-1"),
  AWS_AUTH_MODE: getOptionalEnumEnv(
    "AWS_AUTH_MODE",
    ["auto", "explicit"] as const,
    "auto",
  ),
  EC2_LAUNCHER_ACCESS_KEY: getOptionalEnv("EC2_LAUNCHER_ACCESS_KEY"),
  EC2_LAUNCHER_ACCESS_SECRET: getOptionalEnv("EC2_LAUNCHER_ACCESS_SECRET"),
  ASG_NAME: getOptionalEnv("ASG_NAME", "codeserver-autoscaling-group"),
  PROJECT_ARTIFACT_BUCKET: getRequiredEnv("PROJECT_ARTIFACT_BUCKET"),
  PREFLIGHT_VM_AGENT_BASE_URL: getOptionalEnv("PREFLIGHT_VM_AGENT_BASE_URL"),
  VM_AGENT_PORT: getOptionalNumberEnv("VM_AGENT_PORT", 3000),
  VM_AGENT_HEALTH_TIMEOUT_MS: getOptionalNumberEnv(
    "VM_AGENT_HEALTH_TIMEOUT_MS",
    30_000,
  ),
  VM_AGENT_POLL_INTERVAL_MS: getOptionalNumberEnv(
    "VM_AGENT_POLL_INTERVAL_MS",
    2_000,
  ),
  VM_AGENT_REQUEST_TIMEOUT_MS: getOptionalNumberEnv(
    "VM_AGENT_REQUEST_TIMEOUT_MS",
    15_000,
  ),
  PRESERVE_FAILED_RUNTIME_FOR_DEBUG: getOptionalBooleanEnv(
    "PRESERVE_FAILED_RUNTIME_FOR_DEBUG",
    false,
  ),
  FAILED_RUNTIME_DEBUG_GRACE_MS: getOptionalNumberEnv(
    "FAILED_RUNTIME_DEBUG_GRACE_MS",
    0,
  ),
  VM_CONTAINER_RUNNING_TIMEOUT_MS: getOptionalNumberEnv(
    "VM_CONTAINER_RUNNING_TIMEOUT_MS",
    60_000,
  ),
  WORKSPACE_PORT: getOptionalNumberEnv("WORKSPACE_PORT", 8080),
  WORKSPACE_READY_TIMEOUT_MS: getOptionalNumberEnv(
    "WORKSPACE_READY_TIMEOUT_MS",
    300_000,
  ),
  WORKSPACE_READY_POLL_INTERVAL_MS: getOptionalNumberEnv(
    "WORKSPACE_READY_POLL_INTERVAL_MS",
    5_000,
  ),
} as const;

export const assertEnvPresent = (names: Array<keyof typeof ENV>) => {
  const missing = names.filter((name) => {
    const value = ENV[name];
    return value === "" || value === undefined || value === null;
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
};