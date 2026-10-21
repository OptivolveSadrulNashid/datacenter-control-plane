import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * Anything soft-deleted is invisible to normal reads. Keeping this in one place
 * means a route can never forget the filter.
 */
export const notDeleted = { deletedAt: null } as const;
