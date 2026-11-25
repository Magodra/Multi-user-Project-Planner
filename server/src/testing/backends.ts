/**
 * Storage backends for parameterised tests. File and SQLite run in-process;
 * PostgreSQL, SQL Server and MariaDB use Testcontainers (requires Docker) and are
 * skipped when SKIP_CONTAINER_TESTS=1.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import { FileAdapter } from "../storage/file/FileAdapter.js";
import { SqlAdapter } from "../storage/sql/SqlAdapter.js";
import { createKysely } from "../storage/sql/db.js";

export interface TestBackend {
  name: string;
  /** Containers are started lazily on first use and reused within a test file. */
  create(): Promise<{ storage: StorageAdapter; cleanup: () => Promise<void> }>;
  /** Stop shared resources (containers). */
  teardown(): Promise<void>;
  /** True when every `create()` returns an empty store. */
  isolated: boolean;
}

const skipContainers = process.env.SKIP_CONTAINER_TESTS === "1";

export const fileBackend: TestBackend = {
  name: "file",
  isolated: true,
  async create() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "planning-file-"));
    const storage = new FileAdapter(dir);
    return { storage, cleanup: () => rm(dir, { recursive: true, force: true }) };
  },
  async teardown() {},
};

export const sqliteBackend: TestBackend = {
  name: "sqlite",
  isolated: true,
  async create() {
    const storage = await SqlAdapter.open(
      createKysely({ dialect: "sqlite", connectionString: ":memory:" }),
      "sqlite",
    );
    return { storage, cleanup: () => storage.close() };
  },
  async teardown() {},
};

function containerBackend(
  name: "postgres" | "mssql" | "mariadb",
  start: () => Promise<{ url: string; stop: () => Promise<unknown> }>,
): TestBackend {
  let started: Promise<{ url: string; stop: () => Promise<unknown> }> | null = null;
  return {
    name,
    isolated: false,
    async create() {
      started ??= start();
      const { url } = await started;
      const storage = await SqlAdapter.open(
        createKysely({ dialect: name, connectionString: url }),
        name,
      );
      return { storage, cleanup: () => storage.close() };
    },
    async teardown() {
      if (started) await (await started).stop();
    },
  };
}

export const postgresBackend = containerBackend("postgres", async () => {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const c = await new PostgreSqlContainer("postgres:17-alpine").start();
  return { url: c.getConnectionUri(), stop: () => c.stop() };
});

export const mssqlBackend = containerBackend("mssql", async () => {
  const { MSSQLServerContainer } = await import("@testcontainers/mssqlserver");
  const c = await new MSSQLServerContainer("mcr.microsoft.com/mssql/server:2022-latest")
    .acceptLicense()
    .start();
  const url = `mssql://${encodeURIComponent(c.getUsername())}:${encodeURIComponent(c.getPassword())}@${c.getHost()}:${c.getPort()}/${c.getDatabase()}?encrypt=true&trustServerCertificate=true`;
  return { url, stop: () => c.stop() };
});

export const mariadbBackend = containerBackend("mariadb", async () => {
  const { MariaDbContainer } = await import("@testcontainers/mariadb");
  const c = await new MariaDbContainer("mariadb:11.4").start();
  const url = `mariadb://${encodeURIComponent(c.getUsername())}:${encodeURIComponent(c.getUserPassword())}@${c.getHost()}:${c.getPort()}/${c.getDatabase()}`;
  return { url, stop: () => c.stop() };
});

/** All backends for the StorageAdapter contract suite. */
export const allBackends: TestBackend[] = [
  fileBackend,
  sqliteBackend,
  ...(skipContainers ? [] : [postgresBackend, mssqlBackend, mariadbBackend]),
];

/** The two backend families every storage-touching feature is tested against. */
export const serviceBackends: TestBackend[] = [fileBackend, sqliteBackend];
