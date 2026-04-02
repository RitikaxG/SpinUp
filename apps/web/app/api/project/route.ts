import { NextResponse, NextRequest } from "next/server";
import { prisma } from "db/client";
import { currentUser } from "@clerk/nextjs/server";
import { vmBootingSetup } from "../../../services/ec2Manager";
import { cleanUpOwnedProjectInstance } from "../../../services/redisManager";
import { ProjectSchema } from "../../../lib/validators/project";

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

    const existingProject = await prisma.project.findFirst({
        where : {
            ownerId : auth.dbUser.id,
            name: parsed.data.name
        }
    })

    if(existingProject){
        return NextResponse.json({
            error : "You already have a project with this name",
        },{
            status : 409
        })
    }

    try{
         const newProject = await prisma.project.create({
            data : {
                name : parsed.data.name,
                type : parsed.data.type,
                ownerId: auth.dbUser.id,
            }
        })

        console.log(newProject);

        // Associate User-Project {userId, projectId}
        await prisma.projectRoom.create({
            data : {
                userId : auth.dbUser.id,
                projectId : newProject.id
                }
            })
        
        const userId = auth.dbUser.id;
        const bootingEvents = await vmBootingSetup(newProject.id,newProject.name, newProject.type, userId);
       

        return NextResponse.json(
            { message: "Project Created Successfully and linked to ProjectRoom", projectDetails : { projectId : newProject.id, projectName : newProject.name, projectType : newProject.type }, bootingEventsLog : bootingEvents } ,
            { status :  200 },

        )
    }
    catch(err : unknown){
        if(err instanceof Error){
            return NextResponse.json({
                message : `Error creating new project ${err.message}`
            },{
            status : 500
            })
        }
    }
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
            status : 404
        })
    }

    try{
        // Check if project belongs to dbUser
        const ownedProject = await prisma.project.findFirst({
            where : {
                ownerId : auth.dbUser.id,
                id : projectId
            }
        })

        if(!ownedProject){
            return NextResponse.json({
                message : "You do not have access to this project"
            },{
                status : 403
            })
        }

        // Clean up any instance in redis associated with the projectId
        await cleanUpOwnedProjectInstance(projectId, auth.dbUser.id);

        // Delete all Project-User which was associated with `projectId`
        await prisma.projectRoom.deleteMany({
            where : {
                projectId
            }
        })

        // Delete the project
        await prisma.project.delete({
            where : { id : projectId }
        })

        return NextResponse.json({
            message : `Successfully deleted project with id ${projectId}`
        },{
            status : 200
        })

    }
    catch(err : unknown){
        if(err instanceof Error){
            return NextResponse.json({
                message : `Failed to delete project with id ${projectId} error : ${err.message}`
            })
        }
    }
}

export async function GET(){
    const auth = await requireDBUser();
    if ("error" in auth) {
        return auth.error;
    }

    try{

        const projects = await prisma.project.findMany({
            where : {
                ownerId: auth.dbUser.id
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