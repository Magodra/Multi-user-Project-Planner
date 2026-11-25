/**
 * Initial schema. Never modify this file once it has been run — add a new
 * migration instead (`npm run migrate:make <name>`).
 */
import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { AnyDb, SqlDialectName } from "../db.js";

export function migration(dialect: SqlDialectName): Migration {
  // MariaDB was added after this migration had run elsewhere; its branches change
  // nothing for the other dialects.
  const jsonType =
    dialect === "mssql" ? sql`nvarchar(max)` : dialect === "mariadb" ? sql`longtext` : sql`text`;
  const floatType =
    dialect === "mssql"
      ? sql`float`
      : dialect === "postgres"
        ? sql`double precision`
        : dialect === "mariadb"
          ? sql`double`
          : sql`real`;
  const str = "varchar(255)" as const;
  const id = "varchar(64)" as const;
  // MariaDB: binary, no-pad collation, so equality and ids compare exactly as in the
  // other backends (the default collations ignore case and trailing spaces).
  const tableOptions =
    dialect === "mariadb"
      ? sql`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_nopad_bin`
      : null;

  async function entityTable(db: Kysely<AnyDb>, table: string, columns: string[]): Promise<void> {
    let builder = db.schema
      .createTable(table)
      .addColumn("id", id, (c) => c.primaryKey())
      .addColumn("version", "integer", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .addColumn("data", jsonType, (c) => c.notNull());
    for (const column of columns) builder = builder.addColumn(column, str);
    if (tableOptions) builder = builder.modifyEnd(tableOptions);
    await builder.execute();
    for (const column of columns) {
      await db.schema.createIndex(`ix_${table}_${column}`).on(table).column(column).execute();
    }
  }

  return {
    async up(db) {
      await entityTable(db, "project", []);
      await entityTable(db, "plan", ["project_id"]);
      await entityTable(db, "plan_item", ["project_id", "plan_id", "parent_id"]);
      await entityTable(db, "plan_item_reference", ["project_id", "plan_id", "item_id"]);
      await entityTable(db, "plan_link", [
        "project_id",
        "from_plan_id",
        "to_plan_id",
        "reference_id",
      ]);
      await entityTable(db, "dependency", ["project_id", "from_item_id", "to_item_id"]);
      await entityTable(db, "baseline", ["project_id", "plan_id", "kind", "track"]);
      await entityTable(db, "baseline_definition", ["project_id", "track"]);
      await entityTable(db, "change_request", ["project_id", "plan_id", "status"]);
      await entityTable(db, "approval", ["project_id", "change_request_id", "plan_id", "status"]);
      await entityTable(db, "timeline", ["project_id"]);
      await entityTable(db, "workspace", ["project_id", "user_id"]);
      await entityTable(db, "report_definition", ["project_id"]);
      await entityTable(db, "app_user", ["username"]);
      await entityTable(db, "party", []);
      await entityTable(db, "role_assignment", ["project_id", "user_id", "plan_id"]);
      await entityTable(db, "audit_log", ["project_id", "entity_id"]);

      await db.schema
        .createTable("baseline_item")
        .addColumn("baseline_id", id, (c) =>
          c.notNull().references("baseline.id").onDelete("cascade"),
        )
        .addColumn("item_id", id, (c) => c.notNull())
        .addColumn("position", "integer", (c) => c.notNull())
        .addColumn("name", str, (c) => c.notNull())
        .addColumn("parent_id", id)
        .addColumn("start_at", "varchar(32)", (c) => c.notNull())
        .addColumn("end_at", "varchar(32)", (c) => c.notNull())
        .addColumn("duration", floatType, (c) => c.notNull())
        .addColumn("granularity", "varchar(16)", (c) => c.notNull())
        .addColumn("is_reference", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint("pk_baseline_item", ["baseline_id", "item_id"])
        .$call((b) => (tableOptions ? b.modifyEnd(tableOptions) : b))
        .execute();

      await db.schema
        .createTable("timeline_entry")
        .addColumn("timeline_id", id, (c) =>
          c.notNull().references("timeline.id").onDelete("cascade"),
        )
        .addColumn("entry_id", id, (c) => c.notNull())
        .addColumn("position", "integer", (c) => c.notNull())
        .addColumn("row_id", id, (c) => c.notNull())
        .addColumn("item_id", id, (c) => c.notNull())
        .addColumn("plan_id", id, (c) => c.notNull())
        .addPrimaryKeyConstraint("pk_timeline_entry", ["timeline_id", "entry_id"])
        .$call((b) => (tableOptions ? b.modifyEnd(tableOptions) : b))
        .execute();
    },
  };
}
