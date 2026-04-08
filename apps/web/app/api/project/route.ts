import { NextResponse, NextRequest } from "next/server";
import { prisma } from "db/client";
import { currentUser } from "@clerk/nextjs/server";
import { ProjectSchema } from "../../../lib/validators/project";
import { createOrResumeProject, deleteOrResumeProject } from "../../../services/projectControlPlane";

async function requireDBUser(){
    const clerk = await currentUser();

    if(!clerk){
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
        return{
            error: NextResponse.json({
                error : "User not found"
            },{
                status: 404
            })
        }
    }

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

    const body = await req.json();
    const parsed = ProjectSchema.safeParse(body);

    if(!parsed.success){
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
    })

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

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("id");

    console.log(projectId);

    if(!projectId){
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