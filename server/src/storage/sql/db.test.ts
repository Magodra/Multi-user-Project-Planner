import { describe, expect, it } from "vitest";
import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from "kysely";
import type { AnyDb } from "./db.js";
import { parseMariadbUrl } from "./db.js";
import { getMigrations } from "./migrations/index.js";

describe("parseMariadbUrl", () => {
  it("reads host, port, credentials and database", () => {
    expect(parseMariadbUrl("mariadb://planner:p%40ss%3Aword@db.example.com:3307/planning")).toEqual(
      expect.objectContaining({
        host: "db.example.com",
        port: 3307,
        user: "planner",
        password: "p@ss:word",
        database: "planning",
        ssl: undefined,
        charset: "utf8mb4",
      }),
    );
  });

  it("defaults the port to 3306 and accepts mysql://", () => {
    expect(parseMariadbUrl("mysql://u:p@localhost/db").port).toBe(3306);
  });

  it("turns on TLS with ssl=true, verifying the certificate unless told not to", () => {
    expect(parseMariadbUrl("mariadb://u:p@h/db?ssl=true").ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(parseMariadbUrl("mariadb://u:p@h/db?ssl=true&sslRejectUnauthorized=false").ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("rejects other URL schemes", () => {
    expect(() => parseMariadbUrl("postgres://u:p@h/db")).toThrow(/mariadb:\/\//);
  });
});

describe("MariaDB migrations", () => {
  /** Runs every migration against a driver that executes nothing and records the SQL. */
  async function compiledDdl(): Promise<string[]> {
    const statements: string[] = [];
    const db = new Kysely<AnyDb>({
      dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (k) => new MysqlIntrospector(k),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      },
      log: (event) => {
        statements.push(event.query.sql);
      },
    });
    for (const migration of Object.values(getMigrations("mariadb"))) await migration.up(db);
    await db.destroy();
    return statements;
  }

  it("creates every table with a binary, no-pad collation", async () => {
    const creates = (await compiledDdl()).filter((s) => s.startsWith("create table"));
    expect(creates.length).toBeGreaterThan(0);
    for (const statement of creates) {
      expect(statement).toMatch(/collate=utf8mb4_nopad_bin$/);
    }
  });

  it("stores entity JSON as longtext and durations as double", async () => {
    const ddl = (await compiledDdl()).join("\n");
    expect(ddl).toContain("`data` longtext not null");
    expect(ddl).not.toMatch(/`data` text/);
    expect(ddl).toContain("`duration` double not null");
  });
});
