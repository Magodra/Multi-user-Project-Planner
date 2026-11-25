/**
 * Loads `config.json` (path overridable with PLANNING_CONFIG). `${VAR}` in any
 * string value is replaced with the environment variable, so secrets never
 * have to be committed. `//` comments are allowed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { roleSchema } from "@planning/shared";

const configSchema = z
  .object({
    backend: z.enum(["file", "sql"]),
    file: z.object({ path: z.string().min(1) }).default({ path: "./data" }),
    sql: z
      .object({
        dialect: z.enum(["postgres", "sqlite", "mssql", "mariadb"]),
        connectionString: z.string().min(1),
      })
      .default({ dialect: "sqlite", connectionString: "./data/planning.db" }),
    server: z
      .object({
        port: z.number().int().default(8080),
        allowedOrigins: z.array(z.string()).default([]),
        allowFileClient: z.boolean().default(false),
        /** Directory with the built client to serve (hosted mode). */
        clientDir: z.string().optional(),
        /** Behind a reverse proxy (e.g. for HTTPS): trust its X-Forwarded-* headers. */
        trustProxy: z.boolean().default(false),
      })
      .default({ port: 8080, allowedOrigins: [], allowFileClient: false, trustProxy: false }),
    mcp: z
      .object({
        enabled: z.boolean().default(true),
        path: z.string().default("/mcp"),
        /** OAuth 2.1 for MCP clients such as the ChatGPT app (this server is the authorization server). */
        oauth: z
          .object({
            enabled: z.boolean().default(false),
            /** Public base URL of this server, e.g. https://planning.example.com (HTTPS required). */
            issuerUrl: z.string().url().optional(),
            accessTokenMinutes: z.number().int().min(1).default(60),
            refreshTokenDays: z.number().int().min(1).default(30),
          })
          .default({ enabled: false, accessTokenMinutes: 60, refreshTokenDays: 30 }),
      })
      .default({
        enabled: true,
        path: "/mcp",
        oauth: { enabled: false, accessTokenMinutes: 60, refreshTokenDays: 30 },
      }),
    auth: z.object({
      mode: z.enum(["local", "sso", "ldap"]),
      local: z
        .object({
          passwordMinLength: z.number().int().min(1).default(12),
          sessionTimeoutMinutes: z.number().int().min(1).default(480),
        })
        .default({ passwordMinLength: 12, sessionTimeoutMinutes: 480 }),
      sso: z
        .object({
          protocol: z.enum(["oidc", "saml"]),
          issuer: z.string().url(),
          clientId: z.string(),
          clientSecret: z.string(),
          redirectUri: z.string().url(),
          groupClaim: z.string().default("groups"),
          /** Where the browser is sent after login (the hosted client). */
          postLoginRedirect: z.string().optional(),
        })
        .optional(),
      ldap: z
        .object({
          url: z.string(),
          bindDn: z.string(),
          bindPassword: z.string(),
          userSearchBase: z.string(),
          userFilter: z.string().default("(uid={username})"),
          groupSearchBase: z.string(),
          groupFilter: z.string().default("(member={dn})"),
        })
        .optional(),
      roleMapping: z.record(z.string(), roleSchema).default({}),
    }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.auth.mode === "sso" && !cfg.auth.sso) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "sso"],
        message: "auth.sso is required for mode 'sso'",
      });
    }
    if (cfg.mcp.oauth.enabled && !cfg.mcp.oauth.issuerUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["mcp", "oauth", "issuerUrl"],
        message:
          "mcp.oauth.issuerUrl (the server's public HTTPS URL) is required when OAuth is enabled",
      });
    }
    if (cfg.auth.mode === "ldap" && !cfg.auth.ldap) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "ldap"],
        message: "auth.ldap is required for mode 'ldap'",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(file = process.env.PLANNING_CONFIG ?? "config.json"): AppConfig {
  const resolved = path.resolve(file);
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(
      `Configuration file not found: ${resolved}. Copy config.example.json to config.json or set PLANNING_CONFIG.`,
    );
  }
  const config = parseConfig(text, process.env);
  // Relative data paths are relative to the config file, not the working directory.
  const base = path.dirname(resolved);
  config.file.path = path.resolve(base, config.file.path);
  if (
    config.sql.dialect === "sqlite" &&
    !/^(:memory:|[a-z]+:\/\/)/.test(config.sql.connectionString)
  ) {
    const raw = config.sql.connectionString.replace(/^(sqlite|file):/, "");
    config.sql.connectionString = path.resolve(base, raw);
  }
  if (config.server.clientDir)
    config.server.clientDir = path.resolve(base, config.server.clientDir);
  return config;
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv): AppConfig {
  const raw: unknown = JSON.parse(stripJsonComments(text));
  const substituted = substituteEnv(raw, env);
  const result = configSchema.safeParse(substituted);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function substituteEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = env[name];
      if (v === undefined)
        throw new Error(`Environment variable ${name} is not set (referenced in config)`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env)]));
  }
  return value;
}

/** Remove `//` and `/* *\/` comments outside of strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}
