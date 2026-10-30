import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, atLeast, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { FilesError, type Files, type ProblemCode } from "./files.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  files: Files;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** For tests and local scripts: tokens that act as a signed-in person, by token. main.ts never sets it. */
  personTokens?: Record<string, Person>;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

/** A signed-in person, for "self" routes. */
export interface Person {
  email: string;
  name: string;
  role: Role;
}

function metricsText(files: Files, version: string) {
  return renderMetrics(version, { ...files.gauges(), fileError: !!files.summary().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (FILES_METRICS_PORT). */
export function createMetricsHandler(files: Files, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(files, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json");

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  "not-allowed": "Not allowed",
  conflict: "Conflict",
  "quota-exceeded": "Quota exceeded",
  "opencloud-unavailable": "OpenCloud unavailable",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new FilesError(413, "payload-too-large", `The body must be at most ${limit / 1024} KiB.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FilesError(400, "invalid-json", "The body must be JSON.");
  }
}

/** Sends a file from OpenCloud on as it comes. A download is always an attachment, never a page of this origin. */
function pipe(res: ServerResponse, r: Response, headers: Record<string, string>) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-security-policy": "sandbox",
    "content-type": r.headers.get("content-type") ?? "application/octet-stream",
    ...(r.headers.get("content-length") && { "content-length": r.headers.get("content-length")! }),
    ...headers,
  });
  if (r.body) Readable.fromWeb(r.body as NodeReadableStream).pipe(res);
  else res.end();
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The role a route needs (ADR 0003). "none" for the version; "self" for a person's own files and links, which need a
 * signed-in person (not an API token) and go to OpenCloud as that person.
 */
type Access = "none" | "self" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  /** The signed-in person, for "self" routes, and who changed something, for the log. */
  person: Person;
  /** A path in a space, from ?path=. */
  path: string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  files,
  version,
  auth,
  adminToken,
  personTokens = {},
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "files", version }) },
    { method: "GET", path: "/api/v1/products", auth: "user", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => files.summary() },

    // The spaces and rules, as the file sets them. There is no route that adds, changes or removes one.
    {
      method: "GET",
      path: "/api/v1/spaces",
      auth: "viewer",
      handle: () => ({ spaces: files.spaceList(), policy: files.config().policy, file: files.summary().file }),
    },

    // Bringing OpenCloud in step with the file, which also happens after every change and every five minutes.
    {
      method: "GET",
      path: "/api/v1/sync",
      auth: "viewer",
      handle: () => ({
        last: files.lastSync(),
        runs: db
          .prepare("SELECT at, ok, created, updated, disabled, links, purged, error FROM sync_runs ORDER BY id DESC LIMIT 20")
          .all()
          .map((r) => ({ ...r, ok: r.ok === 1 })),
      }),
    },
    { method: "POST", path: "/api/v1/sync", auth: "admin", handle: () => files.syncNow() },

    // Someone leaving: their own files go to a space of their manager's on the day.
    { method: "GET", path: "/api/v1/handovers", auth: "viewer", handle: () => ({ handovers: files.handovers() }) },
    {
      method: "POST",
      path: "/api/v1/handovers",
      auth: "admin",
      handle: async ({ req, res, person }) => json(res, 201, await files.planHandover(person.email || "api token", await readJson(req))),
    },
    {
      method: "DELETE",
      path: "/api/v1/handovers/:id",
      auth: "admin",
      handle: ({ res, params, person }) => (files.cancelHandover(params[0]!, person.email || "api token"), noContent(res)),
    },

    // Links to people outside: viewers and up see every one, everyone else their own.
    { method: "GET", path: "/api/v1/links", auth: "self", handle: ({ person }) => files.links(person.email, atLeast(person.role, "viewer")) },
    {
      method: "GET",
      path: "/api/v1/links/:id/opens",
      auth: "self",
      handle: ({ person, params }) => files.opens(person.email, atLeast(person.role, "viewer"), params[0]!),
    },
    {
      method: "DELETE",
      path: "/api/v1/links/:id",
      auth: "self",
      handle: async ({ res, person, params }) => (await files.stopLink(person.email, atLeast(person.role, "editor"), params[0]!), noContent(res)),
    },

    // A person's own spaces and files, as OpenCloud keeps them, reached as that person.
    { method: "GET", path: "/api/v1/me", auth: "self", handle: ({ person }) => files.me(person.email, person.name) },
    { method: "GET", path: "/api/v1/bin", auth: "self", handle: ({ person }) => files.bin(person.email) },
    {
      method: "POST",
      path: "/api/v1/bin/restore",
      auth: "self",
      handle: async ({ req, res, person }) => (await files.restore(person.email, await readJson(req)), noContent(res)),
    },
    { method: "GET", path: "/api/v1/drives/:drive/items", auth: "self", handle: ({ person, params, path }) => files.list(person.email, params[0]!, path) },
    {
      method: "DELETE",
      path: "/api/v1/drives/:drive/items",
      auth: "self",
      handle: async ({ res, person, params, path }) => (await files.remove(person.email, params[0]!, path), noContent(res)),
    },
    {
      method: "POST",
      path: "/api/v1/drives/:drive/folders",
      auth: "self",
      handle: async ({ req, res, person, params }) => {
        const body = (await readJson(req)) as { path?: unknown } | null;
        if (typeof body?.path !== "string" || !body.path.trim())
          throw new FilesError(422, "invalid-body", "path names the new folder, such as Audit 2026/Receipts.");
        await files.mkdir(person.email, params[0]!, body.path);
        json(res, 201, { path: body.path });
      },
    },
    {
      method: "GET",
      path: "/api/v1/drives/:drive/content",
      auth: "self",
      handle: async ({ res, person, params, path }) => {
        const r = await files.download(person.email, params[0]!, path);
        const name = path.split("/").at(-1) || "download";
        pipe(res, r, { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
      },
    },
    {
      method: "PUT",
      path: "/api/v1/drives/:drive/content",
      auth: "self",
      handle: async ({ req, res, person, params, path }) => {
        // OpenCloud needs the size up front; the body goes on as it arrives and is never held here.
        const length = Number(req.headers["content-length"]);
        if (!Number.isSafeInteger(length) || length < 0) throw new FilesError(422, "invalid-body", "An upload needs a Content-Length.");
        const body = Readable.toWeb(req) as unknown as ReadableStream;
        await files.upload(person.email, params[0]!, path, body, length, req.headers["content-type"] ?? "application/octet-stream");
        noContent(res);
      },
    },
    {
      method: "GET",
      path: "/api/v1/drives/:drive/preview",
      auth: "self",
      handle: async ({ res, person, params, path }) => {
        const r = await files.preview(person.email, params[0]!, path);
        if (!r.headers.get("content-type")?.startsWith("image/")) throw new FilesError(404, "not-found", "No preview of this file.");
        pipe(res, r, { "cache-control": "private, max-age=300" });
      },
    },
    {
      method: "GET",
      path: "/api/v1/drives/:drive/versions",
      auth: "self",
      handle: ({ url, person, params }) => files.versions(person.email, params[0]!, url.searchParams.get("fileId") ?? ""),
    },
    {
      method: "POST",
      path: "/api/v1/drives/:drive/versions/restore",
      auth: "self",
      handle: async ({ req, res, person, params }) => (await files.restoreVersion(person.email, params[0]!, await readJson(req)), noContent(res)),
    },
    {
      method: "GET",
      path: "/api/v1/drives/:drive/links",
      auth: "self",
      handle: ({ url, person, params }) => files.itemLinks(person.email, params[0]!, url.searchParams.get("itemId") ?? ""),
    },
    {
      method: "POST",
      path: "/api/v1/drives/:drive/links",
      auth: "self",
      handle: async ({ req, res, person, params }) => json(res, 201, await files.createLink(person.email, params[0]!, await readJson(req))),
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Person {
    const nobody: Person = { email: "", name: "", role: "admin" };
    if (access === "none") return nobody;
    if (access !== "self" && tokenMatches(req.headers.authorization, adminToken)) return nobody;
    for (const [token, person] of Object.entries(personTokens)) {
      if (!tokenMatches(req.headers.authorization, token)) continue;
      if (access !== "self" && !atLeast(person.role, access)) throw new AuthError(403, "forbidden", `This needs the ${access} role.`);
      return person;
    }
    const p = auth.authorize(req, access === "self" ? "user" : access);
    if (p.kind === "session") return { email: p.user.email, name: p.user.name, role: p.role };
    if (access === "self") throw new AuthError(403, "forbidden", "Only a signed-in person can reach their files, not an API token.");
    return { email: "", name: p.name, role: p.role };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready while the database answers; OpenCloud being away shows in the summary, not here, so the sign-in and the
      // admin pages stay up to say so.
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(files, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const person = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, person, path: url.searchParams.get("path") ?? "" });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof FilesError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
