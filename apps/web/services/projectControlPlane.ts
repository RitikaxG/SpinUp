import { Project, ProjectType } from "db/client";
import { ensureProjectRuntime, RuntimeAssignment } from "./ec2Manager";
import { prisma } from "db/client";
import { withDistributedLock, controlPlaneLockKeys, CONTROL_PLANE_LOCK_TTL_MS, cleanupProjectRuntimeAssignment, cleanupProjectArtifacts, finalizeProjectDeletion } from "./redisManager";
import { markProjectAllocating, markProjectDeletePendingReason, markProjectDeleting } from "./projectLifecycleManager";
import { PROJECT_RUNTIME_LOCK_TTL_MS } from "../lib/control-plane/config";
import { getProjectRuntimeSnapshot } from "./projectRuntimeTruthSource";
import { createScopedLogger, logWarn } from "../lib/observability/structuredLogger";

const withProjectRuntimeLock = async<T>(
    projectId : string,
    fn : () => Promise<T>,
) : Promise< {lockAcquired : true ; value : T } | {lockAcquired : false }> => {

    const result = await withDistributedLock(
        controlPlaneLockKeys.runtime(projectId),
        PROJECT_RUNTIME_LOCK_TTL_MS,
        async () => {
            const value = await fn();
            return { value }
        }
    );

    if(!result){
        return { lockAcquired : false };
    }

    return {
        lockAcquired : true,
        value : result.value,
    }
}

const normalizeProjectName = (name : string) => name.trim().replace(/\s+/g, " ");

type ControlPlaneResponse = {
    httpStatus : number,
    message: string,
    project : Project | null,
    runtime : RuntimeAssignment | null,
    inProgress : boolean,
};

const buildProjectSnapshot = async (
    projectId : string) : Promise< { project : Project | null; runtime : RuntimeAssignment | null}> => {

    const snapshot = await getProjectRuntimeSnapshot(projectId);
    if(!snapshot.project){
        return {
            project : null,
            runtime : null,
        }
    } 

    if(!snapshot.runtime){
        return {
            project : snapshot.project,
            runtime : null,
        }
    }

    return {
        project : snapshot.project,
        runtime : {
            userId : snapshot.runtime.userId,
            instanceId: snapshot.runtime.instanceId,
            publicIP: snapshot.runtime.publicIp,
            projectId: snapshot.runtime.projectId,
            projectName: snapshot.runtime.projectName,
            projectType: snapshot.runtime.projectType,
            containerName: snapshot.runtime.containerName ?? "",
        }
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

    const logger = createScopedLogger({
        userId: ownerId,
        meta: {
            projectName: normalizedName,
            projectType: type,
        },
    });

    logger.info({
    operation: "project.control_plane.create_or_resume",
    status: "STARTED",
    reason: null,
    });

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
                    logger.info({
                        projectId: existing.id,
                        operation: "project.existing.reused",
                        status: "INFO",
                        reason: "Existing non-deleted project found for owner and normalized name",
                        meta: {
                            currentStatus: existing.status,
                        },
                    });
                    return existing;
                }

                createdByThisRequest = true;
                const now = new Date();

                const created = await tx.project.create({
                    data : {
                        name : normalizedName,
                        type,
                        ownerId,
                        status : "CREATED",
                        lastEventType : "PROJECT_CREATED",
                        lastEventMessage : "Project created",
                        lastEventAt : now,
                    }
                });

                await tx.projectRoom.create({
                    data : {
                        userId : ownerId,
                        projectId : created.id,
                    }
                });

                await tx.projectEvent.create({
                    data : {
                        projectId : created.id,
                        ownerId,
                        eventType : "PROJECT_CREATED",
                        fromStatus : "CREATED",
                        toStatus : "CREATED",
                        message : "Project created",
                    }
                });

                logger.info({
                    projectId: created.id,
                    operation: "project.db.created",
                    status: "SUCCESS",
                    reason: "Project row and initial project event created",
                    meta: {
                        projectType: created.type,
                    },
                });

                return created;
            });

            if(project.status === "DELETING"){
                const snapshot = await buildProjectSnapshot(project.id);

                logger.warn({
                    projectId: project.id,
                    operation: "project.delete.already_in_progress",
                    status: "SKIPPED",
                    reason: "Project is already in DELETING state",
                    meta: {
                        currentStatus: project.status,
                    },
                });

                return {
                    httpStatus : 202,
                    message : "Project deletion is already in progress",
                    project : snapshot.project,
                    runtime : snapshot.runtime,
                    inProgress : true,
                }
            }

            if(project.status === "READY"){
                const snapshot = await buildProjectSnapshot(project.id);

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

            if (
                project.status === "BOOTING_CONTAINER" ||
                project.status === "ALLOCATING_VM"
            ) {
                const snapshot = await buildProjectSnapshot(project.id);

                return {
                httpStatus: 202,
                message: "Project runtime provisioning is already in progress",
                project: snapshot.project,
                runtime: snapshot.runtime,
                inProgress: true,
                };
            }

            if(project.status === "CREATED" || project.status === "FAILED"){
                await markProjectAllocating(project.id);
            }
            

            const runtimeResult = await withProjectRuntimeLock(project.id,() => 
                ensureProjectRuntime(project.id, project.name, project.type , ownerId)
            );

            if(!runtimeResult.lockAcquired){
                const snapshot = await buildProjectSnapshot(project.id);

                logger.warn({
                    projectId: project.id,
                    operation: "project.runtime.lock_busy",
                    status: "SKIPPED",
                    reason: "Project runtime reconciliation already in progress",
                    meta: {},
                });

                return {
                    httpStatus : 202,
                    message: "Project runtime reconciliation already in progress",
                    project: snapshot.project,
                    runtime: snapshot.runtime,
                    inProgress: true,
                }
            };

            const runtime = runtimeResult.value;
            const snapshot = await buildProjectSnapshot(project.id);

            if(!runtime){
                const latestSnapshot = await buildProjectSnapshot(project.id);

                if (latestSnapshot.project?.status === "FAILED") {
                    return {
                    httpStatus: 500,
                    message:
                        latestSnapshot.project.lastEventMessage ??
                        "Project runtime failed to start",
                    project: latestSnapshot.project,
                    runtime: latestSnapshot.runtime,
                    inProgress: false,
                    };
                }
                return {
                    httpStatus : 202,
                    message : "Project exists but runtime provisioning",
                    project : snapshot.project,
                    runtime : snapshot.runtime,
                    inProgress : true,
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
        logWarn({
            userId: ownerId,
            operation: "project.create.lock_busy",
            status: "SKIPPED",
            reason: "Another create request for this project is already in progress",
            meta: {
                projectName: normalizedName,
                projectType: type,
            },
        });

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
    const logger = createScopedLogger({
        projectId,
        userId: ownerId,
    });

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
                const snapshot = await buildProjectSnapshot(projectId);

                logger.warn({
                    operation: "project.delete.already_in_progress",
                    status: "SKIPPED",
                    reason: "Project deletion is already in progress",
                    meta: {
                        currentStatus: ownedProject.status,
                    },
                });

                return {
                    httpStatus: 202,
                    message: "Project deletion is already in progress",
                    project: snapshot.project,
                    runtime: snapshot.runtime,
                    inProgress: true,
                }
            }

            await markProjectDeleting(projectId);
            logger.info({
                operation: "project.deletion.started",
                status: "STARTED",
                reason: "Project marked DELETING",
                meta: {},
            });

            try{
                const cleanupResult = await withProjectRuntimeLock(projectId, () => 
                    cleanupProjectRuntimeAssignment(projectId,ownerId), 
                );

                if(!cleanupResult.lockAcquired){
                    const snapshot = await buildProjectSnapshot(projectId);

                    logger.warn({
                        operation: "project.delete.runtime_lock_busy",
                        status: "SKIPPED",
                        reason: "Project runtime cleanup already in progress",
                        meta: {},
                    });

                    return {
                        httpStatus: 202,
                        message: "Project runtime cleanup already in progress",
                        project: snapshot.project,
                        runtime: snapshot.runtime,
                        inProgress: true,
                    }
                }

                await cleanupProjectArtifacts({
                    projectId,
                    projectName : ownedProject.name,
                    projectType : ownedProject.type,
                });

                const finalized = await finalizeProjectDeletion(projectId,ownerId);
                const snapshot = await buildProjectSnapshot(projectId);

                if(!finalized){
                    return {
                        httpStatus : 202,
                        message : "Delete accepted but cleanup is still reconciling",
                        project : snapshot.project,
                        runtime : snapshot.runtime,
                        inProgress : true,
                    }
                }

                return {
                    httpStatus : 200,
                    message : `Project ${projectId} deleted successfully`,
                    project : snapshot.project,
                    runtime : null,
                    inProgress : false,
                }
            } catch (err ){
                await markProjectDeletePendingReason(projectId, 
                    err instanceof Error ? err.message : "Unknown delete error",
                );

                const snapshot = await buildProjectSnapshot(projectId);

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
        const snapshot = await buildProjectSnapshot(projectId);

        logWarn({
            projectId,
            userId: ownerId,
            operation: "project.delete.lock_busy",
            status: "SKIPPED",
            reason: "Delete request already in progress",
            meta: {},
        });
        
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