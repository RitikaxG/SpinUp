-- CreateEnum
CREATE TYPE "VmState" AS ENUM ('STOPPED', 'BOOTING', 'RUNNING', 'FAILED', 'TERMINATING');

-- DropIndex
DROP INDEX "Project_name_key";

-- AlterTable
ALTER TABLE "ProjectRoom" ADD COLUMN     "vmState" "VmState" NOT NULL DEFAULT 'STOPPED';
