import { NextResponse, NextRequest } from "next/server";
import { prisma } from "db/client";
import { currentUser } from "@clerk/nextjs/server";
import { logWarn } from "../../../../lib/observability/structuredLogger";

async function requireDBUser() {
  const clerk = await currentUser();

  if (!clerk) {
    logWarn({
      operation: "project.auth.failed",
      status: "FAILED",
      reason: "No authenticated Clerk user found",
      meta: {},
    });

    return {
      error: NextResponse.json(
        {
          message: "Unauthorised",
        },
        {
          status: 401,
        },
      ),
    };
  }

  const dbUser = await prisma.user.findUnique({
    where: {
      clerkId: clerk.id,
    },
  });

  if (!dbUser) {
    logWarn({
      operation: "project.auth.failed",
      status: "FAILED",
      reason: "Authenticated Clerk user not found in DB",
      meta: {
        clerkId: clerk.id,
      },
    });

    return {
      error: NextResponse.json(
        {
          message: "User not found",
        },
        {
          status: 404,
        },
      ),
    };
  }

  return {
    clerkUser: clerk,
    dbUser,
  };
}

type RouteContext = {
  params: Promise<{
    projectId: string;
  }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireDBUser();

  if ("error" in auth) {
    return auth.error;
  }

  const { projectId } = await context.params;

  if (!projectId) {
    return NextResponse.json(
      {
        message: "Project id not provided",
      },
      {
        status: 400,
      },
    );
  }

  try {
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        ownerId: auth.dbUser.id,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        type: true,

        status: true,
        statusReason: true,

        assignedInstanceId: true,
        publicIp: true,
        containerName: true,

        bootStartedAt: true,
        bootCompletedAt: true,
        lastHeartbeatAt: true,

        lastEventType: true,
        lastEventMessage: true,
        lastEventAt: true,

        createdAt: true,
        updatedAt: true,
      },
    });

    if (!project) {
      return NextResponse.json(
        {
          message: "Project not found",
          project: null,
        },
        {
          status: 404,
        },
      );
    }

    return NextResponse.json(
      {
        message: "Fetched project successfully",
        project,
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        message:
          err instanceof Error
            ? `Error fetching project: ${err.message}`
            : "Unknown server error",
      },
      {
        status: 500,
      },
    );
  }
}