// Local stand-in for the Cloudflare Pages Functions that serve /api/* in
// production. `vite dev` and `vite preview` have no Functions runtime, so
// without this every API call is a 404 and the dashboard never loads.
//
// Rather than reimplementing each endpoint, this mounts the very same handler
// modules from ../../functions/api and points them at a libSQL file instead of
// Turso. Validation, statistics SQL and sync semantics are therefore the
// production ones, and a new Function becomes reachable locally as soon as it
// is written, with no route list to keep in step.
//
// Local data only ever changes under frontend/.dev-data, which is gitignored.
// None of this is deployed, and none of it is bundled: vite.config.js imports
// this module in serve mode only.

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeDb, getDb } from "../../lib/db.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const functionsDir = join(repoRoot, "functions", "api");
const schemaPath = join(repoRoot, "db", "schema.sql");
const dataDir = fileURLToPath(new URL("../.dev-data/", import.meta.url));
const databasePath = join(dataDir, "api.db");

// Node sets these itself, and a copied value would disagree with the body.
const SKIPPED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
]);

// The schema script has no statement delimiter other than a trailing semicolon.
function schemaStatements(script) {
  const statements = [];
  let current = "";
  for (const line of script.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    current += `${line}\n`;
    if (!line.trim().endsWith(";")) continue;
    const statement = current.trim().replace(/;$/, "").trim();
    if (statement) statements.push(statement);
    current = "";
  }
  return statements;
}

function alreadyApplied(err) {
  const message = String(err?.message ?? err);
  return message.includes("already exists") || message.includes("UNIQUE constraint failed");
}

async function applySchema(env) {
  const db = getDb(env);
  try {
    for (const statement of schemaStatements(await readFile(schemaPath, "utf8"))) {
      try {
        await db.execute(statement);
      } catch (err) {
        // The dev database survives a restart, so the tables and the seeded
        // team are normally already there.
        if (!alreadyApplied(err)) throw err;
      }
    }
  } finally {
    closeDb(env);
  }
}

// Pages maps the file tree onto routes: games/index.js serves /api/games, and
// games/[id]/events/sync.js serves /api/games/:id/events/sync.
async function collectRoutes(dir, prefix = "/api") {
  const routes = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...(await collectRoutes(file, `${prefix}/${entry.name}`)));
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;

    const name = entry.name.slice(0, -3);
    const pattern = name === "index" ? prefix : `${prefix}/${name}`;
    const module = await import(pathToFileURL(file).href);
    for (const [exportName, handler] of Object.entries(module)) {
      // onRequestGet, onRequestPost, and so on. A bare onRequest would be the
      // catch-all Pages export, which this app does not use.
      const verb = /^onRequest([A-Za-z]+)$/.exec(exportName)?.[1];
      if (!verb || typeof handler !== "function") continue;
      routes.push({
        method: verb.toUpperCase(),
        pattern,
        segments: pattern.split("/").filter(Boolean),
        handler,
      });
    }
  }
  return routes;
}

// One path can carry several routes, games/[id].js for instance. A caller that
// asked for a verb this path does not export still needs to be told so, which
// is what the path-only match left behind is for.
function matchRoute(routes, pathname, method) {
  const parts = pathname.split("/").filter(Boolean);
  let pathOnly = null;
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params = {};
    const matched = route.segments.every((segment, index) => {
      if (segment.startsWith("[") && segment.endsWith("]")) {
        params[segment.slice(1, -1)] = decodeURIComponent(parts[index]);
        return true;
      }
      return segment === parts[index];
    });
    if (!matched) continue;
    if (route.method === method) return { route, params };
    pathOnly ??= { route, params };
  }
  return pathOnly;
}

async function toRequest(req, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (SKIPPED_HEADERS.has(key) || value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }

  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length > 0) init.body = Buffer.concat(chunks);
  }
  return new Request(url, init);
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", payload.length);
  res.end(payload);
}

async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.status === 204) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

function createMiddleware(routes, env, log) {
  return async function localApi(req, res, next) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!url.pathname.startsWith("/api/")) {
      next();
      return;
    }

    const found = matchRoute(routes, url.pathname, req.method);
    if (!found) {
      log.warn(`No Function matches ${req.method} ${url.pathname}`);
      sendJson(res, 404, { error: "No Function matches this path" });
      return;
    }
    if (found.route.method !== req.method) {
      log.warn(`${req.method} is not exported by ${found.route.pattern}`);
      sendJson(res, 405, { error: `${req.method} is not allowed here` });
      return;
    }

    try {
      const request = await toRequest(req, url);
      const response = await found.route.handler({ request, env, params: found.params });
      await sendResponse(res, response);
      log.info(`${req.method} ${url.pathname} -> ${response.status}`);
    } catch (err) {
      // The Functions report their own failures. An error here means the
      // adapter broke, and a request left open would stall the sync pass.
      console.error(err);
      log.error(`${req.method} ${url.pathname} could not be served`);
      if (res.headersSent) res.end();
      else sendJson(res, 500, { error: "The local API could not serve this request" });
    }
  };
}

async function mount(server, mode) {
  const { logger } = server.config;
  await mkdir(dataDir, { recursive: true });
  const env = { TURSO_DATABASE_URL: `file:${databasePath}` };
  try {
    await applySchema(env);
  } catch (err) {
    // Leave the server up: the cause is on the console, and a request that
    // needs the database fails with the same error.
    logger.error(`Local API could not prepare ${databasePath}\n${err}`);
  }

  const routes = await collectRoutes(functionsDir);
  server.middlewares.use(createMiddleware(routes, env, logger));
  logger.info(
    `${routes.length} Function route(s) served locally in ${mode} mode, data in ${databasePath}`,
  );
}

export function localApi() {
  return {
    name: "local-pages-functions",
    configureServer(server) {
      return mount(server, "dev");
    },
    configurePreviewServer(server) {
      return mount(server, "preview");
    },
  };
}
