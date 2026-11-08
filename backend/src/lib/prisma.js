import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Builds a Prisma 7 client on the pg driver adapter.
 *
 * A `?schema=` parameter in the URL (used by tests) is applied in two places:
 * the adapter option (Prisma-generated queries) and the connection
 * search_path (raw SQL such as advisory locks), so both hit the same schema.
 */
export function createPrismaClient(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get("schema") || undefined;
  url.searchParams.delete("schema");

  const poolConfig = { connectionString: url.toString() };
  if (schema) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("Invalid schema name in DATABASE_URL");
    poolConfig.options = `-c search_path=${schema}`;
  }
  const adapter = new PrismaPg(poolConfig, schema ? { schema } : undefined);
  return new PrismaClient({ adapter });
}
