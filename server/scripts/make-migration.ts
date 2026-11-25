/** `npm run migrate:make <name>`: create a numbered migration and register it. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2]?.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
if (!name) {
  console.error("Usage: npm run migrate:make <name>");
  process.exit(1);
}
const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/storage/sql/migrations",
);
const numbers = readdirSync(dir)
  .map((f) => /^(\d{4})_/.exec(f)?.[1])
  .filter((n): n is string => Boolean(n))
  .map(Number);
const next = String(Math.max(0, ...numbers) + 1).padStart(4, "0");
const id = `${next}_${name}`;

writeFileSync(
  path.join(dir, `${id}.ts`),
  `/** ${name}. Never modify this file once it has been run. */
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { AnyDb, SqlDialectName } from "../db.js";

export function migration(_dialect: SqlDialectName): Migration {
  return {
    async up(_db: Kysely<AnyDb>) {
      // TODO: schema changes. On MariaDB, a new table needs
      // .modifyEnd(sql\`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_nopad_bin\`)
      // (see 0001_initial).
    },
  };
}
`,
);

const indexFile = path.join(dir, "index.ts");
let index = readFileSync(indexFile, "utf8");
index = index.replace(
  /(import \{ migration as m\d{4} \} from "\.\/[^"]+";\n)(?![\s\S]*import \{ migration as m)/,
  `$1import { migration as m${next} } from "./${id}.js";\n`,
);
index = index.replace(/(\n {2}\};\n\}\n?)$/, `\n    "${id}": m${next}(dialect),$1`);
writeFileSync(indexFile, index);
console.log(
  `Created ${id}.ts — remember to update tables.ts, both adapters and CLAUDE.md if the data model changes.`,
);
