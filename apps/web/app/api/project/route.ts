import { NextResponse, NextRequest } from "next/server";
import { prisma } from "db/client";
import { currentUser } from "@clerk/nextjs/server";
import { ProjectSchema } from "../../../lib/validators/project";
import { createOrResumeProject, deleteOrResumeProject } from "../../../services/projectControlPlane";
import { logInfo, logWarn } from "../../../lib/observability/structuredLogger";

const getResponseLogStatus = (httpStatus: number, inProgress: boolean) => {
  if (httpStatus >= 500) return "FAILED";
  if (httpStatus >= 400) return "FAILED";
  if (inProgress) return "INFO";
  return "SUCCESS";
};

async function requireDBUser(){
    const clerk = await currentUser();

    if(!clerk){
        logWarn({
            operation: "project.auth.failed",
            status: "FAILED",
            reason: "No authenticated Clerk user found",
            meta: {},
        });

        return{
            error : NextResponse.json({
                error : "Unauthorised"
            },{
                status: 401
            })
        }
    }

    const dbUser = await prisma.user.findUnique({
        where: {
            clerkId: clerk.id
        }
    })

    if(!dbUser){
        logWarn({
            operation: "project.auth.failed",
            status: "FAILED",
            reason: "Authenticated Clerk user not found in DB",
            meta: {
            clerkId: clerk.id,
            },
        });

        return{
            error: NextResponse.json({
                error : "User not found"
            },{
                status: 404
            })
        }
    }

    logInfo({
        userId: dbUser.id,
        operation: "project.user.verified",
        status: "SUCCESS",
        reason: null,
        meta: {
            clerkId: clerk.id,
            email: dbUser.email,
        },
    });

    return {
        clerkUser : clerk,
        dbUser
    }
}

export async function POST(req : NextRequest){
    const auth = await requireDBUser();
    if("error" in auth){
        return auth.error;
    }

    logInfo({
        userId: auth.dbUser.id,
        operation: "project.create.requested",
        status: "STARTED",
        reason: null,
        meta: {
            route: "/api/project",
        },
    });

    const body = await req.json();
    const parsed = ProjectSchema.safeParse(body);

    if(!parsed.success){
        logWarn({
            userId: auth.dbUser.id,
            operation: "project.create.validation_failed",
            status: "FAILED",
            reason: "ProjectSchema validation failed",
            meta: {
                errors: parsed.error.flatten().fieldErrors,
            },
        });

        return NextResponse.json({
            message : "Invalid input",
            error : parsed.error.flatten().fieldErrors,
        },{
            status: 400
        })
    }

    const result = await createOrResumeProject({
        ownerId: auth.dbUser.id,
        name : parsed.data.name,
        type : parsed.data.type,
    });

    logInfo({
        projectId: result.project?.id ?? null,
        userId: auth.dbUser.id,
        instanceId: result.runtime?.instanceId ?? null,
        containerName: result.runtime?.containerName ?? null,
        operation: "project.create.response",
        status: getResponseLogStatus(result.httpStatus, result.inProgress),
        reason: result.message,
        meta: {
            httpStatus: result.httpStatus,
            inProgress: result.inProgress,
        },
    });

    return NextResponse.json({
        message : result.message,
        project : result.project,
        runtime : result.runtime,
        inProgress : result.inProgress,
    },{
        status : result.httpStatus,
    })
    
}

export async function DELETE(req : NextRequest){
    const auth = await requireDBUser();
    if("error" in auth){
        return auth.error;
    }

    logInfo({
        userId: auth.dbUser.id,
        operation: "project.delete.requested",
        status: "STARTED",
        reason: null,
        meta: {
            route: "/api/project",
        },
    });

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("id");


    if(!projectId){
        logWarn({
            userId: auth.dbUser.id,
            operation: "project.delete.validation_failed",
            status: "FAILED",
            reason: "Project id not provided",
            meta: {},
        });

        return NextResponse.json({
            message : `ProjectId not provided`
        },{
            status : 400
        })
    }

    const result = await deleteOrResumeProject({
        projectId,
        ownerId : auth.dbUser.id,
    });

    logInfo({
        projectId: result.project?.id ?? projectId,
        userId: auth.dbUser.id,
        instanceId: result.runtime?.instanceId ?? null,
        containerName: result.runtime?.containerName ?? null,
        operation: "project.delete.response",
        status: getResponseLogStatus(result.httpStatus, result.inProgress),
        reason: result.message,
        meta: {
            httpStatus: result.httpStatus,
            inProgress: result.inProgress,
        },
    });

    return NextResponse.json({
        message: result.message,
        project: result.project,
        runtime: result.runtime,
        inProgress: result.inProgress,
    },{
        status : result.httpStatus,
    })
}

export async function GET(){
    const auth = await requireDBUser();
    if ("error" in auth) {
        return auth.error;
    }

    try{
        const projects = await prisma.project.findMany({
            where : {
                ownerId: auth.dbUser.id,
                deletedAt: null
            },
            orderBy: {
                id: "desc"
            }
        });

        return NextResponse.json({
            message : `Fetched all projects successfully`,
            allProjects : projects
        },{
            status : 200
        })
    }

    catch(err : unknown){
        if(err instanceof Error){
            return NextResponse.json({
                message : `Error fetching projects error : ${err.message}`
            },{
                status : 500
            })
        }
        return NextResponse.json({ message: "Unknown server error" }, { status: 500 });
    }
    
}