import Redis from "ioredis";
import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import axios from "axios";
import { deleteS3Object } from "../lib/aws/s3Commands";
const REDIS_URL = process.env.REDIS_URL as string;
import { prisma } from "db/client";

if(!REDIS_URL){
    console.error("REDIS_URL required");
}

export const redis = new Redis(REDIS_URL);

export const markInstanceInUse = async (userId : string, instanceId : string, projectId : string, projectName : string, projectType : string, publicIP : string, containerName : string) => {
    // Metadata lookup
    await redis.hset(`instance:${instanceId}`,{
        userId,
        inUse : "true", // Redis stores strings
        publicIP,
        instanceId,
        projectId,
        projectName,
        projectType,
        containerName,
        allocatedAt : Date.now().toString()
    })

    // Reverse lookups
    await redis.set(`user:${userId}:instance`,instanceId);
    await redis.set(`project:${projectId}:instance`,instanceId);

    return instanceId;
}

export const markInstanceIdle = async (instanceId : string) => {
    await redis.hset(`instance:${instanceId}`,{
        inUse : "false",
        freedAt : Date.now().toString()
    })
}

export const cleanUpOwnedProjectInstance = async (projectId : string, ownerId : string) => {
    try{
        // 1. Ownership Verification
        const ownedProject = await prisma.project.findFirst({
            where : {
                id : projectId,
                ownerId,
            },
            select: {
                id : true,
                name : true,
                type : true,
            }
        })

        if(!ownedProject){
            throw new Error("Forbidden cleanup attempt : User does not own the project");
        }

        // Update vmState to TERMINATING for the user in that projectRoom
        await prisma.projectRoom.updateMany({
            where: {
                projectId,
                userId: ownerId
            },
            data: {
                vmState: "TERMINATING"
            }
        })

        // Get instanceId associated with that project
       const instanceId = await redis.get(`project${projectId}:instance`);

       if(!instanceId){

        await prisma.projectRoom.updateMany({
            where: {
                projectId,
                userId: ownerId
            },
            data:{
                vmState: "STOPPED"
            }
        })

        return `No active instance for project ${projectId}`;
       }

       const instanceMetaData = await redis.hgetall(`instance:${instanceId}`);
       if(!instanceMetaData || Object.keys(instanceMetaData).length === 0){

        // clean broken reverse mappings
        await redis.multi()
            .del(`user:${ownerId}:instance`)
            .del(`project:${projectId}:instance`)
            .exec()

        await prisma.projectRoom.updateMany({
            where: {
                projectId,
                userId: ownerId
            },
            data: {
                vmState: "STOPPED"
            }
        })

        return `No metadata found for instance ${instanceId}`;
       }

       // 3. Stop my-code-server container inside VM
       try{
            if(instanceMetaData.publicIP && instanceMetaData.containerName){
                await axios.post(`http://${instanceMetaData.publicIP}:3000/stop`,{
                containerName : instanceMetaData.containerName
                })
            }
        }
       catch(err : unknown){
           if(err instanceof Error){
               console.error(`Failed to stop container for instance ${instanceId} ${err.message}`);
           } 
       }
        
        // 4.1 Delete instance from ASG
        await terminateAndScaleDown(instanceId!,true);
        // 4.2 Delete that particular instance key from redis 
        // 4.3 Delete that particular user-instance mapping
        // 4.4 Delete that particular project-instance mapping

        await redis.multi()
            .del(`instance:${instanceId}`)
            .del(`user:${instanceMetaData.userId || ownerId}:instance`)
            .del(`project:${projectId}:instance`)
            .exec();


        // 5. Delete object from bucket
        const objectKey = `projects/${ownedProject.name}_${projectId}/code-${ownedProject.type}`;
        await deleteS3Object("bolt-app-v2",objectKey);

        // Mark STOPPED after cleanup
        await prisma.projectRoom.updateMany({
            where: {
                projectId,
                userId: ownerId
            },
            data: {
                vmState: "STOPPED"
            }
        })

        return `${instanceId} associated with ${projectId} successfully deleted`;
    }
   
    catch(err : unknown){
        await prisma.projectRoom.updateMany({
            where: {
                projectId,
                userId: ownerId
            },
            data: {
                vmState: "FAILED"
            }
        })
        if(err instanceof Error){
            console.error(`Error removing instance ${err.message}`);
        }

        throw new Error("Unknown cleanup error")
    }
}

