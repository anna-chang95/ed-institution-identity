// PostgreSQL client via Prisma
// Single shared instance across the application.
// In tests, this is replaced by mock data — no real DB connection needed.

import { PrismaClient } from '@prisma/client';

// Prevent multiple Prisma instances during hot reload in development.
// In production, a single instance is created once.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
