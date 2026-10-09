import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

const dbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "db");
const migrationsDir = path.join(dbDir, "migrations");

// Any fixed 64-bit key; it only has to be the same in every Atelier process.
const MIGRATION_LOCK = 0x61_74_65_6c_69_65_72n; // "atelier"

// Applies forward-only migrations, one file per transaction, recorded in
// schema_migrations, then re-applies db/grants.sql. Must run as the table owner.
// A session advisory lock serializes concurrent start-ups.
export async function migrate(sql: postgres.Sql): Promise<string[]> {
    return sql.reserve().then(async (conn) => {
        try {
            await conn`SELECT pg_advisory_lock(${MIGRATION_LOCK.toString()}::bigint)`;
            await conn`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
            const files = readdirSync(migrationsDir)
                .filter((f) => f.endsWith(".sql"))
                .sort();
            const applied: string[] = [];
            for (const file of files) {
                const done = await conn`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
                if (done.length) continue;
                const sqlText = readFileSync(path.join(migrationsDir, file), "utf8");
                await conn
                    .unsafe(`BEGIN;\n${sqlText}\n;INSERT INTO schema_migrations (name) VALUES ('${file.replaceAll("'", "''")}');\nCOMMIT;`)
                    .catch(async (err) => {
                        await conn.unsafe("ROLLBACK").catch(() => {});
                        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
                    });
                applied.push(file);
            }
            await conn.unsafe(readFileSync(path.join(dbDir, "grants.sql"), "utf8"));
            return applied;
        } finally {
            await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK.toString()}::bigint)`.catch(() => {});
            conn.release();
        }
    });
}

// True when the connection's role owns the tenant tables, i.e. the server is not
// using the separate runtime role (FORCE ROW LEVEL SECURITY is then the only
// thing between a SQL bug and every tenant's rows).
export async function connectedAsOwner(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ owner: boolean }[]>`
        SELECT pg_get_userbyid(relowner) = current_user AS owner FROM pg_class WHERE oid = 'public.projects'::regclass`;
    return rows[0]?.owner ?? false;
}
