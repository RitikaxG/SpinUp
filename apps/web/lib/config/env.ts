const getOptionalEnv = (name: string, fallback = "") => {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return fallback;
  }

  return value;
};

const getOptionalNumberEnv = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const ENV = {
  REDIS_URL: getOptionalEnv("REDIS_URL"),
  AWS_REGION: getOptionalEnv("AWS_REGION", "ap-south-1"),
  EC2_LAUNCHER_ACCESS_KEY: getOptionalEnv("EC2_LAUNCHER_ACCESS_KEY"),
  EC2_LAUNCHER_ACCESS_SECRET: getOptionalEnv("EC2_LAUNCHER_ACCESS_SECRET"),
  ASG_NAME: getOptionalEnv("ASG_NAME", "codeserver-autoscaling-group"),
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
} as const;

export const assertEnvPresent = (names: Array<keyof typeof ENV>) => {
  const missing = names.filter((name) => {
    const value = ENV[name];
    return value === "" || value === undefined || value === null;
  });

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
};