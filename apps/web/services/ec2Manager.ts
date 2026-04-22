import { terminateAndReplace, terminateAndScaleDown } from "../lib/aws/asgCommands";
import { ensureIdleCapacityForAllocation, getIdleMachines } from "./asgManager"
import { deleteInstanceLifecycle, cleanupProjectRuntimeAssignment, rehydrateProjectRuntimeRedis, mirrorProjectAssignmentToRedis } from "./redisManager";
import { prisma } from "db/client";
import { markProjectBooting, markProjectFailed, markProjectReady } from "./projectLifecycleManager";
import { ACTIVE_RUNTIME_STATUSES, getProjectRuntimeSnapshot } from "./projectRuntimeTruthSource";
import { createScopedLogger, logError, logInfo } from "../lib/observability/structuredLogger";
import { startVmContainer, waitForRuntimeReady, waitForVmAgentHealthy } from "../lib/vmAgent/client";
import { waitForPublicIP } from "../lib/aws/ec2Commands";
import { ENV } from "../lib/config/env";
import axios from "axios";

const INSTANCE_WAIT_TIMEOUT = 180_000;
const POLL_INTERVAL = 5000;

type ProjectTypeValue = "NEXTJS"| "REACT" | "REACT_NATIVE"
type VmStateValue = "RUNNING" | "STOPPED" | "FAILED" | "TERMINATING" | "BOOTING";

export type RuntimeAssignment = {
    userId : string,
    instanceId : string,
    publicIP : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue,
    containerName : string,
};

const buildContainerName = (projectId : string) => `spinup-${projectId}`;

const toRunningAssignment = (
    ownerId : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue,
    instanceId : string,
    publicIP : string,
    containerName : string,
) : RuntimeAssignment => ({
    userId : ownerId,
    instanceId,
    publicIP,
    projectId,
    projectName,
    projectType,
    containerName,
});

const updateProjectRoomVmState = async (
    projectId : string,
    userId : string,
    vmState : VmStateValue
) => {
    await prisma.projectRoom.updateMany({
        where: {
            projectId,
            userId,
        },
        data: {
            vmState
        }
    })
}

const isDeletionTerminalOrInProgress = (status?: string | null) => {
    return status === "DELETING" || status === "DELETED";
};

const getLatestProjectLifecycleState = async (projectId: string) => {
    return prisma.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            ownerId: true,
            name: true,
            type: true,
            status: true,
            assignedInstanceId: true,
            publicIp: true,
            containerName: true,
        },
    });
};

const stopContainerBestEffort = async ({
    publicIP,
    containerName,
    logger,
    instanceId,
}: {
    publicIP?: string | null;
    containerName?: string | null;
    logger: ReturnType<typeof createScopedLogger>;
    instanceId?: string | null;
}) => {
    if (!publicIP || !containerName) return;

    try {
        await axios.post(
            `http://${publicIP}:3000/stop`,
            { containerName },
            { timeout: 5000 },
        );
    } catch (err) {
        logger.warn({
            instanceId: instanceId ?? null,
            containerName: containerName ?? null,
            operation: "runtime.cancel.stop_container_failed",
            status: "SKIPPED",
            reason:
                err instanceof Error
                    ? err.message
                    : "Failed to stop container during cancellation",
            meta: {
                publicIP,
            },
        });
    }
};

const cancelProvisioningIfDeletionRequested = async ({
    projectId,
    ownerId,
    projectName,
    projectType,
    instanceId,
    publicIP,
    containerName,
    phase,
    logger,
}: {
    projectId: string;
    ownerId: string;
    projectName: string;
    projectType: ProjectTypeValue;
    instanceId?: string | null;
    publicIP?: string | null;
    containerName?: string | null;
    phase: string;
    logger: ReturnType<typeof createScopedLogger>;
}): Promise<boolean> => {
    const latest = await getLatestProjectLifecycleState(projectId);

    if (!latest || !isDeletionTerminalOrInProgress(latest.status)) {
        return false;
    }

    logger.warn({
        projectId,
        userId: ownerId,
        instanceId: latest.assignedInstanceId ?? instanceId ?? null,
        containerName: latest.containerName ?? containerName ?? null,
        operation: "runtime.provisioning.cancelled",
        status: "SKIPPED",
        reason: `Deletion requested during ${phase}`,
        meta: {
            phase,
            currentStatus: latest.status,
            publicIP: latest.publicIp ?? publicIP ?? null,
            projectName,
            projectType,
        },
    });

    if (latest.assignedInstanceId) {
        await cleanupProjectRuntimeAssignment(projectId, ownerId);
        return true;
    }

    if (instanceId) {
        await stopContainerBestEffort({
            publicIP,
            containerName,
            logger,
            instanceId,
        });

        try {
            await terminateAndScaleDown(instanceId, false);
        } catch (err) {
            logger.error({
                projectId,
                userId: ownerId,
                instanceId,
                containerName: containerName ?? null,
                operation: "runtime.cancel.terminate_failed",
                status: "FAILED",
                reason:
                    err instanceof Error
                        ? err.message
                        : "Failed to terminate instance during cancellation",
                meta: {
                    publicIP: publicIP ?? null,
                },
            });
        } finally {
            await deleteInstanceLifecycle(instanceId);
        }
    }

    await prisma.projectRoom.updateMany({
        where: {
            projectId,
            userId: ownerId,
        },
        data: {
            vmState: "STOPPED",
        },
    });

    return true;
};

const cleanupFailedInstance = async ({
  instanceId,
  logger,
  containerName,
  publicIP,
}: {
  instanceId: string;
  logger: ReturnType<typeof createScopedLogger>;
  containerName?: string | null;
  publicIP?: string | null;
}) => {
    if (ENV.PRESERVE_FAILED_RUNTIME_FOR_DEBUG) {
    logger.warn({
        instanceId,
        containerName: containerName ?? null,
        operation: "runtime.cleanup.skipped_for_debug",
        status: "SKIPPED",
        reason: "Preserving failed runtime for manual inspection",
        meta: {
        publicIP: publicIP ?? null,
        graceMs: ENV.FAILED_RUNTIME_DEBUG_GRACE_MS,
        },
  });

  return;
}
  try {
    await terminateAndReplace(instanceId);
  } catch (err) {
    logger.error({
      instanceId,
      containerName: containerName ?? null,
      operation: "runtime.rollback_terminate.failed",
      status: "FAILED",
      reason:
        err instanceof Error ? err.message : "Rollback terminate failed",
      meta: {
        publicIP: publicIP ?? null,
      },
    });
  } finally {
    await deleteInstanceLifecycle(instanceId);
  }
};


export const allocateVmAndScaleUp = async () => {
  let idleMachines = await getIdleMachines();

  if (idleMachines.length > 0) {
    logInfo({
      instanceId: idleMachines[0]?.InstanceId ?? null,
      operation: "capacity.idle_instance.found",
      status: "SUCCESS",
      reason: "Idle VM available immediately for allocation",
      meta: {
        idleCount: idleMachines.length,
      },
    });
    return { instanceId: idleMachines[0]?.InstanceId ?? null };
  }

  logInfo({
    operation: "runtime.vm.allocation_wait_started",
    status: "STARTED",
    reason: "No idle machines found. Waiting for capacity",
    meta: {},
  });

  const scalingDecision = await ensureIdleCapacityForAllocation();
  console.log(
    `Allocation scaling decision: ${scalingDecision.action} - ${scalingDecision.reason}`,
  );

  const start = Date.now();

  while (Date.now() - start < INSTANCE_WAIT_TIMEOUT) {
    idleMachines = await getIdleMachines();

    if (idleMachines.length > 0) {
      logInfo({
        instanceId: idleMachines[0]?.InstanceId ?? null,
        operation: "runtime.vm.allocated",
        status: "SUCCESS",
        reason: "Idle VM became available for project allocation",
        meta: {},
      });
      return { instanceId: idleMachines[0]?.InstanceId ?? null };
    }

    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
  }

  logError({
    operation: "runtime.vm.allocation_failed",
    status: "FAILED",
    reason: "No idle machines within allocation wait timeout",
    meta: {
      waitTimeoutMs: INSTANCE_WAIT_TIMEOUT,
    },
  });

  return { instanceId: null };
};

const buildFailureStateReset = ({
  instanceId,
  publicIP,
  containerName,
}: {
  instanceId?: string | null;
  publicIP?: string | null;
  containerName?: string | null;
}) => {
  if (ENV.PRESERVE_FAILED_RUNTIME_FOR_DEBUG) {
    return {
      assignedInstanceId: instanceId ?? null,
      publicIp: publicIP ?? null,
      containerName: containerName ?? null,
      lastHeartbeatAt: null,
    };
  }

  return {
    assignedInstanceId: null,
    publicIp: null,
    containerName: null,
    lastHeartbeatAt: null,
  };
};

export const ensureProjectRuntime = async (
    projectId : string, 
    projectName : string, 
    projectType : ProjectTypeValue, 
    ownerId : string
) : Promise<RuntimeAssignment | null> => {

    const logger = createScopedLogger({
        projectId,
        userId: ownerId,
        meta: {
            projectName,
            projectType,
        },
    });

    logger.info({
    operation: "runtime.ensure.started",
    status: "STARTED",
    reason: null,
    });

    await updateProjectRoomVmState(projectId, ownerId, "BOOTING");
    
    try{
        const dbSnapshot = await getProjectRuntimeSnapshot(projectId);
        const dbProject = dbSnapshot.project;

        if(!dbProject){
            throw new Error("Project not found");
        }

        if(
            dbProject.assignedInstanceId &&
            dbProject.publicIp &&
            (dbProject.status === "BOOTING_CONTAINER" || dbProject.status === "READY")
        ){
            logger.info({
                projectId: dbProject.id,
                instanceId: dbProject.assignedInstanceId,
                containerName: dbProject.containerName ?? null,
                operation: "runtime.rehydration.requested",
                status: "INFO",
                reason: "Project already has assigned runtime in DB",
                meta: {
                    currentStatus: dbProject.status,
                    publicIP: dbProject.publicIp,
                },
            });
            await rehydrateProjectRuntimeRedis(projectId);

            logger.info({
                projectId: dbProject.id,
                instanceId: dbProject.assignedInstanceId,
                containerName: dbProject.containerName ?? null,
                operation: "runtime.rehydration.completed",
                status: "SUCCESS",
                reason: "Redis runtime assignment restored from DB snapshot",
                meta: {
                    currentStatus: dbProject.status,
                    publicIP: dbProject.publicIp,
                },
            });

            if(dbProject.status === "READY" && dbProject.containerName){
                await updateProjectRoomVmState(projectId, ownerId, "RUNNING");


                return toRunningAssignment(
                ownerId,
                dbProject.id,
                dbProject.name,
                dbProject.type,
                dbProject.assignedInstanceId,
                dbProject.publicIp,
                dbProject.containerName ?? "",
                )
            }
            return null;
        }

        const anotherActiveProject = await prisma.project.findFirst({
            where : {
                ownerId,
                id: { not : projectId },
                deletedAt : null,
                status : { in : ACTIVE_RUNTIME_STATUSES },
                assignedInstanceId: { not: null },
            },
            select : {
                id : true,
            }
        })
       
        if (anotherActiveProject) {
            await cleanupProjectRuntimeAssignment(anotherActiveProject.id, ownerId, {
                mode: "REASSIGN",
                stopReason:
                    `Project runtime was stopped because another project for user ${ownerId} took over the available VM`,
            });
        }
        
    
        // 3) Allocate fresh VM
        const allocation = await allocateVmAndScaleUp();

        if(!allocation.instanceId){
            await updateProjectRoomVmState(projectId, ownerId, "FAILED");
            await markProjectFailed(projectId,"No idle machine available within wait timeout");
            return null;
        }

        const instanceId = allocation.instanceId;

        logger.info({
            instanceId,
            operation: "runtime.vm.allocated",
            status: "SUCCESS",
            reason: "VM allocated for project runtime",
            meta: {},
        });

       // 4) Fetch public IP
        const publicIP   = await waitForPublicIP(instanceId);
        if(!publicIP){

           await cleanupFailedInstance({
            instanceId,
            logger,
            });

            await updateProjectRoomVmState(projectId, ownerId, "FAILED");
            await markProjectFailed(
                projectId,
                `Failed to fetch public IP for instance ${instanceId}`,
                buildFailureStateReset({
                    instanceId,
                    publicIP: null,
                    containerName: null,
                }),
            );

            logger.error({
                instanceId,
                operation: "runtime.public_ip.fetch_failed",
                status: "FAILED",
                reason: `Failed to fetch public IP for instance ${instanceId}`,
                meta: {},
            });
            return null;
        }

        logger.info({
            instanceId,
            operation: "runtime.public_ip.fetched",
            status: "SUCCESS",
            reason: null,
            meta: {
                publicIP,
            },
        });

        try {
            logger.info({
                instanceId,
                operation: "runtime.vm_agent.wait_started",
                status: "STARTED",
                reason: null,
                meta: {
                    publicIP,
                },
            });

            await waitForVmAgentHealthy(publicIP);

            logger.info({
                instanceId,
                operation: "runtime.vm_agent.wait_succeeded",
                status: "SUCCESS",
                reason: "VM agent health endpoint became reachable",
                meta: {
                publicIP,
                },
            });
            } catch (err) {
            logger.error({
                instanceId,
                operation: "runtime.vm_agent.wait_failed",
                status: "FAILED",
                reason:
                err instanceof Error ? err.message : "VM agent health wait failed",
                meta: {
                    publicIP,
                },
            });

      await cleanupFailedInstance({
        instanceId,
        logger,
        publicIP,
      });

      await updateProjectRoomVmState(projectId, ownerId, "FAILED");
      await markProjectFailed(
        projectId,
        `VM agent did not become healthy on instance ${instanceId}`,
        buildFailureStateReset({
            instanceId,
            publicIP,
            containerName: null,
        }),
      );

      return null;
    }

        if (
            await cancelProvisioningIfDeletionRequested({
                projectId,
                ownerId,
                projectName,
                projectType,
                instanceId,
                publicIP,
                phase: "post_vm_agent_health",
                logger,
            })
        ) {
            return null;
        }
        
        const bootStartedAt = new Date();

        if (
            await cancelProvisioningIfDeletionRequested({
                projectId,
                ownerId,
                projectName,
                projectType,
                instanceId,
                publicIP,
                phase: "before_mark_project_booting",
                logger,
            })
        ) {
            return null;
        }

        try {
            await markProjectBooting(projectId, {
                instanceId,
                publicIp: publicIP,
                bootStartedAt,
            });
        } catch (err) {
            const cancelled = await cancelProvisioningIfDeletionRequested({
                projectId,
                ownerId,
                projectName,
                projectType,
                instanceId,
                publicIP,
                phase: "mark_project_booting_transition",
                logger,
            });

            if (cancelled) {
                return null;
            }

            throw err;
        }

        await mirrorProjectAssignmentToRedis({
            instanceId,
            userId : ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
            containerName : "",
            status : "BOOTING",
        })
        // 6) Start deterministic container
        let containerName = buildContainerName(projectId);

        
        try{

            logger.info({
                instanceId,
                operation: "runtime.container_boot.requested",
                status: "STARTED",
                reason: null,
                meta: {
                    publicIP,
                    containerName,
                },
            });

            if (
                await cancelProvisioningIfDeletionRequested({
                    projectId,
                    ownerId,
                    projectName,
                    projectType,
                    instanceId,
                    publicIP,
                    phase: "before_start_vm_container",
                    logger,
                })
            ) {
                return null;
            }

             const startContainer = await startVmContainer({
                publicIP,
                projectId,
                projectName,
                projectType,
                containerName,
             });

            containerName = startContainer.containerName ?? containerName;

            if (
                await cancelProvisioningIfDeletionRequested({
                    projectId,
                    ownerId,
                    projectName,
                    projectType,
                    instanceId,
                    publicIP,
                    containerName,
                    phase: "after_start_vm_container",
                    logger,
                })
            ) {
                return null;
            }

            logger.info({
                instanceId,
                containerName,
                operation: "runtime.ready.wait_started",
                status: "STARTED",
                reason: "Waiting for runtime readiness via container status or workspace HTTP",
                meta: {
                    publicIP,
                },
            });

            const readiness = await waitForRuntimeReady({
                publicIP,
                containerName,
            });

            logger.info({
                instanceId,
                containerName,
                operation: "runtime.ready.wait_succeeded",
                status: "SUCCESS",
                reason:
                    readiness.source === "workspace_http"
                    ? "Workspace HTTP endpoint became reachable"
                    : "Container reported running",
                meta: {
                    publicIP,
                    readinessSource: readiness.source,
                    lastContainerStatus: readiness.lastContainerStatus,
                },
            });
        }
        
        catch(err:unknown){
            logger.error({
                instanceId,
                containerName,
                operation: "runtime.container_boot.failed",
                status: "FAILED",
                reason:
                    err instanceof Error
                    ? err.message
                    : "Runtime was not reported ready by container status or workspace HTTP",
                meta: {
                    publicIP,
                },
            });

            if(err instanceof Error){
                console.error(`Unable to start container inside instance ${instanceId} ${err.message}`);
            }

            logger.error({
                instanceId,
                containerName,
                operation: "runtime.debug.inspect_here",
                status: "FAILED",
                reason: "Container exited after start; inspect VM/container before cleanup",
                meta: {
                    publicIP,
                },
            });

            await cleanupFailedInstance({
                instanceId,
                logger,
                containerName,
                publicIP,
            });

            await updateProjectRoomVmState(projectId,ownerId,"FAILED");
            await markProjectFailed(projectId,
                `Unable to start container inside instance ${instanceId} ${err instanceof Error ? err.message : "Unknown error"}`
            ,
             buildFailureStateReset({
                instanceId,
                publicIP,
                containerName,
            }),
            )
            return null;
        }

        if (
            await cancelProvisioningIfDeletionRequested({
                projectId,
                ownerId,
                projectName,
                projectType,
                instanceId,
                publicIP,
                containerName,
                phase: "before_mark_project_ready",
                logger,
            })
        ) {
            return null;
        }
        
        try {
            await markProjectReady(projectId, {
                instanceId,
                publicIp: publicIP,
                containerName,
                bootCompletedAt: new Date(),
            });
        } catch (err) {
            const cancelled = await cancelProvisioningIfDeletionRequested({
                projectId,
                ownerId,
                projectName,
                projectType,
                instanceId,
                publicIP,
                containerName,
                phase: "mark_project_ready_transition",
                logger,
            });

            if (cancelled) {
                return null;
            }

            throw err;
        }

        logger.info({
            instanceId,
            containerName,
            operation: "runtime.container_boot.succeeded",
            status: "SUCCESS",
            reason: "Container became ready",
            meta: {
                publicIP,
            },
        });

        await mirrorProjectAssignmentToRedis({
            instanceId,
            userId: ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
            containerName,
            status: "RUNNING",
        })

        await updateProjectRoomVmState(projectId, ownerId, "RUNNING");

        return toRunningAssignment(
            ownerId,
            projectId,
            projectName,
            projectType,
            instanceId,
            publicIP,
            containerName,
        )
    }
    catch(err){
        const latest = await getLatestProjectLifecycleState(projectId);

        if (isDeletionTerminalOrInProgress(latest?.status)) {
            logger.warn({
                projectId,
                userId: ownerId,
                operation: "runtime.provisioning.cancelled",
                status: "SKIPPED",
                reason:
                    err instanceof Error
                        ? err.message
                        : "Provisioning aborted because deletion won the race",
                meta: {
                    currentStatus: latest?.status ?? null,
                },
            });

            await prisma.projectRoom.updateMany({
                where: {
                    projectId,
                    userId: ownerId,
                },
                data: {
                    vmState: "STOPPED",
                },
            });

            return null;
        }

        await updateProjectRoomVmState(projectId, ownerId, "FAILED");
        await markProjectFailed(
            projectId,
            err instanceof Error ? err.message : "Unknown VM booting error",
            buildFailureStateReset({
                instanceId: null,
                publicIP: null,
                containerName: null,
            }),
        );

        throw err;
    }
}


