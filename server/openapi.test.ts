import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, EMILY, MARK, SARAH, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "files-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const sent = res.headers.get("content-type")!.split(";")[0]!;
  // Files are described as */* or image/*: whatever type they have, as binary.
  const type = response.content?.[sent] ? sent : response.content?.[`${sent.split("/")[0]}/*`] ? `${sent.split("/")[0]}/*` : "*/*";
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${sent}, which openapi.json does not list`).toBeDefined();
  if (type.endsWith("/*")) return { res, body: await res.arrayBuffer() };

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const admin = () => ({ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
const as = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
});
const post = (token: string, body: unknown) => as(token, { body: typeof body === "string" ? body : JSON.stringify(body) });

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Files' own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  const d = () => `/api/v1/drives/${encodeURIComponent(app.finance.id)}`;
  const q = (p: string) => `?path=${encodeURIComponent(p)}`;

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", as(MARK));
    await call("GET", "/api/v1/summary", {});
  });

  it("spaces, handovers and syncs", async () => {
    await call("GET", "/api/v1/spaces", admin());
    await call("GET", "/api/v1/spaces", {});
    const { body } = await call(
      "POST",
      "/api/v1/handovers",
      post(EMILY, { person: "mark.wilson@example.com", manager: "emily.clark@example.com", on: "2026-11-30" }),
    );
    await call("POST", "/api/v1/handovers", post(EMILY, { person: "mark.wilson@example.com", manager: "emily.clark@example.com", on: "2026-11-30" }));
    await call("POST", "/api/v1/handovers", post(EMILY, { person: "mark" }));
    await call("POST", "/api/v1/handovers", post(EMILY, "{"));
    await call("GET", "/api/v1/handovers", admin());
    await call("DELETE", "/api/v1/handovers/{id}", admin(), `/api/v1/handovers/${(body as { id: string }).id}`);
    await call("DELETE", "/api/v1/handovers/{id}", admin(), "/api/v1/handovers/nope");
    await call("POST", "/api/v1/sync", admin());
    await call("POST", "/api/v1/sync", as(MARK));
    await call("GET", "/api/v1/sync", admin());
  });

  it("files", async () => {
    await call("GET", "/api/v1/me", as(EMILY));
    await call("GET", "/api/v1/me", admin());
    const { body } = await call("GET", "/api/v1/drives/{drive}/items", as(EMILY), `${d()}/items${q("Audit 2026")}`);
    await call("GET", "/api/v1/drives/{drive}/items", as(SARAH), `${d()}/items`);
    await call("GET", "/api/v1/drives/{drive}/items", as(EMILY), `${d()}/items${q("../x")}`);
    await call("POST", "/api/v1/drives/{drive}/folders", post(EMILY, { path: "Audit 2026/Bank statements" }), `${d()}/folders`);
    await call("POST", "/api/v1/drives/{drive}/folders", post(EMILY, { path: "Audit 2026/Bank statements" }), `${d()}/folders`);
    await call("POST", "/api/v1/drives/{drive}/folders", post(EMILY, { path: "" }), `${d()}/folders`);
    await call("POST", "/api/v1/drives/{drive}/folders", post(EMILY, "{"), `${d()}/folders`);
    await call(
      "PUT",
      "/api/v1/drives/{drive}/content",
      as(EMILY, { body: "hello", headers: { "content-type": "text/plain" } }),
      `${d()}/content${q("Audit 2026/a.txt")}`,
    );
    await call("PUT", "/api/v1/drives/{drive}/content", as(EMILY, { body: "hello" }), `${d()}/content${q("Nowhere/a.txt")}`);
    await call("GET", "/api/v1/drives/{drive}/content", as(EMILY), `${d()}/content${q("Audit 2026/a.txt")}`);
    await call("GET", "/api/v1/drives/{drive}/content", as(EMILY), `${d()}/content${q("Audit 2026/none.txt")}`);
    await call("GET", "/api/v1/drives/{drive}/preview", as(EMILY), `${d()}/preview${q("Audit 2026/Inventory count, signed.jpg")}`);
    await call("GET", "/api/v1/drives/{drive}/preview", as(EMILY), `${d()}/preview${q("Audit 2026/a.txt")}`);
    const pdf = (body as { items: Array<{ name: string; fileId: string; path: string }> }).items.find((i) => i.name.endsWith(".pdf"))!;
    await call("GET", "/api/v1/drives/{drive}/versions", as(EMILY), `${d()}/versions?fileId=${encodeURIComponent(pdf.fileId)}`);
    await call("POST", "/api/v1/drives/{drive}/versions/restore", post(EMILY, { fileId: pdf.fileId, key: "v1", path: pdf.path }), `${d()}/versions/restore`);
    await call("POST", "/api/v1/drives/{drive}/versions/restore", post(EMILY, {}), `${d()}/versions/restore`);
    await call("DELETE", "/api/v1/drives/{drive}/items", as(EMILY), `${d()}/items${q("Audit 2026/a.txt")}`);
    await call("DELETE", "/api/v1/drives/{drive}/items", as(EMILY), `${d()}/items${q("Audit 2026/a.txt")}`);
    app.fake.state.down = true;
    try {
      await call("GET", "/api/v1/me", as(MARK));
    } finally {
      app.fake.state.down = false;
    }
  });

  it("links", async () => {
    const { body: folder } = await call("GET", "/api/v1/drives/{drive}/items", as(EMILY), `${d()}/items`);
    const item = (folder as { items: Array<{ fileId: string }> }).items[0]!;
    const { body: link } = await call(
      "POST",
      "/api/v1/drives/{drive}/links",
      post(EMILY, { itemId: item.fileId, password: "Audit-2026!", for: "Selin Aydın" }),
      `${d()}/links`,
    );
    await call("POST", "/api/v1/drives/{drive}/links", post(EMILY, { itemId: item.fileId }), `${d()}/links`);
    await call("POST", "/api/v1/drives/{drive}/links", post(EMILY, "{"), `${d()}/links`);
    await call("GET", "/api/v1/drives/{drive}/links", as(EMILY), `${d()}/links?itemId=${encodeURIComponent(item.fileId)}`);
    await call("GET", "/api/v1/drives/{drive}/links", as(SARAH), `${d()}/links?itemId=x`);
    await call("GET", "/api/v1/links", as(EMILY));
    await call("GET", "/api/v1/links", admin());
    const id = (link as { id: string }).id;
    await call("GET", "/api/v1/links/{id}/opens", as(EMILY), `/api/v1/links/${id}/opens`);
    await call("GET", "/api/v1/links/{id}/opens", as(MARK), `/api/v1/links/${id}/opens`);
    await call("DELETE", "/api/v1/links/{id}", as(MARK), `/api/v1/links/${id}`);
    await call("DELETE", "/api/v1/links/{id}", as(EMILY), `/api/v1/links/${id}`);
    app.fake.state.down = true;
    try {
      await call("GET", "/api/v1/drives/{drive}/links", as(EMILY), `${d()}/links?itemId=x`);
    } finally {
      app.fake.state.down = false;
    }
  });

  it("recycle bin", async () => {
    await call("DELETE", "/api/v1/drives/{drive}/items", as(EMILY), `${d()}/items${q("Audit 2026/Bank statements")}`);
    const { body } = await call("GET", "/api/v1/bin", as(EMILY));
    const item = (body as { items: Array<{ driveId: string; key: string; location: string }> }).items[0]!;
    await call("POST", "/api/v1/bin/restore", post(EMILY, item));
    await call("POST", "/api/v1/bin/restore", post(EMILY, item));
    await call("POST", "/api/v1/bin/restore", post(EMILY, { driveId: item.driveId }));
    await call("POST", "/api/v1/bin/restore", post(EMILY, "{"));
    await call("GET", "/api/v1/bin", admin());
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
