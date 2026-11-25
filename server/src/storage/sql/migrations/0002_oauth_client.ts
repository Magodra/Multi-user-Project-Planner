/**
 * OAuth clients registered for MCP (dynamic client registration). Never
 * modify this file once it has been run — add a new migration instead.
 */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import type { SqlDialectName } from "../db.js";

export function migration(dialect: SqlDialectName): Migration {
  // MariaDB was added after this migration had run elsewhere; its branches change
  // nothing for the other dialects (see 0001_initial).
  const jsonType =
    dialect === "mssql" ? sql`nvarchar(max)` : dialect === "mariadb" ? sql`longtext` : sql`text`;
  const tableOptions =
    dialect === "mariadb"
      ? sql`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_nopad_bin`
      : null;
  return {
    async up(db) {
      await db.schema
        .createTable("oauth_client")
        .addColumn("id", "varchar(64)", (c) => c.primaryKey())
        .addColumn("version", "integer", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .addColumn("data", jsonType, (c) => c.notNull())
        .$call((b) => (tableOptions ? b.modifyEnd(tableOptions) : b))
        .execute();
    },
    async down(db) {
      await db.schema.dropTable("oauth_client").execute();
    },
  };
}
