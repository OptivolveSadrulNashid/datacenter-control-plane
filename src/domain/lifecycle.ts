import { NodeStatus } from '@prisma/client';
import { InvalidTransitionError } from './errors.js';

/**
 * The node lifecycle as an explicit state machine.
 *
 *   CREATED → PROVISIONING → ACTIVE ⇄ MAINTENANCE
 *                    ↓          ↓          ↓
 *                  FAILED ←─────┴──────────┘
 *                    ↓
 *                 RETIRED  (terminal)
 *
 * Encoding it here rather than scattering `if (status === ...)` checks through
 * the routes means every write path is validated by the same rules, and adding
 * a state is a one-line change with a compile-time exhaustiveness guarantee.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  [NodeStatus.CREATED]: [NodeStatus.PROVISIONING, NodeStatus.RETIRED],
  [NodeStatus.PROVISIONING]: [NodeStatus.ACTIVE, NodeStatus.FAILED],
  [NodeStatus.ACTIVE]: [NodeStatus.MAINTENANCE, NodeStatus.FAILED, NodeStatus.RETIRED],
  [NodeStatus.MAINTENANCE]: [NodeStatus.ACTIVE, NodeStatus.FAILED, NodeStatus.RETIRED],
  [NodeStatus.FAILED]: [NodeStatus.PROVISIONING, NodeStatus.MAINTENANCE, NodeStatus.RETIRED],
  [NodeStatus.RETIRED]: [],
};

export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throws `InvalidTransitionError` (422) unless the transition is legal. */
export function assertTransition(from: NodeStatus, to: NodeStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to, ALLOWED_TRANSITIONS[from]);
  }
}

export function isTerminal(status: NodeStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
