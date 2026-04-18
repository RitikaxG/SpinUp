import axios from "axios";
import { ENV } from "../config/env";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const buildVmAgentBaseUrl = (publicIP: string) =>
  `http://${publicIP}:${ENV.VM_AGENT_PORT}`;

export const probeVmAgentHealth = async (publicIP: string): Promise<boolean> => {
  try {
    const response = await axios.get(`${buildVmAgentBaseUrl(publicIP)}/health`, {
      timeout: Math.min(ENV.VM_AGENT_REQUEST_TIMEOUT_MS, 3_000),
      validateStatus: () => true,
    });

    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
};

export const waitForVmAgentHealthy = async (publicIP: string): Promise<void> => {
  const deadline = Date.now() + ENV.VM_AGENT_HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const healthy = await probeVmAgentHealth(publicIP);
    if (healthy) {
      return;
    }

    await sleep(ENV.VM_AGENT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `VM agent did not become healthy on ${publicIP}:${ENV.VM_AGENT_PORT}`,
  );
};

type StartVmContainerParams = {
  publicIP: string;
  projectId: string;
  projectName: string;
  projectType: "NEXTJS" | "REACT" | "REACT_NATIVE";
  containerName: string;
};

export const startVmContainer = async ({
  publicIP,
  projectId,
  projectName,
  projectType,
  containerName,
}: StartVmContainerParams): Promise<{ containerName?: string }> => {
  const response = await axios.post(
    `${buildVmAgentBaseUrl(publicIP)}/start`,
    {
      projectId,
      projectName,
      projectType,
      containerName,
    },
    {
      timeout: ENV.VM_AGENT_REQUEST_TIMEOUT_MS,
    },
  );

  return response.data as { containerName?: string };
};

type ContainerStatusResponse = {
  running?: boolean;
  status?: string;
  containerName?: string;
};

export const getVmContainerStatus = async ({
  publicIP,
  containerName,
}: {
  publicIP: string;
  containerName: string;
}): Promise<ContainerStatusResponse> => {
  const response = await axios.post(
    `${buildVmAgentBaseUrl(publicIP)}/containerStatus`,
    { containerName },
    {
      timeout: ENV.VM_AGENT_REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );

  if (response.status >= 400) {
    throw new Error(
      `containerStatus failed for ${containerName} with status ${response.status}`,
    );
  }

  return response.data as ContainerStatusResponse;
};

export const waitForVmContainerRunning = async ({
  publicIP,
  containerName,
  timeoutMs = 20_000,
}: {
  publicIP: string;
  containerName: string;
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await getVmContainerStatus({ publicIP, containerName });

    if (result.running === true || result.status === "running") {
      return;
    }

    await sleep(2_000);
  }

  throw new Error(`Container ${containerName} did not stay running on ${publicIP}`);
};