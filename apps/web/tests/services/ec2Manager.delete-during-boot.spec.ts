import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = {
  project: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  projectRoom: {
    updateMany: vi.fn(),
  },
};

vi.mock("db/client", () => ({
  prisma: mockPrisma,
}));

const getProjectRuntimeSnapshotMock = vi.fn();
const cleanupProjectRuntimeAssignmentMock = vi.fn();
const deleteInstanceLifecycleMock = vi.fn();
const getIdleMachinesMock = vi.fn();
const ensureIdleCapacityForAllocationMock = vi.fn();
const waitForPublicIPMock = vi.fn();
const waitForVmAgentHealthyMock = vi.fn();
const startVmContainerMock = vi.fn();
const waitForRuntimeReadyMock = vi.fn();
const markProjectBootingMock = vi.fn();
const markProjectReadyMock = vi.fn();
const updateProjectRoomVmStateCalls: string[] = [];
const terminateAndScaleDownMock = vi.fn();

vi.mock("../../services/projectRuntimeTruthSource", () => ({
  getProjectRuntimeSnapshot: getProjectRuntimeSnapshotMock,
  ACTIVE_RUNTIME_STATUSES: ["ALLOCATING_VM", "BOOTING_CONTAINER", "READY"],
}));

vi.mock("../../services/redisManager", () => ({
  cleanupProjectRuntimeAssignment: cleanupProjectRuntimeAssignmentMock,
  deleteInstanceLifecycle: deleteInstanceLifecycleMock,
  mirrorProjectAssignmentToRedis: vi.fn(),
  rehydrateProjectRuntimeRedis: vi.fn(),
}));

vi.mock("../../services/asgManager", () => ({
  getIdleMachines: getIdleMachinesMock,
  ensureIdleCapacityForAllocation: ensureIdleCapacityForAllocationMock,
}));

vi.mock("../../lib/aws/ec2Commands", () => ({
  waitForPublicIP: waitForPublicIPMock,
}));

vi.mock("../../lib/vmAgent/client", () => ({
  waitForVmAgentHealthy: waitForVmAgentHealthyMock,
  startVmContainer: startVmContainerMock,
  waitForRuntimeReady: waitForRuntimeReadyMock,
  waitForVmContainerRunning: vi.fn(),
  waitForWorkspaceReady: vi.fn(),
}));

vi.mock("../../services/projectLifecycleManager", () => ({
  markProjectBooting: markProjectBootingMock,
  markProjectReady: markProjectReadyMock,
  markProjectFailed: vi.fn(),
}));

vi.mock("../../lib/aws/asgCommands", () => ({
  terminateAndReplace: vi.fn(),
  terminateAndScaleDown: terminateAndScaleDownMock,
}));

vi.mock("../../lib/observability/structuredLogger", () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

describe("ensureProjectRuntime - delete during boot", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getProjectRuntimeSnapshotMock.mockResolvedValue({
      project: {
        id: "project_123",
        ownerId: "user_123",
        name: "Delete During Boot",
        type: "NEXTJS",
        status: "ALLOCATING_VM",
        assignedInstanceId: null,
        publicIp: null,
        containerName: null,
      },
      runtime: null,
    });

    mockPrisma.project.findFirst.mockResolvedValue(null);

    getIdleMachinesMock.mockResolvedValue([{ InstanceId: "i-123" }]);
    waitForPublicIPMock.mockResolvedValue("1.2.3.4");
    waitForVmAgentHealthyMock.mockResolvedValue(undefined);

    // first lifecycle re-check sees DELETING
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project_123",
      ownerId: "user_123",
      name: "Delete During Boot",
      type: "NEXTJS",
      status: "DELETING",
      assignedInstanceId: null,
      publicIp: null,
      containerName: null,
    });
  });

  it("cancels provisioning when project becomes DELETING before boot transition", async () => {
    const { ensureProjectRuntime } = await import("../../services/ec2Manager");

    const result = await ensureProjectRuntime(
      "project_123",
      "Delete During Boot",
      "NEXTJS",
      "user_123",
    );

    expect(result).toBeNull();
    expect(markProjectBootingMock).not.toHaveBeenCalled();
    expect(startVmContainerMock).not.toHaveBeenCalled();
    expect(markProjectReadyMock).not.toHaveBeenCalled();

    expect(terminateAndScaleDownMock).toHaveBeenCalledWith("i-123", false);
    expect(deleteInstanceLifecycleMock).toHaveBeenCalledWith("i-123");
  });
});