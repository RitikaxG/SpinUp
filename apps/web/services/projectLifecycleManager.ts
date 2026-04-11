import { Prisma, prisma, ProjectEventType, ProjectLifecycleStatus } from "db/client";

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

type LifecycleEventInput = {
    eventType: ProjectEventType;
    message?: string | null;
    instanceId?: string | null;
    publicIp?: string | null;
    containerName?: string | null;
    metadata?: Prisma.InputJsonValue;
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

const getProjectStatus = async ( projectId : string ) => {
    const current = await prisma.project.findUnique({
        where: {
            id : projectId
        },
        select : {
            id: true,
            ownerId: true,
            status: true,
            cleanupStartedAt: true,
            cleanupCompletedAt: true,
            deletedAt: true,
            assignedInstanceId: true,
            publicIp: true,
            containerName: true,
        }
    })

    if(!current){
        throw new Error(`Project not found`);
    }
    return current;
};

const patchProjectWithEvent = async (
    projectId : string,
    patch : LifecyclePatch,
    event : LifecycleEventInput,
) => {
    return prisma.$transaction(async (tx) => {
        const current = await tx.project.findUnique({
            where : {id : projectId },
            select : {
                id : true,
                ownerId : true,
                status : true,
                assignedInstanceId : true,
                publicIp : true,
                containerName : true,
            }
        });

        if(!current){
            throw new Error(`Project not found`);
        }

        const now = new Date();

        const updated = await tx.project.update({
            where : { id : projectId },
            data : {
                ...patch,
                lastEventType : event.eventType,
                lastEventMessage : event.message ?? null,
                lastEventAt : now,
            }
        });

        await tx.projectEvent.create({
            data : {
                projectId,
                ownerId : current.ownerId,
                eventType : event.eventType,
                fromStatus : current.status,
                toStatus : updated.status,
                message : event.message ?? null,
                instanceId : event.instanceId ?? updated.assignedInstanceId ?? null,
                publicIp : event.publicIp ?? updated.publicIp ?? null,
                containerName : event.containerName ?? updated.containerName ?? null,
                metadata : event.metadata,
            }
        });

        return updated;
    });
};

const transitionProject = async (
    projectId : string,
    nextStatus: ProjectLifecycleStatus,
    patch: LifecyclePatch = {},
    event : LifecycleEventInput,
) => {

    return prisma.$transaction(async (tx) => {
        const current = await tx.project.findUnique({
            where : { id : projectId },
            select : {
                id: true,
                ownerId: true,
                status: true,
                cleanupStartedAt: true,
                cleanupCompletedAt: true,
                deletedAt: true,
                assignedInstanceId: true,
                publicIp: true,
                containerName: true,
            }
        });

        if (!current) {
            throw new Error("Project not found");
        }

        if (current.status !== nextStatus) {
            const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
            if (!allowed.includes(nextStatus)) {
                throw new Error(
                    `Invalid lifecycle transition for project ${projectId} from ${current.status} to ${nextStatus}`,
                );
            }
        };

        const now = new Date();
        const updated = await tx.project.update({
            where: { id: projectId },
            data: {
                status: nextStatus,
                ...patch,
                lastEventType: event.eventType,
                lastEventMessage: event.message ?? null,
                lastEventAt: now,
            },
        });

        await tx.projectEvent.create({
            data: {
                projectId,
                ownerId: current.ownerId,
                eventType: event.eventType,
                fromStatus: current.status,
                toStatus: nextStatus,
                message: event.message ?? null,
                instanceId: event.instanceId ?? updated.assignedInstanceId ?? null,
                publicIp: event.publicIp ?? updated.publicIp ?? null,
                containerName: event.containerName ?? updated.containerName ?? null,
                metadata: event.metadata,
            },
        });

        return updated;
    });
}

export const patchProjectLifecycle = async (
    projectId : string,
    patch : LifecyclePatch,
) => {
    await getProjectStatus(projectId);

    return prisma.project.update({
        where : { id: projectId },
        data : {
            ...patch,
        }
    })
}

export const markProjectCreated = async ( projectId: string) => {
    return transitionProject(projectId,"CREATED",{},{
        eventType : "PROJECT_CREATED",
        message : "Project created."
    })
}

export const markProjectAllocating = async(projectId: string) => {
    return transitionProject(projectId,"ALLOCATING_VM",{
        statusReason: null,
    },{
        eventType : "ALLOCATION_STARTED",
        message: "Project runtime allocation started",
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
        },{
            eventType : "CONTAINER_BOOT_STARTED",
            message: `Container boot started on instance ${instanceId}`,
            instanceId,
            publicIp,
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
    },{
        eventType : "CONTAINER_BOOT_SUCCEEDED",
        message: `Container became ready on instance ${instanceId}`,
        instanceId,
        publicIp,
        containerName,
    })
}

export const markProjectFailed = async(
    projectId : string,
    reason: string,
    patch: LifecyclePatch = {},
    eventType : ProjectEventType = "CONTAINER_BOOT_FAILED",
) => {

    return prisma.$transaction(async (tx) => {
        const current = await tx.project.findUnique({
            where: { id: projectId },
            select: {
                id: true,
                ownerId: true,
                status: true,
                assignedInstanceId: true,
                publicIp: true,
                containerName: true,
            },
        });

        if (!current) {
            throw new Error("Project not found");
        }

        const updated = await tx.project.update({
            where: { id: projectId },
            data: {
                status: "FAILED",
                statusReason: reason,
                ...patch,
                lastEventType: eventType,
                lastEventMessage: reason,
                lastEventAt: new Date(),
            },
        });

        await tx.projectEvent.create({
        data: {
            projectId,
            ownerId: current.ownerId,
            eventType,
            fromStatus: current.status,
            toStatus: "FAILED",
            message: reason,
            instanceId: updated.assignedInstanceId ?? current.assignedInstanceId,
            publicIp: updated.publicIp ?? current.publicIp,
            containerName: updated.containerName ?? current.containerName,
        },

        });
        return updated;
    });
}

export const markProjectDeleting = async ( projectId : string ) => {
    const current = await getProjectStatus(projectId);

    const cleanupStartedAt = current.cleanupStartedAt ?? new Date();

    return transitionProject(projectId,"DELETING",{
        cleanupStartedAt,
        statusReason: null
    },{
        eventType: "DELETE_STARTED",
        message: "Project deletion started",
        instanceId: current.assignedInstanceId,
        publicIp: current.publicIp,
        containerName: current.containerName,
    })
}

export const markProjectDeletePendingReason = async ( 
    projectId : string,
    reason : string,
    patch : LifecyclePatch = {},
) => {

    const current = await getProjectStatus(projectId);
    
    if(current.status === "DELETED"){
        return prisma.project.findUnique({
            where : { id : projectId }
        })
    }

    if(current.status !== "DELETING"){
        await markProjectDeleting(projectId);
    }

    return patchProjectWithEvent(
        projectId,
        {
            statusReason: reason,
            ...patch,
        },
        {
            eventType: "RUNTIME_CLEANUP_STARTED",
            message: reason,
            instanceId: current.assignedInstanceId,
            publicIp: current.publicIp,
            containerName: current.containerName,
        },
  );
}

export const markProjectDeleted = async (
    projectId : string, {
        cleanupCompletedAt,
    }: {
        cleanupCompletedAt : Date
    }
) => {
    const current = await getProjectStatus(projectId);

    const completedAt = current.cleanupCompletedAt ?? cleanupCompletedAt;
    const deletedAt = current.deletedAt ?? cleanupCompletedAt;

    return transitionProject(projectId,"DELETED",{
        cleanupCompletedAt : completedAt,
        deletedAt,
        lastHeartbeatAt: null,
        assignedInstanceId: null,
        containerName: null,
        publicIp: null,
        statusReason: null
    },{
        eventType: "DELETE_COMPLETED",
        message: "Project deletion completed",
        instanceId: current.assignedInstanceId,
        publicIp: current.publicIp,
        containerName: current.containerName,
    })
}

export const touchProjectHeartbeat = async (projectId : string) => {
    await prisma.project.update({
        where: { id : projectId },
        data : {
            lastHeartbeatAt: new Date(),
            lastEventType: "HEARTBEAT_OK",
            lastEventAt: new Date(),
        }
    })
}