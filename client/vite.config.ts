import { connect } from "node:net";
import { defineConfig, defaultClientConditions, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const server = process.env.PLANNING_SERVER_URL ?? "http://localhost:8080";

/** Resolves true once the server accepts TCP connections, false after the timeout. */
async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const { hostname, port, protocol } = new URL(url);
  const target = {
    host: hostname.replace(/^\[|\]$/g, ""),
    port: Number(port) || (protocol === "https:" ? 443 : 80),
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = connect(target);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (up) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Dev only: `npm run dev` starts Vite and the server together, and Vite is ready
 * first; `tsx watch` also restarts the server on every change. Without this, the
 * proxy answers 502 Bad Gateway until the page is reloaded. Requests are held
 * (up to 30 s) until the server is listening, then passed on to the proxy.
 */
function waitForApiServer(): Plugin {
  return {
    name: "planning:wait-for-api-server",
    apply: "serve",
    configureServer(dev) {
      dev.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api") && !url.startsWith("/mcp")) return next();
        void waitForServer(server, 30_000).then(() => next());
      });
    },
  };
}

// One index.html with all JS/CSS inlined, so the same build works hosted and
// from file:// (CLAUDE.md §2 "Client deployment modes"). No code splitting.
export default defineConfig({
  base: "./",
  plugins: [waitForApiServer(), react(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: { conditions: ["source", ...defaultClientConditions] },
  build: {
    target: "es2022",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 10_000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/mcp": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
