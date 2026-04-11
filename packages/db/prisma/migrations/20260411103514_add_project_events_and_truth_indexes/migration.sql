-- CreateEnum
CREATE TYPE "ProjectEventType" AS ENUM ('PROJECT_CREATED', 'ALLOCATION_STARTED', 'INSTANCE_ASSIGNED', 'CONTAINER_BOOT_STARTED', 'CONTAINER_BOOT_SUCCEEDED', 'CONTAINER_BOOT_FAILED', 'HEARTBEAT_OK', 'HEARTBEAT_FAILED', 'RUNTIME_RECOVERY_STARTED', 'RUNTIME_RECOVERY_COMPLETED', 'DELETE_STARTED', 'RUNTIME_CLEANUP_STARTED', 'RUNTIME_CLEANUP_COMPLETED', 'ARTIFACT_CLEANUP_COMPLETED', 'DELETE_COMPLETED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "lastEventAt" TIMESTAMP(3),
ADD COLUMN     "lastEventMessage" TEXT,
ADD COLUMN     "lastEventType" "ProjectEventType";

-- CreateTable
CREATE TABLE "ProjectEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "eventType" "ProjectEventType" NOT NULL,
    "fromStatus" "ProjectLifecycleStatus",
    "toStatus" "ProjectLifecycleStatus",
    "message" TEXT,
    "instanceId" TEXT,
    "publicIp" TEXT,
    "containerName" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectEvent_projectId_createdAt_idx" ON "ProjectEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectEvent_projectId_eventType_createdAt_idx" ON "ProjectEvent"("projectId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectEvent_instanceId_createdAt_idx" ON "ProjectEvent"("instanceId", "createdAt");

-- CreateIndex
CREATE INDEX "Project_assignedInstanceId_idx" ON "Project"("assignedInstanceId");

-- CreateIndex
CREATE INDEX "Project_deletedAt_status_idx" ON "Project"("deletedAt", "status");

-- CreateIndex
CREATE INDEX "Project_ownerId_deletedAt_status_idx" ON "Project"("ownerId", "deletedAt", "status");

-- AddForeignKey
ALTER TABLE "ProjectEvent" ADD CONSTRAINT "ProjectEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
