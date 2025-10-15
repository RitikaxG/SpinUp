import { NextResponse, NextRequest } from "next/server";
import { prisma } from "db/client";
import { currentUser } from "@clerk/nextjs/server";
import { vmBootingSetup } from "../../../services/ec2Manager";
import { cleanUpInstanceInRedis } from "../../../services/redisManager";

export async function POST(req : NextRequest){
    const data = await req.json();
    const user = await currentUser();

    if (!user) {
        return new Response("Unauthorized", { status: 401 });
    }

  const currentClerkEmail = user.emailAddresses[0]?.emailAddress;
  console.log(currentClerkEmail);

  let existingUser = await prisma.user.findFirst({
    where : {
        email : currentClerkEmail
    }
  })

  const email = user.emailAddresses[0]?.emailAddress || "";
  const name = `${user.firstName || ' '} ${user.lastName || ' '}`.trim();
  const provider = user.externalAccounts?.[0]?.provider || null;

  
  if(!existingUser){
    existingUser = await prisma.user.create({
        data : {
            clerkId : user.id,
            email,
            name,
            profileImageUrl : user.imageUrl,
            provider,
        }
    })
  }

    try{
         const newProject = await prisma.project.create({
            data : {
                name : data.name,
                type : data.type
            }
        })

        console.log(newProject);

        // Associate User-Project {userId, projectId}
        await prisma.projectRoom.create({
            data : {
                userId : existingUser!.id,
                projectId : newProject.id
                }
            })
        
        const userId = existingUser.id;
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
        // const user = await currentUser();
        // if(!user){
        //     return NextResponse.json({
        //         message : `Unauthorized`
        //     },{
        //         status : 401
        //     })
        // }
    
        // const dbUser = await prisma.user.findFirst({
        //     where : {
        //         email : user?.emailAddresses[0]?.emailAddress
        //     }
        // })

        // if(!dbUser){
        //     return NextResponse.json({
        //         message : "User not found in database"
        //     },{
        //         status : 400
        //     })
        // }
        // console.log(dbUser.id);
    
        // // Check if project belongs to dbUser
        // const projectRoom = await prisma.projectRoom.findFirst({
        //     where : {
        //         userId : dbUser.id,
        //         projectId
        //     }
        // })

        // if(!projectRoom){
        //     return NextResponse.json({
        //         message : "You do not have access to this project"
        //     },{
        //         status : 403
        //     })
        // }

        // Delete all Project-User which was associated with `projectId
        // await prisma.projectRoom.deleteMany({
        //     where : {
        //         projectId
        //     }
        // })

        await prisma.project.delete({
            where : { id : projectId }
        })

        
        await cleanUpInstanceInRedis(projectId);

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
    const user = await currentUser();
    if(!user){
        return NextResponse.json({
            message : "Unauthorized"
        },{
            status : 401
        })
    }

    const dbUser = await prisma.user.findFirst({
        where : {
            email : user.emailAddresses[0]?.emailAddress
        }
    })

    if(!dbUser){
        return NextResponse.json({
            message : `User not found in DB`
        },{
            status : 403
        })
    }

    try{
        const userProjects = await prisma.projectRoom.findMany({
            where : {
                userId : dbUser.id
            },
            select : {
                projectId : true
            }
        })

        const projectIds = userProjects.map((link) => link.projectId);

        if(projectIds.length === 0){
            return NextResponse.json({
                message : `You have no associated projects`
            },{
                status : 400
            })
        }

        const projects = await prisma.project.findMany({
            where : {
                id : { in : projectIds }
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