import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, makeRuntimeAssignment } from "../../factories/project";

const mocks = vi.hoisted(() => {
  const tx = {
    project: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    projectRoom: {
      create: vi.fn(),
    },
    projectEvent: {
      create: vi.fn(),
    },
  };

  return {
    tx,
    prisma: {
      $transaction: vi.fn(),
      project: {
        findFirst: vi.fn(),
      },
    },
    ensureProjectRuntime: vi.fn(),
    withDistributedLock: vi.fn(),
    markProjectAllocating: vi.fn(),
    markProjectDeleting: vi.fn(),
    markProjectDeletePendingReason: vi.fn(),
    cleanupProjectRuntimeAssignment: vi.fn(),
    cleanupProjectArtifacts: vi.fn(),
    finalizeProjectDeletion: vi.fn(),
    getProjectRuntimeSnapshot: vi.fn(),
    createScopedLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    logWarn: vi.fn(),
  };
});

vi.mock("db/client", () => ({
  prisma: mocks.prisma,
}));

vi.mock("../../../services/ec2Manager", () => ({
  ensureProjectRuntime: mocks.ensureProjectRuntime,
}));

vi.mock("../../../services/redisManager", () => ({
  withDistributedLock: mocks.withDistributedLock,
  controlPlaneLockKeys: {
    createProject: (ownerId: string, normalizedName: string) =>
      `lock:project:create:${ownerId}:${normalizedName.toLowerCase()}`,
    deleteProject: (projectId: string) => `lock:project:delete:${projectId}`,
    runtime: (projectId: string) => `lock:project:runtime:${projectId}`,
  },
  CONTROL_PLANE_LOCK_TTL_MS: 30_000,
  cleanupProjectRuntimeAssignment: mocks.cleanupProjectRuntimeAssignment,
  cleanupProjectArtifacts: mocks.cleanupProjectArtifacts,
  finalizeProjectDeletion: mocks.finalizeProjectDeletion,
}));

vi.mock("../../../services/projectLifecycleManager", () => ({
  markProjectAllocating: mocks.markProjectAllocating,
  markProjectDeleting: mocks.markProjectDeleting,
  markProjectDeletePendingReason: mocks.markProjectDeletePendingReason,
}));

vi.mock("../../../services/projectRuntimeTruthSource", () => ({
  getProjectRuntimeSnapshot: mocks.getProjectRuntimeSnapshot,
}));

vi.mock("../../../lib/observability/structuredLogger", () => ({
  createScopedLogger: mocks.createScopedLogger,
  logWarn: mocks.logWarn,
}));

import {
  createOrResumeProject,
  deleteOrResumeProject,
} from "../../../services/projectControlPlane";

describe("projectControlPlane", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.prisma.$transaction.mockImplementation(async (callback: any) => {
      return callback(mocks.tx);
    });

    mocks.withDistributedLock.mockImplementation(
      async (_key: string, _ttlMs: number, fn: () => Promise<unknown>) => {
        return fn();
      },
    );

    mocks.cleanupProjectArtifacts.mockResolvedValue("artifacts cleaned");
    mocks.cleanupProjectRuntimeAssignment.mockResolvedValue("runtime cleaned");
    mocks.finalizeProjectDeletion.mockResolvedValue({
      id: "project_123",
      status: "DELETED",
    });
  });

  it("creates a new project and reconciles runtime for valid parsed input", async () => {
    const createdProject = makeProject({
      id: "project_123",
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS",
      status: "CREATED",
    });

    const readySnapshot = makeProject({
      ...createdProject,
      status: "READY",
      assignedInstanceId: "i-123",
      publicIp: "1.2.3.4",
      containerName: "spinup-project_123",
    });

    const runtime = makeRuntimeAssignment({
      projectId: createdProject.id,
      projectName: createdProject.name,
      projectType: createdProject.type,
      userId: createdProject.ownerId,
    });

    mocks.tx.project.findFirst.mockResolvedValue(null);
    mocks.tx.project.create.mockResolvedValue(createdProject);
    mocks.tx.projectRoom.create.mockResolvedValue({});
    mocks.tx.projectEvent.create.mockResolvedValue({});
    mocks.markProjectAllocating.mockResolvedValue({});
    mocks.ensureProjectRuntime.mockResolvedValue(runtime);
    mocks.getProjectRuntimeSnapshot.mockResolvedValue({
      project: readySnapshot,
      runtime: null,
    });

    const result = await createOrResumeProject({
      ownerId: "user_123",
      name: "  SpinUp   Demo  ",
      type: "NEXTJS" as any,
    });

    expect(mocks.markProjectAllocating).toHaveBeenCalledWith(createdProject.id);
    expect(mocks.ensureProjectRuntime).toHaveBeenCalledWith(
      createdProject.id,
      createdProject.name,
      createdProject.type,
      createdProject.ownerId,
    );
    expect(result.httpStatus).toBe(201);
    expect(result.inProgress).toBe(false);
    expect(result.project?.id).toBe(createdProject.id);
    expect(result.runtime?.instanceId).toBe(runtime.instanceId);
  });

  it("reuses an existing project when normalized name and type match", async () => {
    const existingProject = makeProject({
      id: "project_existing",
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS",
      status: "STOPPED",
    });

    const readySnapshot = makeProject({
      ...existingProject,
      status: "READY",
      assignedInstanceId: "i-123",
      publicIp: "1.2.3.4",
      containerName: "spinup-project_existing",
    });

    const runtime = makeRuntimeAssignment({
      projectId: existingProject.id,
      projectName: existingProject.name,
      projectType: existingProject.type,
      userId: existingProject.ownerId,
      containerName: "spinup-project_existing",
    });

    mocks.tx.project.findFirst.mockResolvedValue(existingProject);
    mocks.markProjectAllocating.mockResolvedValue({});
    mocks.ensureProjectRuntime.mockResolvedValue(runtime);
    mocks.getProjectRuntimeSnapshot.mockResolvedValue({
      project: readySnapshot,
      runtime: null,
    });

    const result = await createOrResumeProject({
      ownerId: "user_123",
      name: "  SpinUp   Demo  ",
      type: "NEXTJS" as any,
    });

    expect(mocks.tx.project.create).not.toHaveBeenCalled();
    expect(mocks.markProjectAllocating).toHaveBeenCalledWith(existingProject.id);
    expect(mocks.ensureProjectRuntime).toHaveBeenCalledWith(
      existingProject.id,
      existingProject.name,
      existingProject.type,
      existingProject.ownerId,
    );
    expect(result.httpStatus).toBe(200);
    expect(result.inProgress).toBe(false);
  });

  it("returns 409 when the same normalized name exists under a different type", async () => {
    const conflictingProject = makeProject({
      id: "project_conflict",
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "REACT",
      status: "READY",
    });

    mocks.tx.project.findFirst.mockResolvedValue(conflictingProject);

    const result = await createOrResumeProject({
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS" as any,
    });

    expect(result.httpStatus).toBe(409);
    expect(result.inProgress).toBe(false);
    expect(result.message).toContain("already exists");
    expect(result.message).toContain("REACT");
    expect(mocks.markProjectAllocating).not.toHaveBeenCalled();
    expect(mocks.ensureProjectRuntime).not.toHaveBeenCalled();
    expect(mocks.tx.project.create).not.toHaveBeenCalled();
  });

  it("returns the existing runtime when the project is already READY", async () => {
    const readyProject = makeProject({
      id: "project_ready",
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS",
      status: "READY",
      assignedInstanceId: "i-ready",
      publicIp: "1.2.3.4",
      containerName: "spinup-project_ready",
    });

    mocks.tx.project.findFirst.mockResolvedValue(readyProject);
    mocks.getProjectRuntimeSnapshot.mockResolvedValue({
      project: readyProject,
      runtime: {
        userId: "user_123",
        instanceId: "i-ready",
        publicIp: "1.2.3.4",
        projectId: "project_ready",
        projectName: "SpinUp Demo",
        projectType: "NEXTJS",
        containerName: "spinup-project_ready",
      },
    });

    const result = await createOrResumeProject({
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS" as any,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.inProgress).toBe(false);
    expect(result.runtime?.instanceId).toBe("i-ready");
    expect(mocks.markProjectAllocating).not.toHaveBeenCalled();
    expect(mocks.ensureProjectRuntime).not.toHaveBeenCalled();
  });

  it("returns 202 when VM allocation is already in progress", async () => {
    const allocatingProject = makeProject({
      id: "project_allocating",
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS",
      status: "ALLOCATING_VM",
    });

    mocks.tx.project.findFirst.mockResolvedValue(allocatingProject);
    mocks.getProjectRuntimeSnapshot.mockResolvedValue({
      project: allocatingProject,
      runtime: null,
    });

    const result = await createOrResumeProject({
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS" as any,
    });

    expect(result.httpStatus).toBe(202);
    expect(result.inProgress).toBe(true);
    expect(result.message).toContain("already in progress");
    expect(mocks.ensureProjectRuntime).not.toHaveBeenCalled();
  });

  it("returns 202 when container boot is already in progress", async () => {
    const bootingProject = makeProject({
      id: "project_booting",
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS",
      status: "BOOTING_CONTAINER",
      assignedInstanceId: "i-123",
      publicIp: "1.2.3.4",
    });

    mocks.tx.project.findFirst.mockResolvedValue(bootingProject);
    mocks.getProjectRuntimeSnapshot.mockResolvedValue({
      project: bootingProject,
      runtime: null,
    });

    const result = await createOrResumeProject({
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS" as any,
    });

    expect(result.httpStatus).toBe(202);
    expect(result.inProgress).toBe(true);
    expect(result.message).toContain("already in progress");
    expect(mocks.ensureProjectRuntime).not.toHaveBeenCalled();
  });

  it("returns 403 when delete is requested by a non-owner", async () => {
    mocks.prisma.project.findFirst.mockResolvedValue(null);

    const result = await deleteOrResumeProject({
      projectId: "project_123",
      ownerId: "user_999",
    });

    expect(result.httpStatus).toBe(403);
    expect(result.message).toContain("do not have access");
    expect(result.project).toBeNull();
  });

  it("returns in-progress response when create lock is already held", async () => {
    mocks.withDistributedLock.mockResolvedValueOnce(null);

    const result = await createOrResumeProject({
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS" as any,
    });

    expect(result.httpStatus).toBe(409);
    expect(result.inProgress).toBe(true);
    expect(result.message).toContain("already in progress");
  });
});