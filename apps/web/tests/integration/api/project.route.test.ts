import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  makeCreateProjectBody,
  makeDBUser,
  makeProject,
  makeRuntimeAssignment,
} from "../../factories/project";

const mocks = vi.hoisted(() => {
  return {
    currentUser: vi.fn(),
    prisma: {
      user: {
        findUnique: vi.fn(),
      },
    },
    createOrResumeProject: vi.fn(),
    deleteOrResumeProject: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  };
});

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: mocks.currentUser,
}));

vi.mock("db/client", () => ({
  prisma: mocks.prisma,
}));

vi.mock("../../../services/projectControlPlane", () => ({
  createOrResumeProject: mocks.createOrResumeProject,
  deleteOrResumeProject: mocks.deleteOrResumeProject,
}));

vi.mock("../../../lib/observability/structuredLogger", () => ({
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
}));

import { DELETE, POST } from "../../../app/api/project/route";

const expectRouteResponse = (
  response: NextResponse | undefined,
): NextResponse => {
  if (!response) {
    throw new Error("Expected route handler to return a response");
  }

  return response;
};

describe("app/api/project/route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.currentUser.mockResolvedValue({
      id: "clerk_123",
    });

    mocks.prisma.user.findUnique.mockResolvedValue(
      makeDBUser({
        id: "user_123",
        clerkId: "clerk_123",
      }),
    );
  });

  it("handles create project happy path", async () => {
    const project = makeProject({
      id: "project_123",
      ownerId: "user_123",
      status: "READY",
    });

    const runtime = makeRuntimeAssignment({
      projectId: project.id,
      userId: "user_123",
    });

    mocks.createOrResumeProject.mockResolvedValue({
      httpStatus: 201,
      message: "Project created and runtime ready",
      project,
      runtime,
      inProgress: false,
    });

    const request = new NextRequest("http://localhost:3000/api/project", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(makeCreateProjectBody()),
    });

    const response = expectRouteResponse(await POST(request));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.createOrResumeProject).toHaveBeenCalledWith({
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS",
    });
    expect(json.project.id).toBe("project_123");
  });

  it("handles delete project happy path", async () => {
    const project = makeProject({
      id: "project_123",
      ownerId: "user_123",
      status: "DELETED",
    });

    mocks.deleteOrResumeProject.mockResolvedValue({
      httpStatus: 200,
      message: "Project project_123 deleted successfully",
      project,
      runtime: null,
      inProgress: false,
    });

    const request = new NextRequest(
      "http://localhost:3000/api/project?id=project_123",
      {
        method: "DELETE",
      },
    );

    const response = expectRouteResponse(await DELETE(request));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.deleteOrResumeProject).toHaveBeenCalledWith({
      projectId: "project_123",
      ownerId: "user_123",
    });
    expect(json.project.id).toBe("project_123");
  });

  it("returns 401 for unauthorized access", async () => {
    mocks.currentUser.mockResolvedValue(null);

    const request = new NextRequest("http://localhost:3000/api/project", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(makeCreateProjectBody()),
    });

    const response = expectRouteResponse(await POST(request));
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorised");
  });

  it("blocks cross-user delete access", async () => {
    mocks.deleteOrResumeProject.mockResolvedValue({
      httpStatus: 403,
      message: "You do not have access to this project",
      project: null,
      runtime: null,
      inProgress: false,
    });

    const request = new NextRequest(
      "http://localhost:3000/api/project?id=project_other_user",
      {
        method: "DELETE",
      },
    );

    const response = expectRouteResponse(await DELETE(request));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.message).toContain("do not have access");
  });
});