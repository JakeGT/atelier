import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");

// Applies forward-only migrations, one file per transaction, recorded in
// schema_migrations. The caller holds the advisory lock for multi-process safety.
export async function migrate(sql: postgres.Sql): Promise<string[]> {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
    const applied: string[] = [];
    for (const file of files) {
        const done = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
        if (done.length) continue;
        const sqlText = readFileSync(path.join(migrationsDir, file), "utf8");
        await sql.begin(async (tx) => {
            await tx.unsafe(sqlText);
            await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
        });
        applied.push(file);
    }
    return applied;
}
