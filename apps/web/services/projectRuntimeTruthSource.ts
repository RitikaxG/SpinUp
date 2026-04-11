// DB-First Reader Layer

import { Prisma, Project, ProjectEvent, ProjectEventType,prisma, ProjectLifecycleStatus } from "db/client"
import { ProjectTypeValue } from "./redisManager";

export type ActiveAssignmentSnapshot = {
    projectId : string,
    ownerId : string,
    projectName : string,
    projectType : "NEXTJS" | "REACT" | "REACT_NATIVE",
    status : ProjectLifecycleStatus,
    assignedInstanceId : string,
    publicIp : string | null,
    containerName : string | null,
    lastHeartbeatAt : Date | null,
};

export type ProjectRuntimeAssignmentSnapshot = {
    userId : string,
    instanceId : string,
    publicIp : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue,
    containerName : string | null,
};

export type ProjectRuntimeSnapshot = {
    project: Project | null;
    runtime : ProjectRuntimeAssignmentSnapshot | null;
}

export const ACTIVE_RUNTIME_STATUSES : ProjectLifecycleStatus[] = [
    "ALLOCATING_VM",
    "BOOTING_CONTAINER",
    "READY"
];

type AppendProjectEventInput = {
    projectId : string;
    ownerId : string;
    eventType : ProjectEventType;
    message? : string | null;
    fromStatus? : ProjectLifecycleStatus | null;
    toStatus? : ProjectLifecycleStatus | null;
    instanceId? : string | null;
    publicIp? : string | null;
    containerName? : string | null;
    metadata? : Prisma.InputJsonValue;
};

export const appendProjectEvent = async({
    projectId,
    ownerId,
    eventType,
    message = null,
    fromStatus,
    toStatus,
    instanceId = null,
    publicIp = null,
    containerName = null,
    metadata,
}: AppendProjectEventInput) : Promise<{ project : Project, event : ProjectEvent}> => {
    return prisma.$transaction(async (tx) => {
        const project = await tx.project.update({
            where : { id : projectId },
            data : {
                lastEventType : eventType,
                lastEventMessage : message,
                lastEventAt : new Date(),
            }
        });

        const event = await tx.projectEvent.create({
            data : {
                projectId,
                ownerId,
                eventType,
                fromStatus : fromStatus ?? project.status,
                toStatus : toStatus ?? project.status,
                message,
                instanceId : instanceId ?? project.assignedInstanceId ?? null,
                publicIp : publicIp ?? project.publicIp ?? null,
                containerName : containerName ?? project.containerName ?? null,
                metadata,
            }
        });

        return { project, event };
    })
};

export const getProjectRuntimeSnapshot = async(
    projectId : string,
) : Promise<ProjectRuntimeSnapshot> => {
    const project = await prisma.project.findUnique({
        where : { id : projectId }
    });

    if(!project){
        return {
            project : null,
            runtime : null,
        }
    }

    if(!project.assignedInstanceId || !project.publicIp){
        return {
            project,
            runtime : null,
        }
    }

    return {
        project,
        runtime : {
            userId : project.ownerId,
            instanceId : project.assignedInstanceId,
            publicIp : project.publicIp,
            projectId : project.id,
            projectName : project.name,
            projectType : project.type,
            containerName : project.containerName || null,
        }
    }
};

export const getAssignedProjectByInstanceId = async (instanceId : string) => {
    return prisma.project.findFirst({
        where : {
            assignedInstanceId : instanceId,
            deletedAt : null,
            status : {
                in : ACTIVE_RUNTIME_STATUSES
            }
        }
    });
};

export const listActiveProjectAssignments = async() : Promise<ActiveAssignmentSnapshot[]> => {
    const projects = await prisma.project.findMany({
        where : {
            deletedAt : null,
            assignedInstanceId : {
                not : null
            },
            status : {
                in : ACTIVE_RUNTIME_STATUSES,
            }
        },
        select : {
            id : true,
            ownerId : true,
            name : true,
            type : true,
            status : true,
            assignedInstanceId : true,
            publicIp : true,
            containerName : true,
            lastHeartbeatAt : true,
        },
        orderBy : {
            updatedAt : "asc"
        }
    });

    return projects.filter((project): project is typeof project & {
        assignedInstanceId : string;
        }=> Boolean(project.assignedInstanceId),
    ).map((project) => ({
        projectId : project.id,
        ownerId : project.ownerId,
        projectName : project.name,
        projectType : project.type,
        status : project.status,
        assignedInstanceId : project.assignedInstanceId,
        publicIp : project.publicIp,
        containerName : project.containerName,
        lastHeartbeatAt : project.lastHeartbeatAt,
    }));
};

export const listBusyInstanceIds = async(): Promise<Set<string>> => {
    const assignments = await listActiveProjectAssignments();

    return new Set(
        assignments.map((assignment) => assignment.assignedInstanceId)
        .filter((instanceId): instanceId is string => Boolean(instanceId)),
    );
};

export const clearProjectAssignmentSnapshot = async ( projectId : string ) => {
    return prisma.project.update({
        where : { id : projectId },
        data : {
            assignedInstanceId : null,
            publicIp : null,
            containerName : null,
            lastHeartbeatAt : null,
        }
    });
};


