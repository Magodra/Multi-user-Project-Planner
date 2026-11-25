/**
 * SQL backend on Kysely (PostgreSQL, SQLite, SQL Server, MariaDB). All queries are
 * built with Kysely and therefore parameterised.
 */
import type { Kysely } from "kysely";
import type { Versioned } from "@planning/shared";
import { ConflictError } from "../../domain/errors.js";
import {
  type EntityMap,
  type EntityType,
  type Filter,
  type StorageAdapter,
  nextVersion,
  sortById,
  validateFilter,
} from "../StorageAdapter.js";
import type { AnyDb, SqlDialectName } from "./db.js";
import { type ChildSpec, type ColumnSpec, TABLES } from "./tables.js";
import { migrateToLatest } from "./migrate.js";

/** SQL Server allows at most 2100 parameters per statement. */
const PARAM_CHUNK = 100;

type Row = Record<string, unknown>;

export class SqlAdapter implements StorageAdapter {
  private constructor(
    private readonly db: Kysely<AnyDb>,
    private readonly inTransaction: boolean,
  ) {}

  static async open(db: Kysely<AnyDb>, dialect: SqlDialectName): Promise<SqlAdapter> {
    await migrateToLatest(db, dialect);
    return new SqlAdapter(db, false);
  }

  async get<K extends EntityType>(type: K, id: string): Promise<EntityMap[K] | null> {
    const { table } = TABLES[type];
    const row = (await this.db
      .selectFrom(table)
      .select(["id", "version", "data"])
      .where("id", "=", id)
      .executeTakeFirst()) as Row | undefined;
    if (!row) return null;
    const [entity] = await this.hydrate(type, [row]);
    return entity ?? null;
  }

  async query<K extends EntityType>(type: K, filter: Filter = {}): Promise<EntityMap[K][]> {
    validateFilter(type, filter);
    const spec = TABLES[type];
    let q = this.db.selectFrom(spec.table).select(["id", "version", "data"]);
    for (const [field, value] of Object.entries(filter)) {
      const column = spec.columns.find((c) => c.field === field)!.column;
      q = value === null ? q.where(column, "is", null) : q.where(column, "=", value);
    }
    const rows = (await q.orderBy("id").execute()) as Row[];
    return sortById(await this.hydrate(type, rows));
  }

  save<K extends EntityType>(type: K, entity: EntityMap[K]): Promise<EntityMap[K]> {
    return this.transaction((tx) => (tx as SqlAdapter).saveInTx(type, entity));
  }

  delete(type: EntityType, id: string, version: number): Promise<void> {
    return this.transaction(async (tx) => {
      if (type === "auditLog") throw new ConflictError("Audit log is append-only");
      const spec = TABLES[type];
      const db = (tx as SqlAdapter).db;
      if (spec.child)
        await db.deleteFrom(spec.child.table).where(spec.child.parentColumn, "=", id).execute();
      const result = await db
        .deleteFrom(spec.table)
        .where("id", "=", id)
        .where("version", "=", version)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) !== 1) {
        throw new ConflictError(`${type} ${id}: version ${version} not found`);
      }
    });
  }

  async transaction<R>(fn: (tx: StorageAdapter) => Promise<R>): Promise<R> {
    if (this.inTransaction) return fn(this);
    return this.db.transaction().execute((trx) => fn(new SqlAdapter(trx, true)));
  }

  async close(): Promise<void> {
    if (!this.inTransaction) await this.db.destroy();
  }

  private async saveInTx<K extends EntityType>(
    type: K,
    entity: EntityMap[K],
  ): Promise<EntityMap[K]> {
    const spec = TABLES[type];
    const stored = { ...entity, version: nextVersion(entity) } as EntityMap[K];
    const doc: Row = { ...stored };
    if (spec.child) delete doc[spec.child.field];
    const values: Row = {
      id: entity.id,
      version: stored.version,
      created_at: entity.createdAt,
      updated_at: entity.updatedAt,
      data: JSON.stringify(doc),
    };
    for (const c of spec.columns) values[c.column] = toColumn(c, doc[c.field]);

    const exists = await this.db
      .selectFrom(spec.table)
      .select("id")
      .where("id", "=", entity.id)
      .executeTakeFirst();
    if (entity.version === 0) {
      if (exists) throw new ConflictError(`${type} ${entity.id} already exists`);
      await this.db.insertInto(spec.table).values(values).execute();
    } else {
      if (type === "auditLog") throw new ConflictError("Audit log is append-only");
      const result = await this.db
        .updateTable(spec.table)
        .set(values)
        .where("id", "=", entity.id)
        .where("version", "=", entity.version)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new ConflictError(`${type} ${entity.id}: version ${entity.version} is not current`);
      }
    }
    if (spec.child)
      await this.writeChildren(spec.child, entity.id, (stored as unknown as Row)[spec.child.field]);
    return stored;
  }

  private async writeChildren(child: ChildSpec, parentId: string, value: unknown): Promise<void> {
    await this.db.deleteFrom(child.table).where(child.parentColumn, "=", parentId).execute();
    const items = Array.isArray(value) ? (value as Row[]) : [];
    const rows = items.map((item, position) => {
      const row: Row = { [child.parentColumn]: parentId, position };
      for (const c of child.columns) row[c.column] = toColumn(c, item[c.field]);
      return row;
    });
    const perStatement = Math.max(1, Math.floor(1000 / (child.columns.length + 2)));
    for (let i = 0; i < rows.length; i += perStatement) {
      await this.db
        .insertInto(child.table)
        .values(rows.slice(i, i + perStatement))
        .execute();
    }
  }

  private async hydrate<K extends EntityType>(type: K, rows: Row[]): Promise<EntityMap[K][]> {
    const spec = TABLES[type];
    const entities = rows.map((row) => {
      const doc = JSON.parse(String(row.data)) as Row;
      doc.version = Number(row.version);
      return doc;
    });
    const child = spec.child;
    if (child && entities.length > 0) {
      const byParent = new Map<string, Row[]>();
      const ids = entities.map((e) => String(e.id));
      for (let i = 0; i < ids.length; i += PARAM_CHUNK) {
        const childRows = (await this.db
          .selectFrom(child.table)
          .selectAll()
          .where(child.parentColumn, "in", ids.slice(i, i + PARAM_CHUNK))
          .orderBy(child.parentColumn)
          .orderBy("position")
          .execute()) as Row[];
        for (const r of childRows) {
          const item: Row = {};
          for (const c of child.columns) item[c.field] = fromColumn(c, r[c.column]);
          const key = String(r[child.parentColumn]);
          byParent.set(key, [...(byParent.get(key) ?? []), item]);
        }
      }
      for (const e of entities) e[child.field] = byParent.get(String(e.id)) ?? [];
    }
    return entities as unknown as (EntityMap[K] & Versioned)[];
  }
}

function toColumn(spec: ColumnSpec, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (spec.kind === "boolean") return value ? 1 : 0;
  if (spec.kind === "number") return Number(value);
  return String(value);
}

function fromColumn(spec: ColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (spec.kind === "boolean") return Number(value) === 1 || value === true;
  if (spec.kind === "number") return Number(value);
  return String(value);
}
