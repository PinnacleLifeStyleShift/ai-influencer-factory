import { defineConfig } from "prisma/config";

/**
 * Prisma 7 CLI configuration (migrate, generate, studio).
 * Prisma 7 does not load .env files; DATABASE_URL must be in the environment.
 * It is optional here so `prisma generate` works at build time without a database.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
