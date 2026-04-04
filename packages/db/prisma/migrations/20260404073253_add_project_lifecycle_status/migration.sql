-- CreateEnum
CREATE TYPE "ProjectLifecycleStatus" AS ENUM ('CREATED', 'ALLOCATING_VM', 'BOOTING_CONTAINER', 'READY', 'FAILED', 'DELETING', 'DELETED');

-- DropIndex
DROP INDEX "Project_ownerId_name_key";

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "assignedInstanceId" TEXT,
ADD COLUMN     "bootCompletedAt" TIMESTAMP(3),
ADD COLUMN     "bootStartedAt" TIMESTAMP(3),
ADD COLUMN     "cleanupCompletedAt" TIMESTAMP(3),
ADD COLUMN     "cleanupStartedAt" TIMESTAMP(3),
ADD COLUMN     "containerName" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "publicIp" TEXT,
ADD COLUMN     "status" "ProjectLifecycleStatus" NOT NULL DEFAULT 'CREATED',
ADD COLUMN     "statusReason" TEXT;

-- CreateIndex
CREATE INDEX "Project_ownerId_name_idx" ON "Project"("ownerId", "name");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Project_ownerId_status_idx" ON "Project"("ownerId", "status");
