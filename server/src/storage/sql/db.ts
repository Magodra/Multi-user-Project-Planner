import { Kysely, MssqlDialect, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import type { Dialect } from "kysely";
import Database from "better-sqlite3";
import { createPool, type PoolOptions } from "mysql2";
import pg from "pg";
import * as tarn from "tarn";
import * as tedious from "tedious";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SqlDialectName = "postgres" | "sqlite" | "mssql" | "mariadb";

/** Tables are addressed dynamically (see tables.ts), so the schema type is open. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = any;

export interface SqlConnectionConfig {
  dialect: SqlDialectName;
  connectionString: string;
}

export function createKysely(config: SqlConnectionConfig): Kysely<AnyDb> {
  return new Kysely<AnyDb>({ dialect: createDialect(config) });
}

function createDialect({ dialect, connectionString }: SqlConnectionConfig): Dialect {
  switch (dialect) {
    case "sqlite": {
      const file = sqlitePath(connectionString);
      if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const database = new Database(file);
      database.pragma("journal_mode = WAL");
      database.pragma("foreign_keys = ON");
      return new SqliteDialect({ database });
    }
    case "postgres":
      return new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) });
    case "mssql": {
      const options = parseMssqlUrl(connectionString);
      return new MssqlDialect({
        tarn: { ...tarn, options: { min: 0, max: 10 } },
        tedious: {
          ...tedious,
          connectionFactory: () => new tedious.Connection(options),
        },
      });
    }
    case "mariadb":
      return new MysqlDialect({ pool: createPool(parseMariadbUrl(connectionString)) });
  }
}

/** Accepts "sqlite:./data/planning.db", "file:./x.db", a plain path or ":memory:". */
export function sqlitePath(connectionString: string): string {
  return connectionString.replace(/^(sqlite|file):(\/\/)?/, "") || ":memory:";
}

/**
 * Parse "mssql://user:pass@host:1433/database?encrypt=true&trustServerCertificate=true".
 */
export function parseMssqlUrl(connectionString: string): tedious.ConnectionConfiguration {
  const url = new URL(connectionString);
  if (url.protocol !== "mssql:" && url.protocol !== "sqlserver:") {
    throw new Error("SQL Server connection string must be a mssql:// URL");
  }
  const flag = (name: string, fallback: boolean) => {
    const v = url.searchParams.get(name);
    return v === null ? fallback : v === "true";
  };
  return {
    server: url.hostname,
    authentication: {
      type: "default",
      options: {
        userName: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      },
    },
    options: {
      port: url.port ? Number(url.port) : 1433,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
      encrypt: flag("encrypt", true),
      trustServerCertificate: flag("trustServerCertificate", false),
    },
  };
}

/**
 * Parse "mariadb://user:pass@host:3306/database?ssl=true&sslRejectUnauthorized=true"
 * (mysql:// is accepted too). TLS is off unless ssl=true.
 */
export function parseMariadbUrl(connectionString: string): PoolOptions {
  const url = new URL(connectionString);
  if (url.protocol !== "mariadb:" && url.protocol !== "mysql:") {
    throw new Error("MariaDB connection string must be a mariadb:// URL");
  }
  const flag = (name: string, fallback: boolean) => {
    const v = url.searchParams.get(name);
    return v === null ? fallback : v === "true";
  };
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    ssl: flag("ssl", false)
      ? { rejectUnauthorized: flag("sslRejectUnauthorized", true) }
      : undefined,
    // Tables use a binary collation (see migrations); the connection only needs utf8mb4.
    charset: "utf8mb4",
    connectionLimit: 10,
  };
}
