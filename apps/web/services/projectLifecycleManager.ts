import { prisma, ProjectLifecycleStatus } from "db/client";

// Project Lifecycle Writer

type LifecyclePatch = {
    statusReason? : string | null;
    assignedInstanceId? : string | null;
    containerName? : string | null;
    publicIp? : string | null;
    bootStartedAt? : Date | null;
    bootCompletedAt? : Date | null;
    lastHeartbeatAt? : Date | null;
    cleanupStartedAt? : Date | null;
    cleanupCompletedAt? : Date | null;
    deletedAt? : Date | null;
}

const ALLOWED_TRANSITIONS : Record<ProjectLifecycleStatus, ProjectLifecycleStatus[]> = {
    CREATED: ["ALLOCATING_VM","FAILED","DELETING"],
    ALLOCATING_VM:["BOOTING_CONTAINER","READY","FAILED","DELETING"],
    BOOTING_CONTAINER:["READY","FAILED","DELETING"],
    READY:["FAILED","DELETING"],
    FAILED: ["ALLOCATING_VM","DELETING"],
    DELETING: ["DELETED","FAILED"],
    DELETED:[],
}

const transitionProject = async (
    projectId : string,
    nextStatus: ProjectLifecycleStatus,
    patch: LifecyclePatch = {},
) => {
    const current = await prisma.project.findUnique({
        where:{id: projectId},
        select:{id: true, status: true}
    })

    if(!current){
        throw new Error("Project not found");
    }

    if(current.status === nextStatus){
        await prisma.project.update({
            where: { id: projectId },
            data: {
                ...patch
            }
        })
    }

    const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
    if(!allowed.includes(nextStatus)){
        throw new Error(`Invalid lifecycle transition for project ${projectId} from ${current.status} to ${nextStatus}`);
    }

    return prisma.project.update({
        where: { id: projectId },
        data: {
            status: nextStatus,
            ...patch,
        }
    })
}

export const markProjectCreated = async ( projectId: string) => {
    return transitionProject(projectId,"CREATED")
}

export const markProjectAllocating = async(projectId: string) => {
    return transitionProject(projectId,"ALLOCATING_VM",{
        statusReason: null,
    })
}

export const markProjectBooting = async (
    projectId : string,
    {
       instanceId,
       publicIp,
       bootStartedAt
    }:{
       instanceId : string,
       publicIp: string,
       bootStartedAt: Date
    }) => {
        return transitionProject(projectId,"BOOTING_CONTAINER",{
            assignedInstanceId: instanceId,
            publicIp,
            bootStartedAt,
            statusReason: null
        })
    }

export const markProjectReady = async (
    projectId : string,
    {
        instanceId,
        publicIp,
        containerName,
        bootCompletedAt
    }:{
        instanceId : string,
        publicIp : string,
        containerName: string,
        bootCompletedAt : Date
    }
) => {
    return transitionProject(projectId,"READY",{
        assignedInstanceId: instanceId,
        publicIp,
        containerName,
        bootCompletedAt,
        lastHeartbeatAt: bootCompletedAt,
        statusReason: null
    })
}

export const markProjectFailed = async(
    projectId : string,
    reason: string,
    patch: LifecyclePatch = {}
) => {
    await prisma.project.update({
        where: { id: projectId },
        data: {
            status: "FAILED",
            statusReason: reason,
            ...patch
        }
    })
}

export const markProjectDeleting = async ( projectId : string ) => {
    return transitionProject(projectId,"DELETING",{
        cleanupStartedAt: new Date(),
        statusReason: null
    })
}

export const markProjectDeleted = async (
    projectId : string, {
        cleanupCompletedAt,
    }: {
        cleanupCompletedAt : Date
    }
) => {
    return transitionProject(projectId,"DELETED",{
        cleanupCompletedAt,
        deletedAt: cleanupCompletedAt,
        lastHeartbeatAt: null,
        assignedInstanceId: null,
        containerName: null,
        publicIp: null,
        statusReason: null
    })
}

export const touchProjectHeartbeat = async (projectId : string) => {
    await prisma.project.update({
        where: { id : projectId },
        data : {
            lastHeartbeatAt: new Date()
        }
    })
}