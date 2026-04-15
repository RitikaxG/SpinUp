import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeInstanceRecord } from "../../factories/project";

const mocks = vi.hoisted(() => {
  return {
    axiosPost: vi.fn(),
    axiosGet: vi.fn(),
    cleanupProjectRuntimeAssignment: vi.fn(),
    deleteInstanceLifecycle: vi.fn(),
    getInstance: vi.fn(),
    incrementHeartbeatFailure: vi.fn(),
    resetHeartbeatFailure: vi.fn(),
    updateInstanceHeartbeat: vi.fn(),
    withDistributedLock: vi.fn(),
    markProjectFailed: vi.fn(),
    touchProjectHeartbeat: vi.fn(),
    prisma: {
      project: {
        findUnique: vi.fn(),
      },
    },
    appendProjectEvent: vi.fn(),
    getAssignedProjectByInstanceId: vi.fn(),
    listActiveProjectAssignments: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  };
});

vi.mock("axios", () => ({
  default: {
    post: mocks.axiosPost,
    get: mocks.axiosGet,
  },
}));

vi.mock("db/client", () => ({
  prisma: mocks.prisma,
}));

vi.mock("../../../services/redisManager", () => ({
  cleanupProjectRuntimeAssignment: mocks.cleanupProjectRuntimeAssignment,
  controlPlaneLockKeys: {
    runtime: (projectId: string) => `lock:project:runtime:${projectId}`,
  },
  deleteInstanceLifecycle: mocks.deleteInstanceLifecycle,
  getInstance: mocks.getInstance,
  incrementHeartbeatFailure: mocks.incrementHeartbeatFailure,
  resetHeartbeatFailure: mocks.resetHeartbeatFailure,
  updateInstanceHeartbeat: mocks.updateInstanceHeartbeat,
  withDistributedLock: mocks.withDistributedLock,
}));

vi.mock("../../../services/projectLifecycleManager", () => ({
  markProjectFailed: mocks.markProjectFailed,
  touchProjectHeartbeat: mocks.touchProjectHeartbeat,
}));

vi.mock("../../../services/projectRuntimeTruthSource", () => ({
  appendProjectEvent: mocks.appendProjectEvent,
  getAssignedProjectByInstanceId: mocks.getAssignedProjectByInstanceId,
  listActiveProjectAssignments: mocks.listActiveProjectAssignments,
}));

vi.mock("../../../lib/observability/structuredLogger", () => ({
  logError: mocks.logError,
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
}));

import {
  checkRuntimeHealth,
  handleHeartbeatFailure,
} from "../../../services/runtimeHeartbeatManager";

describe("runtimeHeartbeatManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.withDistributedLock.mockImplementation(
      async (_key: string, _ttlMs: number, fn: () => Promise<unknown>) => {
        return fn();
      },
    );

    mocks.getAssignedProjectByInstanceId.mockResolvedValue({
      id: "project_123",
      ownerId: "user_123",
    });

    mocks.prisma.project.findUnique.mockResolvedValue({
      id: "project_123",
      ownerId: "user_123",
      status: "READY",
    });

    mocks.appendProjectEvent.mockResolvedValue({});
    mocks.cleanupProjectRuntimeAssignment.mockResolvedValue("runtime cleaned");
    mocks.markProjectFailed.mockResolvedValue({});
  });

  it("returns HARD failure when container status is stopped", async () => {
    const instance = makeInstanceRecord({
      instanceId: "i-123",
      projectId: "project_123",
      userId: "user_123",
      publicIP: "1.2.3.4",
      containerName: "spinup-project_123",
    });

    mocks.axiosPost.mockResolvedValue({
      data: {
        status: "stopped",
      },
    });

    const result = await checkRuntimeHealth(instance);

    expect(result).toEqual({
      healthy: false,
      severity: "HARD",
      reason: "Container is stopped",
    });
  });

  it("returns SOFT failure when health endpoint throws", async () => {
    const instance = makeInstanceRecord({
      publicIP: "1.2.3.4",
      containerName: "spinup-project_123",
    });

    mocks.axiosPost.mockResolvedValue({
      data: {
        status: "running",
      },
    });

    mocks.axiosGet.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await checkRuntimeHealth(instance);

    expect(result.healthy).toBe(false);

    if (result.healthy) {
      throw new Error("Expected unhealthy result");
    }

    expect(result.severity).toBe("SOFT");
    expect(result.reason).toContain("Health check failed");
  });

  it("recovers runtime immediately on hard heartbeat failure", async () => {
    const instance = makeInstanceRecord({
      instanceId: "i-123",
      projectId: "project_123",
      userId: "user_123",
      publicIP: "1.2.3.4",
      containerName: "spinup-project_123",
    });

    const outcome = await handleHeartbeatFailure(
      instance,
      "Container is stopped",
      "HARD",
    );

    expect(outcome).toBe("RECOVERED");
    expect(mocks.cleanupProjectRuntimeAssignment).toHaveBeenCalledWith(
      "project_123",
      "user_123",
    );
    expect(mocks.markProjectFailed).toHaveBeenCalled();
  });

  it("recovers runtime when soft failures reach threshold", async () => {
    const instance = makeInstanceRecord({
      instanceId: "i-123",
      projectId: "project_123",
      userId: "user_123",
      publicIP: "1.2.3.4",
      containerName: "spinup-project_123",
    });

    mocks.incrementHeartbeatFailure.mockResolvedValue(3);

    const outcome = await handleHeartbeatFailure(
      instance,
      "Health check failed: timeout",
      "SOFT",
    );

    expect(outcome).toBe("RECOVERED");
    expect(mocks.incrementHeartbeatFailure).toHaveBeenCalledWith(
      "i-123",
      "Health check failed: timeout",
    );
    expect(mocks.cleanupProjectRuntimeAssignment).toHaveBeenCalledWith(
      "project_123",
      "user_123",
    );
  });
});