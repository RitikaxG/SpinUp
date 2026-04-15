import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getIdleMachines: vi.fn(),
    ensureIdleCapacityForAllocation: vi.fn(),
    terminateAndScaleDown: vi.fn(),
    getPublicIP: vi.fn(),
    deleteInstanceLifecycle: vi.fn(),
    cleanupProjectRuntimeAssignment: vi.fn(),
    rehydrateProjectRuntimeRedis: vi.fn(),
    mirrorProjectAssignmentToRedis: vi.fn(),
    prisma: {
      project: {
        findFirst: vi.fn(),
      },
      projectRoom: {
        updateMany: vi.fn(),
      },
    },
    markProjectBooting: vi.fn(),
    markProjectFailed: vi.fn(),
    markProjectReady: vi.fn(),
    getProjectRuntimeSnapshot: vi.fn(),
    createScopedLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    logInfo: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("../../../lib/aws/asgCommands", () => ({
  terminateAndScaleDown: mocks.terminateAndScaleDown,
}));

vi.mock("../../../lib/aws/ec2Commands", () => ({
  getPublicIP: mocks.getPublicIP,
}));

vi.mock("../../../services/asgManager", () => ({
  getIdleMachines: mocks.getIdleMachines,
  ensureIdleCapacityForAllocation: mocks.ensureIdleCapacityForAllocation,
}));

vi.mock("../../../services/redisManager", () => ({
  deleteInstanceLifecycle: mocks.deleteInstanceLifecycle,
  cleanupProjectRuntimeAssignment: mocks.cleanupProjectRuntimeAssignment,
  rehydrateProjectRuntimeRedis: mocks.rehydrateProjectRuntimeRedis,
  mirrorProjectAssignmentToRedis: mocks.mirrorProjectAssignmentToRedis,
}));

vi.mock("db/client", () => ({
  prisma: mocks.prisma,
}));

vi.mock("../../../services/projectLifecycleManager", () => ({
  markProjectBooting: mocks.markProjectBooting,
  markProjectFailed: mocks.markProjectFailed,
  markProjectReady: mocks.markProjectReady,
}));

vi.mock("../../../services/projectRuntimeTruthSource", () => ({
  ACTIVE_RUNTIME_STATUSES: ["ALLOCATING_VM", "BOOTING_CONTAINER", "READY"],
  getProjectRuntimeSnapshot: mocks.getProjectRuntimeSnapshot,
}));

vi.mock("../../../lib/observability/structuredLogger", () => ({
  createScopedLogger: mocks.createScopedLogger,
  logInfo: mocks.logInfo,
  logError: mocks.logError,
}));

import { allocateVmAndScaleUp } from "../../../services/ec2Manager";

describe("ec2Manager.allocateVmAndScaleUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an idle machine immediately when one already exists", async () => {
    mocks.getIdleMachines.mockResolvedValue([
      {
        InstanceId: "i-idle-1",
      },
    ]);

    const result = await allocateVmAndScaleUp();

    expect(result).toEqual({ instanceId: "i-idle-1" });
    expect(mocks.ensureIdleCapacityForAllocation).not.toHaveBeenCalled();
  });

  it("waits for scale-up and returns an instance when idle capacity appears", async () => {
    vi.useFakeTimers();

    mocks.getIdleMachines
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          InstanceId: "i-idle-2",
        },
      ]);

    mocks.ensureIdleCapacityForAllocation.mockResolvedValue({
      action: "SCALE_UP",
      targetDesiredCapacity: 2,
      reason: "Idle count below minimum",
    });

    const promise = allocateVmAndScaleUp();

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await promise;

    expect(mocks.ensureIdleCapacityForAllocation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ instanceId: "i-idle-2" });
  });
});