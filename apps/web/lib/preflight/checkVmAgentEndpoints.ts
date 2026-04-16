import axios from "axios";
import { getAutoScalingGroupState } from "../aws/asgCommands";
import { getPublicIP } from "../aws/ec2Commands";
import { ENV, assertEnvPresent } from "../config/env";
import type { PreflightCheckResult } from "./types";

type EndpointProbeResult = {
  route: string;
  method: string;
  status: number;
  ok: boolean;
  note: string;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const resolveVmAgentBaseUrl = async () => {
  if (ENV.PREFLIGHT_VM_AGENT_BASE_URL) {
    return {
      baseUrl: trimTrailingSlash(ENV.PREFLIGHT_VM_AGENT_BASE_URL),
      source: "PREFLIGHT_VM_AGENT_BASE_URL",
    };
  }

  assertEnvPresent([
    "EC2_LAUNCHER_ACCESS_KEY",
    "EC2_LAUNCHER_ACCESS_SECRET",
    "ASG_NAME",
  ]);

  const state = await getAutoScalingGroupState();

  const candidate = state.instances.find((instance) => {
    return (
      Boolean(instance.InstanceId) &&
      instance.HealthStatus === "Healthy" &&
      instance.LifecycleState === "InService"
    );
  });

  if (!candidate?.InstanceId) {
    throw new Error(
      "No healthy InService ASG instance available to probe VM agent endpoints",
    );
  }

  const publicIP = await getPublicIP(candidate.InstanceId);

  if (!publicIP) {
    throw new Error(`Unable to resolve public IP for instance ${candidate.InstanceId}`);
  }

  return {
    baseUrl: `http://${publicIP}:3000`,
    source: `ASG instance ${candidate.InstanceId}`,
  };
};

const probeEndpoint = async ({
  baseUrl,
  route,
  method,
  body,
  validator,
  note,
}: {
  baseUrl: string;
  route: string;
  method: "GET" | "POST";
  body?: unknown;
  validator: (status: number) => boolean;
  note: string;
}): Promise<EndpointProbeResult> => {
  const response = await axios.request({
    url: `${baseUrl}${route}`,
    method,
    data: body,
    timeout: 5_000,
    validateStatus: () => true,
  });

  return {
    route,
    method,
    status: response.status,
    ok: validator(response.status),
    note,
  };
};

export const checkVmAgentEndpoints = async (): Promise<PreflightCheckResult> => {
  try {
    const target = await resolveVmAgentBaseUrl();

    const probes = await Promise.all([
      probeEndpoint({
        baseUrl: target.baseUrl,
        route: "/health",
        method: "GET",
        validator: (status) => status >= 200 && status < 300,
        note: "Health endpoint should return 2xx",
      }),
      probeEndpoint({
        baseUrl: target.baseUrl,
        route: "/containerStatus",
        method: "POST",
        body: {
          containerName: "__spinup_preflight_probe__",
        },
        validator: (status) => status !== 404 && status !== 405,
        note: "Contract probe only; non-404/non-405 counts as route present",
      }),
      probeEndpoint({
        baseUrl: target.baseUrl,
        route: "/stop",
        method: "POST",
        body: {
          containerName: "__spinup_preflight_probe__",
        },
        validator: (status) => status !== 404 && status !== 405,
        note: "Contract probe only; non-404/non-405 counts as route present",
      }),
      probeEndpoint({
        baseUrl: target.baseUrl,
        route: "/start",
        method: "POST",
        body: {
          projectId: "__preflight_invalid_project__",
          projectName: "",
          projectType: "INVALID",
          containerName: "__spinup_preflight_probe__",
          dryRun: true,
        },
        validator: (status) => status !== 404 && status !== 405,
        note: "Invalid payload on purpose; route presence matters more than success",
      }),
    ]);

    const failures = probes.filter((probe) => !probe.ok);

    if (failures.length > 0) {
      return {
        name: "vm-agent-endpoints",
        status: "FAIL",
        summary: "One or more VM agent endpoints are missing or responding on the wrong contract",
        fatal: true,
        details: {
          target,
          probes,
        },
      };
    }

    return {
      name: "vm-agent-endpoints",
      status: "PASS",
      summary: "VM agent endpoints responded on expected port/routes",
      fatal: true,
      details: {
        target,
        probes,
      },
    };
  } catch (err) {
    return {
      name: "vm-agent-endpoints",
      status: "FAIL",
      summary: "VM agent endpoint preflight failed",
      fatal: true,
      details: {
        error:
          err instanceof Error
            ? err.message
            : "Unknown VM agent preflight error",
      },
    };
  }
};