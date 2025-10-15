import Redis from "ioredis";
import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import axios from "axios";
import { deleteS3Object } from "../lib/aws/s3Commands";
const REDIS_URL = process.env.REDIS_URL as string;

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

export const cleanUpInstanceInRedis = async (projectId : string) => {
    try{
        // Get instanceId associated with that project
       const instanceId = await redis.get(`project${projectId}`);
       if(!instanceId){
        return `No active instance for project ${projectId}`;
       }

       const instanceMetaData = await redis.hgetall(`instance:${instanceId}`);
       if(!instanceMetaData){
        return `No meta data for instance ${instanceId}`;
       }

       // 3. Stop my-code-server container inside VM
       try{
          await axios.post(`http://${instanceMetaData.publicIP}:3000/stop`,{
               containerName : instanceMetaData.containerName
          })
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
            .del(`user:${instanceMetaData.userId}`)
            .del(`project:${projectId}`)
            .exec();


        // 5. Delete object from bucket
        const objectKey = `projects/${instanceMetaData.projectName}_${projectId}/code-${instanceMetaData.projectType}`;
        await deleteS3Object("bolt-app",objectKey);

        return `${instanceId} associated with ${projectId} successfully deleted`;
    }
   
    catch(err : unknown){
        if(err instanceof Error){
            console.error(`Error removing instance ${err.message}`);
        }
    }
}

