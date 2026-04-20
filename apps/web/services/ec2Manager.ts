import { terminateAndReplace } from "../lib/aws/asgCommands";
import { ensureIdleCapacityForAllocation, getIdleMachines } from "./asgManager"
import { deleteInstanceLifecycle, cleanupProjectRuntimeAssignment, rehydrateProjectRuntimeRedis, mirrorProjectAssignmentToRedis } from "./redisManager";
import { prisma } from "db/client";
import { markProjectBooting, markProjectFailed, markProjectReady } from "./projectLifecycleManager";
import { ACTIVE_RUNTIME_STATUSES, getProjectRuntimeSnapshot } from "./projectRuntimeTruthSource";
import { createScopedLogger, logError, logInfo } from "../lib/observability/structuredLogger";
import { startVmContainer, waitForVmAgentHealthy, waitForVmContainerRunning, waitForWorkspaceReady } from "../lib/vmAgent/client";
import { waitForPublicIP } from "../lib/aws/ec2Commands";
import { ENV } from "../lib/config/env";

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
       
        if(anotherActiveProject){
            await cleanupProjectRuntimeAssignment(anotherActiveProject.id, ownerId);
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
        
        const bootStartedAt = new Date();

        await markProjectBooting(projectId,{
            instanceId,
            publicIp: publicIP,
            bootStartedAt,
        })

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

             const startContainer = await startVmContainer({
                publicIP,
                projectId,
                projectName,
                projectType,
                containerName,
             });

            containerName = startContainer.containerName ?? containerName;

            logger.info({
                instanceId,
                containerName,
                operation: "runtime.container_running.wait_started",
                status: "STARTED",
                reason: "Waiting for Docker container to report running",
                meta: {
                    publicIP,
                },
            });

            await waitForVmContainerRunning({
                publicIP,
                containerName,
            });

            logger.info({
                instanceId,
                containerName,
                operation: "runtime.container_running.wait_succeeded",
                status: "SUCCESS",
                reason: "Docker container reported running",
                meta: {
                    publicIP,
                },
            });

            logger.info({
                instanceId,
                containerName,
                operation: "runtime.workspace_ready.wait_started",
                status: "STARTED",
                reason: "Waiting for workspace HTTP endpoint to become reachable",
                meta: {
                    publicIP,
                },
            });

            await waitForWorkspaceReady(publicIP);

            logger.info({
                instanceId,
                containerName,
                operation: "runtime.workspace_ready.wait_succeeded",
                status: "SUCCESS",
                reason: "Workspace HTTP endpoint became reachable",
                meta: {
                    publicIP,
                },
            });
        }
        
        catch(err:unknown){
            logger.error({
                instanceId,
                containerName,
                operation: "runtime.container_boot.failed",
                status: "FAILED",
                reason: err instanceof Error ? err.message : "Unknown container boot error",
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
        
        await markProjectReady(projectId,{
            instanceId,
            publicIp: publicIP,
            containerName,
            bootCompletedAt: new Date(),
        });

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


