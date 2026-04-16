const getOptionalEnv = (name: string, fallback = "") => {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return fallback;
  }

  return value;
};

export const ENV = {
  REDIS_URL: getOptionalEnv("REDIS_URL"),
  AWS_REGION: getOptionalEnv("AWS_REGION", "ap-south-1"),
  EC2_LAUNCHER_ACCESS_KEY: getOptionalEnv("EC2_LAUNCHER_ACCESS_KEY"),
  EC2_LAUNCHER_ACCESS_SECRET: getOptionalEnv("EC2_LAUNCHER_ACCESS_SECRET"),
  ASG_NAME: getOptionalEnv("ASG_NAME", "mycodeserver-asg"),
  PREFLIGHT_VM_AGENT_BASE_URL: getOptionalEnv("PREFLIGHT_VM_AGENT_BASE_URL"),
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