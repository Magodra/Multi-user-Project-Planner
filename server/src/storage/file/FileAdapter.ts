/**
 * JSON-file backend (CLAUDE.md §9 "FileAdapter").
 *
 * Layout:
 *   data/projects/<projectId>/project.json, plans/, items/, references/,
 *     baselines/, baselineDefinitions/, changeRequests/, approvals/,
 *     timelines/, reports/, workspaces/, links.json, dependencies.json,
 *     roles.json, audit/<yyyy-mm>.jsonl
 *   data/users/, data/parties/, data/audit/<yyyy-mm>.jsonl
 *
 * Every write goes through a transaction: changes are buffered, then written
 * to temp files and renamed into place while holding the data-directory lock.
 */
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AuditLogEntry, Versioned } from "@planning/shared";
import { ConflictError, ValidationError } from "../../domain/errors.js";
import {
  type EntityMap,
  type EntityType,
  type Filter,
  type StorageAdapter,
  matchesFilter,
  nextVersion,
  sortById,
  validateFilter,
} from "../StorageAdapter.js";
import { AsyncMutex, retryWhileBusy, withLockFile } from "./locks.js";

type Layout =
  | { scope: "self" }
  | { scope: "project" | "global"; mode: "dir"; dir: string }
  | { scope: "project"; mode: "collection"; file: string }
  | { scope: "append"; dir: string };

const LAYOUT: Record<EntityType, Layout> = {
  project: { scope: "self" },
  plan: { scope: "project", mode: "dir", dir: "plans" },
  task: { scope: "project", mode: "dir", dir: "items" },
  planItemReference: { scope: "project", mode: "dir", dir: "references" },
  planLink: { scope: "project", mode: "collection", file: "links.json" },
  dependency: { scope: "project", mode: "collection", file: "dependencies.json" },
  baseline: { scope: "project", mode: "dir", dir: "baselines" },
  baselineDefinition: { scope: "project", mode: "dir", dir: "baselineDefinitions" },
  changeRequest: { scope: "project", mode: "dir", dir: "changeRequests" },
  approval: { scope: "project", mode: "dir", dir: "approvals" },
  timeline: { scope: "project", mode: "dir", dir: "timelines" },
  reportDefinition: { scope: "project", mode: "dir", dir: "reports" },
  workspace: { scope: "project", mode: "dir", dir: "workspaces" },
  roleAssignment: { scope: "project", mode: "collection", file: "roles.json" },
  user: { scope: "global", mode: "dir", dir: "users" },
  party: { scope: "global", mode: "dir", dir: "parties" },
  oauthClient: { scope: "global", mode: "dir", dir: "oauth-clients" },
  auditLog: { scope: "append", dir: "audit" },
};

type Collection = Record<string, Versioned>;

/** Pending writes of one transaction. `null` content means delete. */
class TxBuffer {
  readonly files = new Map<string, string | null>();
  readonly appends = new Map<string, string[]>();

  write(file: string, content: string | null): void {
    this.files.set(file, content);
  }

  append(file: string, line: string): void {
    const lines = this.appends.get(file) ?? [];
    lines.push(line);
    this.appends.set(file, lines);
  }
}

interface Shared {
  root: string;
  mutex: AsyncMutex;
}

export class FileAdapter implements StorageAdapter {
  private readonly shared: Shared;
  private readonly tx: TxBuffer | null;

  constructor(root: string);
  constructor(root: Shared, tx: TxBuffer);
  constructor(root: string | Shared, tx?: TxBuffer) {
    this.shared =
      typeof root === "string" ? { root: path.resolve(root), mutex: new AsyncMutex() } : root;
    this.tx = tx ?? null;
  }

  private get root(): string {
    return this.shared.root;
  }

  async get<K extends EntityType>(type: K, id: string): Promise<EntityMap[K] | null> {
    assertSafeId(id);
    const all = await this.loadAll(type, null, id);
    return (all.find((e) => e.id === id) as EntityMap[K] | undefined) ?? null;
  }

  async query<K extends EntityType>(type: K, filter: Filter = {}): Promise<EntityMap[K][]> {
    validateFilter(type, filter);
    const projectId = typeof filter.projectId === "string" ? filter.projectId : null;
    const all = await this.loadAll(type, projectId, null);
    return sortById(all.filter((e) => matchesFilter(e, filter))) as EntityMap[K][];
  }

  save<K extends EntityType>(type: K, entity: EntityMap[K]): Promise<EntityMap[K]> {
    return this.transaction((tx) => (tx as FileAdapter).saveInTx(type, entity));
  }

  delete(type: EntityType, id: string, version: number): Promise<void> {
    return this.transaction((tx) => (tx as FileAdapter).deleteInTx(type, id, version));
  }

  async transaction<R>(fn: (tx: StorageAdapter) => Promise<R>): Promise<R> {
    if (this.tx) return fn(this);
    return this.shared.mutex.run(async () => {
      await mkdir(this.root, { recursive: true });
      return withLockFile(path.join(this.root, ".lock"), async () => {
        const buffer = new TxBuffer();
        const result = await fn(new FileAdapter(this.shared, buffer));
        await this.commit(buffer);
        return result;
      });
    });
  }

  async close(): Promise<void> {}

  // --- writes (always inside a transaction) -------------------------------

  private async saveInTx<K extends EntityType>(
    type: K,
    entity: EntityMap[K],
  ): Promise<EntityMap[K]> {
    assertSafeId(entity.id);
    const layout = LAYOUT[type];
    const existing = await this.get(type, entity.id);
    if (layout.scope === "append") {
      if (entity.version !== 0 || existing) throw new ConflictError("Audit log is append-only");
    } else if (entity.version === 0 && existing) {
      throw new ConflictError(`${type} ${entity.id} already exists`);
    } else if (entity.version !== 0 && existing?.version !== entity.version) {
      throw new ConflictError(
        `${type} ${entity.id}: expected version ${existing?.version ?? "none"}, got ${entity.version}`,
      );
    }
    const stored = { ...entity, version: nextVersion(entity) } as EntityMap[K];
    const tx = this.tx!;
    switch (layout.scope) {
      case "self":
        tx.write(path.join(this.projectDir(entity.id), "project.json"), json(stored));
        break;
      case "global":
        tx.write(path.join(this.root, layout.dir, `${entity.id}.json`), json(stored));
        break;
      case "project": {
        const dir = this.projectDir(requireProjectId(type, entity));
        if (layout.mode === "dir") {
          tx.write(path.join(dir, layout.dir, `${entity.id}.json`), json(stored));
        } else {
          const file = path.join(dir, layout.file);
          const collection = await this.readCollection(file);
          collection[entity.id] = stored;
          tx.write(file, json(collection));
        }
        break;
      }
      case "append": {
        const entry = stored as AuditLogEntry;
        const base = entry.projectId ? this.projectDir(entry.projectId) : this.root;
        const month = entry.createdAt.slice(0, 7);
        tx.append(path.join(base, layout.dir, `${month}.jsonl`), JSON.stringify(entry));
        break;
      }
    }
    return stored;
  }

  private async deleteInTx(type: EntityType, id: string, version: number): Promise<void> {
    const layout = LAYOUT[type];
    if (layout.scope === "append") throw new ConflictError("Audit log is append-only");
    const existing = await this.get(type, id);
    if (!existing) throw new ConflictError(`${type} ${id} does not exist`);
    if (existing.version !== version) {
      throw new ConflictError(
        `${type} ${id}: expected version ${existing.version}, got ${version}`,
      );
    }
    const tx = this.tx!;
    switch (layout.scope) {
      case "self":
        tx.write(path.join(this.projectDir(id), "project.json"), null);
        break;
      case "global":
        tx.write(path.join(this.root, layout.dir, `${id}.json`), null);
        break;
      case "project": {
        const dir = this.projectDir(requireProjectId(type, existing));
        if (layout.mode === "dir") {
          tx.write(path.join(dir, layout.dir, `${id}.json`), null);
        } else {
          const file = path.join(dir, layout.file);
          const collection = await this.readCollection(file);
          delete collection[id];
          tx.write(file, json(collection));
        }
        break;
      }
    }
  }

  private async commit(buffer: TxBuffer): Promise<void> {
    // Stage all files first so a failure leaves the store untouched.
    const staged: [tmp: string, target: string][] = [];
    try {
      for (const [file, content] of buffer.files) {
        if (content === null) continue;
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        await writeFile(tmp, content, "utf8");
        staged.push([tmp, file]);
      }
    } catch (err) {
      await Promise.all(staged.map(([tmp]) => rm(tmp, { force: true })));
      throw err;
    }
    for (const [tmp, target] of staged)
      await retryWhileBusy(() => rename(tmp, target), BUSY_WAIT_MS);
    for (const [file, content] of buffer.files) {
      if (content === null) await retryWhileBusy(() => rm(file, { force: true }), BUSY_WAIT_MS);
    }
    for (const [file, lines] of buffer.appends) {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, lines.map((l) => `${l}\n`).join(""), "utf8");
    }
  }

  // --- reads (see pending writes of the current transaction) -------------

  private projectDir(projectId: string): string {
    assertSafeId(projectId);
    return path.join(this.root, "projects", projectId);
  }

  private async readText(file: string): Promise<string | null> {
    if (this.tx?.files.has(file)) return this.tx.files.get(file) ?? null;
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async readCollection(file: string): Promise<Collection> {
    const text = await this.readText(file);
    return text ? (JSON.parse(text) as Collection) : {};
  }

  private async listJsonFiles(dir: string): Promise<string[]> {
    const names = new Set<string>();
    try {
      for (const name of await readdir(dir))
        if (name.endsWith(".json")) names.add(path.join(dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const [file, content] of this.tx?.files ?? []) {
      if (path.dirname(file) !== dir) continue;
      if (content === null) names.delete(file);
      else names.add(file);
    }
    return [...names];
  }

  private async listProjectIds(): Promise<string[]> {
    const ids = new Set<string>();
    try {
      for (const entry of await readdir(path.join(this.root, "projects"), {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) ids.add(entry.name);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const projectsDir = path.join(this.root, "projects");
    for (const file of this.tx?.files.keys() ?? []) {
      const rel = path.relative(projectsDir, file);
      if (!rel.startsWith("..")) ids.add(rel.split(path.sep)[0]!);
    }
    return [...ids].sort();
  }

  private async readJsonFiles(files: string[]): Promise<Versioned[]> {
    const out: Versioned[] = [];
    for (const file of files) {
      const text = await this.readText(file);
      if (text) out.push(JSON.parse(text) as Versioned);
    }
    return out;
  }

  /**
   * Load all entities of a type, optionally limited to one project.
   * `idHint` lets `get` stop early for one-file-per-entity layouts.
   */
  private async loadAll(
    type: EntityType,
    projectId: string | null,
    idHint: string | null,
  ): Promise<Versioned[]> {
    const layout = LAYOUT[type];
    switch (layout.scope) {
      case "self": {
        const ids = idHint ? [idHint] : projectId ? [projectId] : await this.listProjectIds();
        return this.readJsonFiles(ids.map((id) => path.join(this.projectDir(id), "project.json")));
      }
      case "global": {
        const dir = path.join(this.root, layout.dir);
        if (idHint) return this.readJsonFiles([path.join(dir, `${idHint}.json`)]);
        return this.readJsonFiles(await this.listJsonFiles(dir));
      }
      case "project": {
        const projectIds = projectId ? [projectId] : await this.listProjectIds();
        const out: Versioned[] = [];
        for (const pid of projectIds) {
          const dir = this.projectDir(pid);
          if (layout.mode === "dir") {
            const files = idHint
              ? [path.join(dir, layout.dir, `${idHint}.json`)]
              : await this.listJsonFiles(path.join(dir, layout.dir));
            out.push(...(await this.readJsonFiles(files)));
            if (idHint && out.length > 0) break;
          } else {
            out.push(...Object.values(await this.readCollection(path.join(dir, layout.file))));
          }
        }
        return out;
      }
      case "append": {
        const dirs = [path.join(this.root, layout.dir)];
        const projectIds = projectId ? [projectId] : await this.listProjectIds();
        dirs.push(...projectIds.map((pid) => path.join(this.projectDir(pid), layout.dir)));
        const out: Versioned[] = [];
        for (const dir of projectId ? dirs.slice(1) : dirs) {
          let names: string[] = [];
          try {
            names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
          const files = new Set(names.map((n) => path.join(dir, n)));
          for (const file of this.tx?.appends.keys() ?? [])
            if (path.dirname(file) === dir) files.add(file);
          for (const file of files) {
            const text = (await this.readText(file)) ?? "";
            const pending = this.tx?.appends.get(file) ?? [];
            for (const line of [...text.split("\n"), ...pending]) {
              if (line.trim()) out.push(JSON.parse(line) as Versioned);
            }
          }
        }
        return out;
      }
    }
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireProjectId(type: EntityType, entity: object): string {
  const projectId = (entity as { projectId?: unknown }).projectId;
  if (typeof projectId !== "string" || !projectId) {
    throw new ValidationError(`${type} requires a projectId`);
  }
  return projectId;
}

/** Windows (and sync tools like Dropbox) can briefly hold files open. */
const BUSY_WAIT_MS = 5_000;

/** Ids become file names, so they must not contain path syntax. */
function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ValidationError(`Invalid id '${id}'`);
}
