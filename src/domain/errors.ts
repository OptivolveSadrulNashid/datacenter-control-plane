export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(404, 'NOT_FOUND', `${resource} ${id} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, 'CONFLICT', message, details);
  }
}

/** The caller's `version` no longer matches the row: someone else wrote first. */
export class VersionConflictError extends AppError {
  constructor(expected: number, actual: number) {
    super(
      409,
      'VERSION_CONFLICT',
      `Node was modified by another request (you sent version ${expected}, current is ${actual}). Re-read the node and retry.`,
      { expectedVersion: expected, currentVersion: actual },
    );
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string, allowed: readonly string[]) {
    super(422, 'INVALID_TRANSITION', `Cannot move node from ${from} to ${to}`, {
      from,
      to,
      allowed,
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(required: readonly string[], actual: string) {
    super(403, 'FORBIDDEN', `This action requires one of: ${required.join(', ')}`, {
      requiredRoles: required,
      yourRole: actual,
    });
  }
}
