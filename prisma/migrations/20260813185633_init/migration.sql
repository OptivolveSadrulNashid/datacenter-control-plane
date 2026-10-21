-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('CREATED', 'PROVISIONING', 'ACTIVE', 'MAINTENANCE', 'FAILED', 'RETIRED');

-- CreateEnum
CREATE TYPE "GpuHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobAction" AS ENUM ('PROVISION_NODE', 'DECOMMISSION_NODE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clusters" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "racks" (
    "id" UUID NOT NULL,
    "clusterId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "racks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" UUID NOT NULL,
    "rackId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "cpu" TEXT NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "status" "NodeStatus" NOT NULL DEFAULT 'CREATED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gpus" (
    "id" UUID NOT NULL,
    "nodeId" UUID,
    "vendor" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "healthStatus" "GpuHealth" NOT NULL DEFAULT 'HEALTHY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "gpus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_events" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "oldStatus" "NodeStatus",
    "newStatus" "NodeStatus" NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "nodeId" UUID,
    "action" "JobAction" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "actor" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "clusters_name_key" ON "clusters"("name");

-- CreateIndex
CREATE INDEX "clusters_location_idx" ON "clusters"("location");

-- CreateIndex
CREATE INDEX "clusters_deletedAt_idx" ON "clusters"("deletedAt");

-- CreateIndex
CREATE INDEX "racks_clusterId_idx" ON "racks"("clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "racks_clusterId_name_key" ON "racks"("clusterId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_hostname_key" ON "nodes"("hostname");

-- CreateIndex
CREATE INDEX "nodes_rackId_idx" ON "nodes"("rackId");

-- CreateIndex
CREATE INDEX "nodes_status_idx" ON "nodes"("status");

-- CreateIndex
CREATE INDEX "nodes_status_deletedAt_idx" ON "nodes"("status", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "gpus_serialNumber_key" ON "gpus"("serialNumber");

-- CreateIndex
CREATE INDEX "gpus_nodeId_idx" ON "gpus"("nodeId");

-- CreateIndex
CREATE INDEX "gpus_vendor_healthStatus_idx" ON "gpus"("vendor", "healthStatus");

-- CreateIndex
CREATE INDEX "lifecycle_events_nodeId_createdAt_idx" ON "lifecycle_events"("nodeId", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_nodeId_idx" ON "jobs"("nodeId");

-- AddForeignKey
ALTER TABLE "racks" ADD CONSTRAINT "racks_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "racks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gpus" ADD CONSTRAINT "gpus_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
