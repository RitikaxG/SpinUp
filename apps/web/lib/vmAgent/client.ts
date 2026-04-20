import axios from "axios";
import { ENV } from "../config/env";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const buildVmAgentBaseUrl = (publicIP: string) =>
  `http://${publicIP}:${ENV.VM_AGENT_PORT}`;

export const buildWorkspaceBaseUrl = (publicIP: string) =>
  `http://${publicIP}:${ENV.WORKSPACE_PORT}`;

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
  isRunning?: boolean;
  exists?: boolean;
  status?: string;
  state?: string;
  containerStatus?: string;
  containerName?: string;
};

const normalizeStatus = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const isContainerRunning = (result: ContainerStatusResponse) => {
  if (result.running === true || result.isRunning === true) {
    return true;
  }

  const candidates = [
    normalizeStatus(result.status),
    normalizeStatus(result.state),
    normalizeStatus(result.containerStatus),
  ];

  return candidates.some(
    (value) => value === "running" || value.startsWith("up"),
  );
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
  timeoutMs = ENV.VM_CONTAINER_RUNNING_TIMEOUT_MS,
}: {
  publicIP: string;
  containerName: string;
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: ContainerStatusResponse | null = null;

  while (Date.now() < deadline) {
    const result = await getVmContainerStatus({ publicIP, containerName });
    lastStatus = result;

    if (isContainerRunning(result)) {
      return result;
    }

    await sleep(2_000);
  }

  throw new Error(
    `Container ${containerName} was not reported as running within ${timeoutMs}ms. Last status: ${JSON.stringify(lastStatus)}`,
  );
};

export const probeWorkspaceReady = async (publicIP: string): Promise<boolean> => {
  try {
    const response = await axios.get(buildWorkspaceBaseUrl(publicIP), {
      timeout: 5_000,
      validateStatus: () => true,
      maxRedirects: 0,
    });

    return (
      (response.status >= 200 && response.status < 400) ||
      response.status === 401
    );
  } catch {
    return false;
  }
};

export const waitForWorkspaceReady = async (publicIP: string): Promise<void> => {
  const deadline = Date.now() + ENV.WORKSPACE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const ready = await probeWorkspaceReady(publicIP);
    if (ready) {
      return;
    }

    await sleep(ENV.WORKSPACE_READY_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Workspace on ${publicIP}:${ENV.WORKSPACE_PORT} did not become ready within ${ENV.WORKSPACE_READY_TIMEOUT_MS}ms`,
  );
};

export const waitForRuntimeReady = async ({
  publicIP,
  containerName,
}: {
  publicIP: string;
  containerName: string;
}) => {
  const deadline = Date.now() + ENV.WORKSPACE_READY_TIMEOUT_MS;
  let lastContainerStatus: ContainerStatusResponse | null = null;

  while (Date.now() < deadline) {
    const [containerResult, workspaceReady] = await Promise.allSettled([
      getVmContainerStatus({ publicIP, containerName }),
      probeWorkspaceReady(publicIP),
    ]);

    if (
      containerResult.status === "fulfilled" &&
      isContainerRunning(containerResult.value)
    ) {
      return {
        source: "container_status" as const,
        lastContainerStatus: containerResult.value,
      };
    }

    if (
      workspaceReady.status === "fulfilled" &&
      workspaceReady.value === true
    ) {
      return {
        source: "workspace_http" as const,
        lastContainerStatus:
          containerResult.status === "fulfilled"
            ? containerResult.value
            : null,
      };
    }

    if (containerResult.status === "fulfilled") {
      lastContainerStatus = containerResult.value;
    }

    await sleep(ENV.WORKSPACE_READY_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Runtime did not become ready on ${publicIP}. Last container status: ${JSON.stringify(lastContainerStatus)}`,
  );
};