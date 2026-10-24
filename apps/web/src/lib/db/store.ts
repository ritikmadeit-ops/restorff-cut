/**
 * Opens the project store once per server process and runs its migrations.
 *
 * Driver (see docs/restorff/worklog/port.md "Env vars"):
 *   RESTORFFCUT_DB=pglite    PGlite (Postgres in WebAssembly), data in RESTORFFCUT_DATA_DIR
 *                            (default <apps/web>/.data/pglite, git-ignored). No server, no Docker.
 *   RESTORFFCUT_DB=postgres  a real Postgres at DATABASE_URL.
 *   unset                    postgres when NODE_ENV=production and DATABASE_URL is set, else pglite.
 *                            (Dev's .env.local copies a placeholder DATABASE_URL with nothing
 *                            listening, so dev defaults to PGlite.)
 *
 * PGlite is single-process: only one server may open a data dir at a time. A
 * lock file (<data dir>.lock, holding the pid) turns a second opener into a
 * clear error instead of a corrupted store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { STORE_MIGRATIONS } from "./store-migrations";
import { storeSchema } from "./store-schema";

export type StoreDb = PgDatabase<PgQueryResultHKT, typeof storeSchema>;

export interface StoreInfo {
	driver: "pglite" | "postgres";
	location: string;
}

interface StoreHandle {
	db: StoreDb;
	info: StoreInfo;
	/** Highest migration id applied by this process. */
	migrated?: number;
	migrating?: Promise<void>;
}

const latestMigration = () => Math.max(0, ...STORE_MIGRATIONS.map((m) => m.id));

const GLOBAL_KEY = "__restorffcutProjectStore";
type GlobalWithStore = typeof globalThis & {
	[GLOBAL_KEY]?: Promise<StoreHandle>;
};

export function resolveStoreDriver(): StoreInfo["driver"] {
	const explicit = process.env.RESTORFFCUT_DB?.trim().toLowerCase();
	if (explicit === "pglite" || explicit === "postgres") return explicit;
	if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
		return "postgres";
	}
	return "pglite";
}

export function resolveDataDir(): string {
	const configured = process.env.RESTORFFCUT_DATA_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), ".data", "pglite");
}

/** Where uploaded media files live (content-addressed by sha256). */
export function resolveMediaDir(): string {
	const configured = process.env.RESTORFFCUT_MEDIA_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), ".data", "media");
}

/**
 * The store for this process (opened and migrated on first use). New migrations
 * added while a dev server runs are applied on the next call (HMR reloads the
 * migration list; the open handle survives on globalThis).
 */
export async function getStore(): Promise<StoreHandle> {
	const g = globalThis as GlobalWithStore;
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = openStore().catch((error) => {
			delete g[GLOBAL_KEY];
			throw error;
		});
	}
	const handle = await g[GLOBAL_KEY];
	const latest = latestMigration();
	if ((handle.migrated ?? 0) < latest) {
		handle.migrating ??= runMigrations(handle.db).then(() => {
			handle.migrated = latest;
			handle.migrating = undefined;
		});
		await handle.migrating;
	}
	return handle;
}

export async function getDb(): Promise<StoreDb> {
	return (await getStore()).db;
}

async function openStore(): Promise<StoreHandle> {
	const driver = resolveStoreDriver();
	const handle =
		driver === "postgres" ? await openPostgres() : await openPglite();
	await runMigrations(handle.db);
	handle.migrated = latestMigration();
	return handle;
}

async function openPglite(): Promise<StoreHandle> {
	const dataDir = resolveDataDir();
	mkdirSync(path.dirname(dataDir), { recursive: true });
	takeLock(dataDir);
	const { PGlite } = await import("@electric-sql/pglite");
	const { drizzle } = await import("drizzle-orm/pglite");
	const client = new PGlite(dataDir);
	await client.waitReady;
	const db = drizzle(client, { schema: storeSchema }) as unknown as StoreDb;
	return { db, info: { driver: "pglite", location: dataDir } };
}

async function openPostgres(): Promise<StoreHandle> {
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error(
			"RESTORFFCUT_DB=postgres needs DATABASE_URL (postgres://user:pass@host:5432/db)",
		);
	}
	const { default: postgres } = await import("postgres");
	const { drizzle } = await import("drizzle-orm/postgres-js");
	const client = postgres(url, { max: 5 });
	const db = drizzle(client, { schema: storeSchema }) as unknown as StoreDb;
	const host = url.replace(/\/\/[^@]*@/, "//***@");
	return { db, info: { driver: "postgres", location: host } };
}

function takeLock(dataDir: string): void {
	const lockPath = `${dataDir}.lock`;
	if (existsSync(lockPath)) {
		const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
		if (Number.isFinite(pid) && pid !== process.pid && isAlive(pid)) {
			throw new Error(
				`The PGlite store at ${dataDir} is open in another process (pid ${pid}). ` +
					"Only one server may use it: stop that one, or set RESTORFFCUT_DATA_DIR to another folder.",
			);
		}
	}
	writeFileSync(lockPath, String(process.pid));
}

function isAlive(pid: number): boolean {
	try {
		// Signal 0 only checks that the process exists; it sends nothing.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function runMigrations(db: StoreDb): Promise<void> {
	await db.execute(
		sql.raw(`CREATE TABLE IF NOT EXISTS rc_store_migrations (
			id integer PRIMARY KEY,
			name text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`),
	);
	const applied = await db.execute(sql.raw("SELECT id FROM rc_store_migrations"));
	const done = new Set(
		(rowsOf(applied) as Array<{ id: number }>).map((row) => Number(row.id)),
	);
	for (const migration of STORE_MIGRATIONS) {
		if (done.has(migration.id)) continue;
		await db.transaction(async (tx) => {
			for (const statement of migration.statements) {
				await tx.execute(sql.raw(statement));
			}
			await tx.execute(
				sql`INSERT INTO rc_store_migrations (id, name) VALUES (${migration.id}, ${migration.name})`,
			);
		});
	}
}

/** PGlite returns {rows}, postgres-js returns the rows array itself. */
export function rowsOf(result: unknown): unknown[] {
	if (Array.isArray(result)) return result;
	const rows = (result as { rows?: unknown[] } | null)?.rows;
	return Array.isArray(rows) ? rows : [];
}

export async function getStoreInfo(): Promise<StoreInfo> {
	return (await getStore()).info;
}
