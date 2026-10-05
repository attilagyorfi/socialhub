import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
});
export const db = drizzle(pool);
export { sql } from "drizzle-orm";
