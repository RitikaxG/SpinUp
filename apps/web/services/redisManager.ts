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


// Defining types and Key builders
export type InstanceStatus = "BOOTING" | "RUNNING" | "FAILED" | "TERMINATING" | "STOPPED" | "IDLE"

export type ProjectTypeValue = "NEXTJS" | "REACT" | "REACT_NATIVE"

export type InstanceRecord = {
    instanceId : string,
    userId : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue | "",
    publicIP : string,
    containerName : string,
    inUse : "true" | "false",
    allocatedAt : string,
    lastHeartbeatAt : string,
    status : InstanceStatus
}

export const redisKeys = {
    instance : (instanceId : string) => `instance:${instanceId}`,
    userInstance: (userId : string) => `user:${userId}:instance`,
    projectInstance: (projectId : string) => `project:${projectId}:instance`
}

const toInstanceRecord = (data: Record<string,string>): InstanceRecord => {
    return {
        instanceId: data.instanceId ?? "",
        userId: data.userId ?? "",
        projectId : data.projectId ?? "",
        projectName : data.projectName ?? "",
        projectType: (data.projectType as ProjectTypeValue) ?? "",
        publicIP: data.publicIP ?? "",
        containerName: data.containerName ?? "",
        inUse: data.inUse === "true" ? "true" : "false",
        allocatedAt: data.allocatedAt ?? "",
        lastHeartbeatAt: data.lastHeartbeatAt ?? "",
        status : (data.status as InstanceStatus) ?? "FAILED"
    }
}

// Read helper functions
export const getInstance = async ( instanceId : string) : Promise<InstanceRecord | null> => {
    const data = await redis.hgetall(redisKeys.instance(instanceId));
    if(!data || Object.keys(data).length === 0){
        return null;
    }

    return toInstanceRecord(data);
}

export const getInstanceIdForUser = async (userId : string) : Promise<string | null> => {
    const instanceId = await redis.get(redisKeys.userInstance(userId));
    return instanceId || null;
}

export const getInstanceIdForProject = async (projectId : string) : Promise<string | null> => {
    const instanceId = await redis.get(redisKeys.projectInstance(projectId));
    return instanceId || null;
}

// an object is passed to this function as input, we destructure the object arguement
export const writeBootingInstance = async ({
    instanceId,
    userId,
    projectId,
    projectName,
    projectType,
    publicIP
}:{
    instanceId : string,
    userId : string,
    projectId : string,
    projectName : string,
    projectType: ProjectTypeValue,
    publicIP : string,
}) => {
    const now = Date.now().toString();

    // Build instance record
    const record : InstanceRecord = {
        instanceId,
        userId,
        projectId,
        projectName,
        projectType,
        publicIP,
        containerName: "",
        inUse: "true",
        allocatedAt: now,
        lastHeartbeatAt: now,
        status: "BOOTING"
    };

    await redis.multi()
        .hset(redisKeys.instance(instanceId),record) // full instance metadata
        .hset(redisKeys.userInstance(userId),instanceId) // user-instance mapping
        .hset(redisKeys.projectInstance(projectId),instanceId) // project-instance mapping
        .exec();

    return record;
}

export const writeRunningInstance = async({
    instanceId,
    userId,
    projectId,
    projectName,
    projectType,
    publicIP,
    containerName
}:{
    instanceId : string,
    userId : string,
    projectId : string,
    projectName: string,
    projectType : ProjectTypeValue,
    publicIP : string,
    containerName : string
})  => {
    const now = Date.now().toString();

    const record : InstanceRecord = {
        instanceId,
        userId,
        projectId,
        projectName,
        projectType,
        publicIP,
        containerName,
        inUse: "true",
        allocatedAt: now,
        lastHeartbeatAt: now,
        status: "RUNNING"
    };

    await redis.multi()
        .hset(redisKeys.instance(instanceId),record)
        .hset(redisKeys.userInstance(userId),instanceId)
        .hset(redisKeys.projectInstance(projectId),record)
        .exec()

    return record;
}

export const writeIdleInstance = async (instanceId : string) => {
    const existing = await getInstance(instanceId);
    if(!existing){
        throw new Error(`No instance metadata found for ${instanceId}`);
    }

    const now = Date.now().toString();
    const idleRecord : InstanceRecord = {
        instanceId,
        userId: "",
        projectId: "",
        projectName: "",
        projectType: "",
        publicIP: existing.publicIP,
        containerName: "",
        inUse: "false",
        allocatedAt: "",
        lastHeartbeatAt: now,
        status: "IDLE"
    }

    await redis.multi()
        .del(redisKeys.userInstance(existing.userId))
        .del(redisKeys.projectInstance(existing.projectId))
        .hset(redisKeys.instance(instanceId),idleRecord)
        .exec()

    return idleRecord;
}

export const markInstanceTerminating = async(instanceId : string) => {
    const existing = await getInstance(instanceId);
    if(!existing){
        return null;
    }

    const now = Date.now().toString();

    const terminatingRecord: InstanceRecord = {
        ...existing,
        lastHeartbeatAt: now,
        status : "TERMINATING"
    }

    await redis.hset(redisKeys.instance(instanceId),terminatingRecord);
    return terminatingRecord;
}

export const updateInstanceHeartbeat = async(instanceId : string) => {
    const existing = await getInstance(instanceId);
    if(!existing){
        return null;
    }

    const now = Date.now().toString();
    const updated : InstanceRecord = {
        ...existing,
        lastHeartbeatAt: now
    }

    await redis.hset(redisKeys.instance(instanceId),updated);
}

// Delete helper function
export const deleteInstanceMappings = async (record : {
    userId? : string,
    projectId? : string,
}) => {
    const multi = redis.multi();

    if(record.userId){
        multi.del(redisKeys.userInstance(record.userId));
    }

    if(record.projectId){
        multi.del(redisKeys.projectInstance(record.projectId));
    }

    await multi.exec();
}

export const deleteInstanceRecord = async (instanceId : string) => {
    await redis.del(redisKeys.instance(instanceId));
}

// Combined Cleanup
export const deleteInstanceLifecycle = async (instanceId : string) => {
    const existing = await getInstance(instanceId);

    if(!existing){
        await deleteInstanceRecord(instanceId);
        return;
    }

    await redis.multi()
        .del(redisKeys.instance(instanceId))
        .del(redisKeys.userInstance(existing.userId))
        .del(redisKeys.projectInstance(existing.projectId))
        .exec()
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
       const instanceId = await getInstanceIdForProject(projectId);

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

       const instanceMetaData = await getInstance(instanceId);
       if(!instanceMetaData){

        await deleteInstanceMappings({
            userId: ownerId,
            projectId,
        })

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

        await deleteInstanceLifecycle(instanceId);


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

