import { Project, ProjectType } from "db/client";
import { ensureProjectRuntime, RuntimeAssignment } from "./ec2Manager";
import { prisma } from "db/client";
import { getInstanceIdForProject, getInstance, withDistributedLock, controlPlaneLockKeys, CONTROL_PLANE_LOCK_TTL_MS, cleanupProjectRuntimeAssignment, cleanupProjectArtifacts, finalizeProjectDeletion } from "./redisManager";
import { markProjectAllocating, markProjectDeletePendingReason, markProjectDeleting } from "./projectLifecycleManager";


const normalizeProjectName = (name : string) => name.trim().replace(/\s+/g, " ");

type ControlPlaneResponse = {
    httpStatus : number,
    message: string,
    project : Project | null,
    runtime : RuntimeAssignment | null,
    inProgress : boolean,
};

const getProjectSnapshot = async (
    projectId : string) : Promise< { project : Project | null; runtime : RuntimeAssignment | null}> => {

    const project = await prisma.project.findUnique({
        where : { id : projectId }
    });

    if(!project){
        return {
            project : null,
            runtime : null,
        }
    }

    const instanceId = await getInstanceIdForProject(projectId);
    const instance = instanceId ? await getInstance(instanceId) : null;

    if(instance &&
        instance.instanceId &&
        instance.publicIP &&
        instance.containerName &&
        instance.projectId === projectId
    ) {
        return {
            project,
            runtime : {
                userId : instance.userId,
                instanceId : instance.instanceId,
                publicIP : instance.publicIP,
                projectId : instance.projectId,
                projectName : instance.projectName,
                projectType : instance.projectType as ProjectType,
                containerName : instance.containerName,
            }
        }
    }

    return {
        project,
        runtime : null,
    }
};

export const createOrResumeProject = async ({
    ownerId,
    name,
    type,
}: {
    ownerId : string,
    name : string,
    type : ProjectType,
}) : Promise<ControlPlaneResponse> => {

    const normalizedName = normalizeProjectName(name);

    const lockedResult = await withDistributedLock<ControlPlaneResponse>(
        controlPlaneLockKeys.createProject(ownerId,normalizedName),
        CONTROL_PLANE_LOCK_TTL_MS,
        async () => {
            let createdByThisRequest = false;

            const project = await prisma.$transaction(async (tx) => {
                const existing = await tx.project.findFirst({
                    where : {
                        ownerId,
                        name : normalizedName,
                        deletedAt : null,
                    }
                });

                if(existing){
                    return existing;
                }

                createdByThisRequest = true;

                const created = await tx.project.create({
                    data : {
                        name : normalizedName,
                        type,
                        ownerId,
                        status : "CREATED"
                    }
                });

                await tx.projectRoom.create({
                    data : {
                        userId : ownerId,
                        projectId : created.id,
                    }
                });

                return created;
            });

            if(project.status === "DELETING"){
                const snapshot = await getProjectSnapshot(project.id);

                return {
                    httpStatus : 202,
                    message : "Project deletion is already in progress",
                    project : snapshot.project,
                    runtime : snapshot.runtime,
                    inProgress : true,
                }
            }

            if(project.status === "READY"){
                const snapshot = await getProjectSnapshot(project.id);

                return {
                    httpStatus : createdByThisRequest ? 201 : 200,
                    message : createdByThisRequest ? 
                    "Project created and runtime already available"
                    : "Project already exists and runtime is ready",
                    project : snapshot.project,
                    runtime : snapshot.runtime,
                    inProgress : false,
                }
            }

            if(project.status === "CREATED" || project.status === "FAILED"){
                await markProjectAllocating(project.id);
            }
            

            const runtime = await ensureProjectRuntime(
                project.id,
                project.name,
                project.type,
                ownerId,
            )

            const snapshot = await getProjectSnapshot(project.id);

            if(!runtime){
                return {
                    httpStatus : 500,
                    message : "Project exists but runtime provisioning failed",
                    project : snapshot.project,
                    runtime : snapshot.runtime,
                    inProgress : false,
                }
            }

            return {
                httpStatus : createdByThisRequest ? 201 : 200,
                message: createdByThisRequest
                ? "Project created and runtime ready"
                : "Project runtime reconciled successfully",
                project: snapshot.project,
                runtime,
                inProgress: false,
            }
        }
    );

    if(!lockedResult){
        return {
            httpStatus : 409,
            message: "Another create request for this project is already in progress",
            project : null,
            runtime : null,
            inProgress : true,
        }
    }

    return lockedResult;
}

export const deleteOrResumeProject = async({
    projectId,
    ownerId,
}: {
    projectId : string,
    ownerId : string
}) : Promise<ControlPlaneResponse> => {
    const lockedResult = await withDistributedLock<ControlPlaneResponse>(
        controlPlaneLockKeys.deleteProject(projectId),
        CONTROL_PLANE_LOCK_TTL_MS,
        async () => {
            const ownedProject = await prisma.project.findFirst({
                where : {
                    id : projectId,
                    ownerId,
                }
            });

            if(!ownedProject){
                return {
                    httpStatus : 403,
                    message : "You do not have access to this project",
                    project : null,
                    runtime : null,
                    inProgress : false,
                }
            }

            if(ownedProject.status === "DELETED"){
                return {
                    httpStatus: 200,
                    message: "Project already deleted",
                    project: ownedProject,
                    runtime: null,
                    inProgress: false,
                };
            }

            if(ownedProject.status === "DELETING"){
                await markProjectDeleting(projectId);
            }
            

            try{
                await cleanupProjectRuntimeAssignment(projectId, ownerId);

                await cleanupProjectArtifacts({
                    projectId,
                    projectName : ownedProject.name,
                    projectType : ownedProject.type,
                });

                const finalized = await finalizeProjectDeletion(projectId,ownerId);
                const snapshot = await getProjectSnapshot(projectId);

                if(!finalized){
                    return {
                        httpStatus : 202,
                        message : "Delete accepted but cleanup is still reconciling",
                        project : snapshot.project,
                        runtime : null,
                        inProgress : false,
                    }
                }

                return {
                    httpStatus : 200,
                    message : `Project ${projectId} deleted successfully`,
                    project : snapshot.project,
                    runtime : null,
                    inProgress : true,
                }
            } catch (err ){
                await markProjectDeletePendingReason(projectId, 
                    err instanceof Error ? err.message : "Unknown delete error",
                );

                const snapshot = await getProjectSnapshot(projectId);

                return {
                    httpStatus: 202,
                    message: "Delete accepted but cleanup is still reconciling",
                    project: snapshot.project,
                    runtime: snapshot.runtime,
                    inProgress: true,
                }
            }
        }
    )

    if(!lockedResult){
        const snapshot = await getProjectSnapshot(projectId);

        return {
            httpStatus: 202,
            message: "Delete request already in progress",
            project: snapshot.project,
            runtime: snapshot.runtime,
            inProgress: true,
        }
    }

    return lockedResult;
}