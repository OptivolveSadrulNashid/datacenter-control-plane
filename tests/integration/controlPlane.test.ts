/**
 * Integration tests against real Postgres and RabbitMQ.
 *
 *   docker compose up -d postgres redis rabbitmq
 *   cp .env.example .env && npx prisma migrate deploy && npm run seed
 *   RUN_INTEGRATION=1 npm test
 *
 * Skipped unless RUN_INTEGRATION=1 so `npm test` stays green with no services up.
 */
import { JobStatus, NodeStatus, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { VersionConflictError } from '../../src/domain/errors.js';
import { prisma } from '../../src/prisma.js';
import { closeQueue, initQueue } from '../../src/queue.js';
import { redis } from '../../src/redis.js';
import { updateNodeStatus } from '../../src/services/nodeService.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

const SUFFIX = process.pid.toString(36);

suite('control plane', () => {
  let app: FastifyInstance;
  let rackId: string;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    await initQueue();
    app = await buildApp();
    await app.ready();

    const cluster = await prisma.cluster.create({
      data: { name: `test-cluster-${SUFFIX}`, location: 'test' },
    });
    const rack = await prisma.rack.create({ data: { clusterId: cluster.id, name: 'T01' } });
    rackId = rack.id;

    for (const [email, role] of [
      [`it-admin-${SUFFIX}@icp.local`, Role.ADMIN],
      [`it-viewer-${SUFFIX}@icp.local`, Role.VIEWER],
    ] as const) {
      await prisma.user.create({
        data: { email, role, passwordHash: await bcrypt.hash('password12345', 4) },
      });
    }

    adminToken = await login(`it-admin-${SUFFIX}@icp.local`);
    viewerToken = await login(`it-viewer-${SUFFIX}@icp.local`);
  });

  afterAll(async () => {
    await app?.close();
    await closeQueue();
    await prisma.$disconnect();
    redis.disconnect();
  });

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'password12345' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token;
  }

  async function makeNode(status: NodeStatus = NodeStatus.ACTIVE) {
    return prisma.node.create({
      data: {
        rackId,
        hostname: `node-${SUFFIX}-${Math.random().toString(36).slice(2, 10)}`,
        cpu: 'AMD EPYC 9654',
        memoryMb: 786_432,
        status,
      },
    });
  }

  describe('authentication and RBAC', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'GET', url: '/nodes' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a bad password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `it-admin-${SUFFIX}@icp.local`, password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('lets a viewer read but not write', async () => {
      const read = await app.inject({
        method: 'GET',
        url: '/nodes',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(read.statusCode).toBe(200);

      const write = await app.inject({
        method: 'POST',
        url: '/nodes',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { rackId, hostname: 'viewer-attempt', cpu: 'x', memoryMb: 1024 },
      });
      expect(write.statusCode).toBe(403);
      expect(write.json().error.details.yourRole).toBe(Role.VIEWER);
    });
  });

  describe('validation', () => {
    it('returns a field-level 400 for a malformed payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/nodes',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { rackId: 'not-a-uuid', hostname: 'BAD_HOST', cpu: '', memoryMb: -1 },
      });
      expect(res.statusCode).toBe(400);
      const paths = res.json().error.details.map((d: { path: string }) => d.path);
      expect(paths).toContain('rackId');
      expect(paths).toContain('hostname');
      expect(paths).toContain('memoryMb');
    });
  });

  describe('optimistic locking', () => {
    it('accepts the first writer and 409s the second on a stale version', async () => {
      const node = await makeNode();
      const headers = { authorization: `Bearer ${adminToken}` };

      const first = await app.inject({
        method: 'PATCH',
        url: `/nodes/${node.id}/status`,
        headers,
        payload: { status: NodeStatus.MAINTENANCE, version: node.version },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().version).toBe(node.version + 1);

      // Second engineer read the same version and submits after the first.
      const second = await app.inject({
        method: 'PATCH',
        url: `/nodes/${node.id}/status`,
        headers,
        payload: { status: NodeStatus.FAILED, version: node.version },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('VERSION_CONFLICT');
      expect(second.json().error.details).toMatchObject({
        expectedVersion: node.version,
        currentVersion: node.version + 1,
      });

      const after = await prisma.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(after.status).toBe(NodeStatus.MAINTENANCE); // the lost update never landed
    });

    it('lets exactly one of two truly concurrent writes win', async () => {
      const node = await makeNode();

      const results = await Promise.allSettled([
        updateNodeStatus({
          id: node.id,
          to: NodeStatus.MAINTENANCE,
          expectedVersion: node.version,
          actor: 'engineer-a',
        }),
        updateNodeStatus({
          id: node.id,
          to: NodeStatus.FAILED,
          expectedVersion: node.version,
          actor: 'engineer-b',
        }),
      ]);

      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);

      const after = await prisma.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(after.version).toBe(node.version + 1); // exactly one increment
    });

    it('rejects an illegal transition with 422 before touching the row', async () => {
      const node = await makeNode(NodeStatus.CREATED);
      const res = await app.inject({
        method: 'PATCH',
        url: `/nodes/${node.id}/status`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: NodeStatus.ACTIVE, version: node.version },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_TRANSITION');

      const after = await prisma.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(after.version).toBe(node.version);
      expect(after.status).toBe(NodeStatus.CREATED);
    });
  });

  describe('audit trail', () => {
    it('appends an immutable event per transition', async () => {
      const node = await makeNode();
      const headers = { authorization: `Bearer ${adminToken}` };
      let version = node.version;

      for (const status of [NodeStatus.MAINTENANCE, NodeStatus.ACTIVE, NodeStatus.RETIRED]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/nodes/${node.id}/status`,
          headers,
          payload: { status, version, reason: `moving to ${status}` },
        });
        expect(res.statusCode, res.body).toBe(200);
        version = res.json().version;
      }

      const history = await app.inject({
        method: 'GET',
        url: `/nodes/${node.id}/history`,
        headers,
      });
      const events = history.json().events;
      expect(events.map((e: { newStatus: string }) => e.newStatus)).toEqual([
        NodeStatus.MAINTENANCE,
        NodeStatus.ACTIVE,
        NodeStatus.RETIRED,
      ]);
      expect(events[0].oldStatus).toBe(NodeStatus.ACTIVE);
      expect(events[0].actor).toBe(`it-admin-${SUFFIX}@icp.local`);
    });

    it('keeps history readable after a soft delete', async () => {
      const node = await makeNode();
      const headers = { authorization: `Bearer ${adminToken}` };

      const del = await app.inject({ method: 'DELETE', url: `/nodes/${node.id}`, headers });
      expect(del.statusCode).toBe(204);

      const get = await app.inject({ method: 'GET', url: `/nodes/${node.id}`, headers });
      expect(get.statusCode).toBe(404); // gone from normal reads

      const history = await app.inject({
        method: 'GET',
        url: `/nodes/${node.id}/history`,
        headers,
      });
      expect(history.statusCode).toBe(200); // but the trail survives
      expect(history.json().events.length).toBeGreaterThan(0);
    });
  });

  describe('asynchronous provisioning', () => {
    it('answers 202 with a pollable job instead of blocking', async () => {
      const hostname = `async-${SUFFIX}-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: 'POST',
        url: '/nodes',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          rackId,
          hostname,
          cpu: 'Intel Xeon 8592+',
          memoryMb: 524_288,
          gpus: [
            {
              vendor: 'NVIDIA',
              model: 'H100',
              memoryMb: 81_920,
              serialNumber: `SN-${SUFFIX}-${Date.now().toString(36)}`,
            },
          ],
        },
      });

      expect(res.statusCode).toBe(202);
      expect(res.headers.location).toBe(`/jobs/${res.json().jobId}`);

      const job = await prisma.job.findUniqueOrThrow({ where: { id: res.json().jobId } });
      expect(job.status).toBe(JobStatus.QUEUED); // the API did not do the work itself
      expect(job.nodeId).toBeNull();

      // No node exists yet — only the intent has been recorded.
      expect(await prisma.node.findUnique({ where: { hostname } })).toBeNull();
    });
  });

  describe('transactional provisioning', () => {
    it('rolls the node back when GPU insertion fails', async () => {
      const { provisionNode } = await import('../../src/services/provisioningService.js');
      const hostname = `tx-${SUFFIX}-${Date.now().toString(36)}`;
      const duplicate = `DUP-${SUFFIX}-${Date.now().toString(36)}`;

      const job = await prisma.job.create({
        data: { action: 'PROVISION_NODE', payload: {}, actor: 'test' },
      });

      await provisionNode({
        jobId: job.id,
        actor: 'test',
        payload: {
          rackId,
          hostname,
          cpu: 'test',
          memoryMb: 1024,
          // Two GPUs with the same serial number violate the unique index, so
          // the whole transaction — including the node insert — must roll back.
          gpus: [
            { vendor: 'NVIDIA', model: 'H100', memoryMb: 1024, serialNumber: duplicate },
            { vendor: 'NVIDIA', model: 'H100', memoryMb: 1024, serialNumber: duplicate },
          ],
        },
      });

      expect(await prisma.node.findUnique({ where: { hostname } })).toBeNull();
      expect(await prisma.gpu.findUnique({ where: { serialNumber: duplicate } })).toBeNull();

      const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe(JobStatus.FAILED);
      expect(after.error).toBeTruthy();
    });
  });
});
