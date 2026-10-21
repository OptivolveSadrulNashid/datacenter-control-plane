import { NodeStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../src/domain/errors.js';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
} from '../src/domain/lifecycle.js';

describe('node lifecycle state machine', () => {
  it('allows the documented happy path', () => {
    const path: NodeStatus[] = [
      NodeStatus.CREATED,
      NodeStatus.PROVISIONING,
      NodeStatus.ACTIVE,
      NodeStatus.MAINTENANCE,
      NodeStatus.ACTIVE,
      NodeStatus.FAILED,
      NodeStatus.RETIRED,
    ];

    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('rejects skipping provisioning', () => {
    expect(canTransition(NodeStatus.CREATED, NodeStatus.ACTIVE)).toBe(false);
    expect(() => assertTransition(NodeStatus.CREATED, NodeStatus.ACTIVE)).toThrow(
      InvalidTransitionError,
    );
  });

  it('treats RETIRED as terminal', () => {
    expect(isTerminal(NodeStatus.RETIRED)).toBe(true);
    for (const status of Object.values(NodeStatus)) {
      expect(canTransition(NodeStatus.RETIRED, status)).toBe(false);
    }
  });

  it('never allows a node to transition to itself', () => {
    for (const status of Object.values(NodeStatus)) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('defines transitions for every status', () => {
    for (const status of Object.values(NodeStatus)) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('reports the legal alternatives on failure', () => {
    try {
      assertTransition(NodeStatus.ACTIVE, NodeStatus.PROVISIONING);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as InvalidTransitionError).statusCode).toBe(422);
      expect((err as InvalidTransitionError).details).toMatchObject({
        from: NodeStatus.ACTIVE,
        to: NodeStatus.PROVISIONING,
      });
    }
  });
});
