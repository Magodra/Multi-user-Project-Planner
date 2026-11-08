/**
 * Timeline callouts get a free position (px offset from the bar). Nullable:
 * bars have none, and older callouts are normalized from their line when read.
 * Never modify this file once it has been run — add a new migration instead.
 */
import type { Migration } from "kysely/migration";
import type { SqlDialectName } from "../db.js";

export function migration(_dialect: SqlDialectName): Migration {
  return {
    async up(db) {
      await db.schema.alterTable("timeline_entry").addColumn("callout_x", "integer").execute();
      await db.schema.alterTable("timeline_entry").addColumn("callout_y", "integer").execute();
    },
    async down(db) {
      await db.schema.alterTable("timeline_entry").dropColumn("callout_y").execute();
      await db.schema.alterTable("timeline_entry").dropColumn("callout_x").execute();
    },
  };
}
