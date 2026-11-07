// End to end against a running OpenCloud (e2e/run.sh starts one): Files' own server, with the spaces file applied,
// people reaching their spaces, files going up and down, versions, links to people outside and their openings from the
// audit log, the recycle bin, a handover and a space taken out of the file, each checked in OpenCloud itself.
//
//   OC=https://localhost:19200 OC_TOKEN='...' OC_AUDIT=/tmp/audit.log node e2e/opencloud.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "@openasy/auth";
import { createApp, type Person } from "../server/app.ts";
import { parseConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { createFiles } from "../server/files.ts";
import { createOpenCloud } from "../server/opencloud.ts";
import { readAuditLog } from "../server/opens.ts";

const OC = (process.env.OC ?? "https://localhost:19200").replace(/\/$/, "");
const TOKEN = process.env.OC_TOKEN ?? "";
const AUDIT = process.env.OC_AUDIT;
if (!TOKEN) throw new Error("OC_TOKEN is the admin's app token: e2e/run.sh makes one");

let failures = 0;
async function step(name: string, work: () => Promise<void>) {
  try {
    await work();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${(err as Error).stack?.split("\n").slice(0, 5).join("\n  ")}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Asks again until OpenCloud has caught up: some of its services apply a change a moment later. */
async function eventually<T>(work: () => Promise<T>, tries = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(1000);
    }
  }
}

// ---- OpenCloud itself, as its admin, to check what Files did there

async function graph<T = any>(path: string): Promise<T> {
  const res = await fetch(OC + path, { headers: { authorization: `Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

// ---- Files, wired as main.ts wires it, with tokens that act as three signed-in people

const EMILY = "e2e-emily";
const MARK = "e2e-mark";
const SARAH = "e2e-sarah";
const ADMIN = "e2e-admin";
const PEOPLE: Record<string, Person & { groups: string[] }> = {
  [EMILY]: { email: "emily.clark@example.com", name: "Emily Clark", role: "admin", groups: ["finance", "finance-leads", "everyone"] },
  [MARK]: { email: "mark.wilson@example.com", name: "Mark Wilson", role: "user", groups: ["finance", "everyone"] },
  [SARAH]: { email: "sarah.chen@example.com", name: "Sarah Chen", role: "user", groups: ["everyone"] },
};
const SPACES = (extra = "") => `
links:
  maxDays: 30
  passwordRequired: true
bin:
  keepDays: 30
spaces:
  - name: Finance
    quota: 5GB
    members:
      - { group: finance, role: editor }
      - { group: finance-leads, role: manager }
  - name: Northwind rollout
    kind: project
    description: The Northwind customer rollout.
    quota: 1GB
    members:
      - { group: everyone, role: viewer }
${extra}`;

const db = openDb(join(mkdtempSync(join(tmpdir(), "files-e2e-")), "files.db"));
const oc = createOpenCloud({ url: OC, user: "admin", token: TOKEN });
const files = createFiles(db, oc, { serviceUser: "admin", openCloudUrl: OC });
for (const p of Object.values(PEOPLE)) files.rememberPerson(p.email, p.name, p.groups);

let handler: RequestListener = (_req, res) => res.writeHead(503).end();
const server: Server = createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const auth = createAuth({ db, product: "files", productName: "OpenAsy Files", origin: base, users: true });
handler = createApp({ db, files, auth, adminToken: ADMIN, personTokens: PEOPLE, version: "0.0.0" });

async function as<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 300)}`), { status: res.status });
  return (text ? (text.startsWith("{") ? JSON.parse(text) : text) : undefined) as T;
}
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
type Space = { id: string; name: string; kind: string; quota: number | null };
const mySpaces = async (token: string) => (await as<{ spaces: Space[] }>(token, "/api/v1/me")).spaces;
const q = (path: string) => `path=${encodeURIComponent(path)}`;

let finance: Space;
let fileId = "";

await step("the spaces file makes the spaces in OpenCloud, with their quota and description", async () => {
  const r = await files.setConfig(parseConfig(SPACES()));
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual([...r.created].sort(), ["Finance", "Northwind rollout"]);
  const drives = (
    await graph<{ value: Array<{ name: string; driveType: string; description?: string; quota?: { total?: number } }> }>("/graph/v1.0/drives")
  ).value.filter((d) => d.driveType === "project");
  const f = drives.find((d) => d.name === "Finance");
  assert.ok(f, `no Finance space in OpenCloud: ${drives.map((d) => d.name).join(", ")}`);
  assert.equal(f.quota?.total, 5 * 1024 ** 3);
  assert.equal(drives.find((d) => d.name === "Northwind rollout")?.description, "The Northwind customer rollout.");
});

await step("people get an OpenCloud account the first time, and see the spaces their groups give them", async () => {
  const emily = await mySpaces(EMILY);
  finance = emily.find((s) => s.name === "Finance")!;
  assert.ok(finance, `Emily's spaces: ${emily.map((s) => s.name).join(", ")}`);
  assert.ok(emily.some((s) => s.kind === "personal"));
  assert.ok((await mySpaces(MARK)).some((s) => s.name === "Finance"));
  const sarah = await mySpaces(SARAH);
  assert.ok(!sarah.some((s) => s.name === "Finance"), "Sarah is not in finance");
  assert.ok(sarah.some((s) => s.name === "Northwind rollout"));
  const users = (await graph<{ value: Array<{ mail: string }> }>("/graph/v1.0/users")).value.map((u) => u.mail);
  for (const p of Object.values(PEOPLE)) assert.ok(users.includes(p.email), `${p.email} has no account`);
});

await step("the space's members in OpenCloud follow the file: finance as editors, finance-leads as managers", async () => {
  const perms = (
    await graph<{ value: Array<{ roles?: string[]; grantedToV2?: { group?: { displayName: string } } }> }>(
      `/graph/v1beta1/drives/${finance.id}/root/permissions`,
    )
  ).value;
  const role = (g: string) => perms.find((p) => p.grantedToV2?.group?.displayName === g)?.roles?.[0];
  assert.ok(role("finance"), `groups on Finance: ${JSON.stringify(perms.map((p) => p.grantedToV2))}`);
  assert.ok(role("finance-leads"));
  assert.notEqual(role("finance"), role("finance-leads"));
});

await step("a file goes up, lists, comes down, and an upload over it keeps the earlier version", async () => {
  await as(EMILY, `/api/v1/drives/${finance.id}/folders`, { method: "POST", body: JSON.stringify({ path: "Audit 2026" }) });
  const put = (text: string) =>
    as(EMILY, `/api/v1/drives/${finance.id}/content?${q("Audit 2026/Trial balance.csv")}`, {
      method: "PUT",
      body: text,
      headers: { "content-type": "text/csv" },
    });
  await put("account,balance\n100,1\n");
  await put("account,balance\n100,2\n");
  const list = await as<{ items: Array<{ name: string; fileId: string; size: number }> }>(MARK, `/api/v1/drives/${finance.id}/items?${q("Audit 2026")}`);
  const item = list.items.find((i) => i.name === "Trial balance.csv");
  assert.ok(item, JSON.stringify(list));
  fileId = item.fileId;
  assert.equal(await as(MARK, `/api/v1/drives/${finance.id}/content?${q("Audit 2026/Trial balance.csv")}`), "account,balance\n100,2\n");
  const { versions } = await eventually(async () => {
    const v = await as<{ versions: Array<{ key: string }> }>(EMILY, `/api/v1/drives/${finance.id}/versions?fileId=${encodeURIComponent(fileId)}`);
    assert.ok(v.versions.length >= 1, "no versions yet");
    return v;
  });
  await as(EMILY, `/api/v1/drives/${finance.id}/versions/restore`, {
    method: "POST",
    body: JSON.stringify({ fileId, key: versions[0]!.key, path: "Audit 2026/Trial balance.csv" }),
  });
  assert.equal(await as(EMILY, `/api/v1/drives/${finance.id}/content?${q("Audit 2026/Trial balance.csv")}`), "account,balance\n100,1\n");
});

await step("someone outside a space cannot reach it, even with its id", async () => {
  assert.equal(await status(as(SARAH, `/api/v1/drives/${finance.id}/items?${q("")}`)), 404);
});

let linkUrl = "";
await step("a link needs a password and expires within the file's limit; OpenCloud keeps both", async () => {
  const body = (extra: object) => ({ method: "POST", body: JSON.stringify({ itemId: fileId, name: "Trial balance.csv", for: "Auditor", ...extra }) });
  assert.equal(await status(as(EMILY, `/api/v1/drives/${finance.id}/links`, body({}))), 422);
  const far = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(await status(as(EMILY, `/api/v1/drives/${finance.id}/links`, body({ password: "Audit-2026-pass!", expires: far }))), 422);
  const link = await as<{ url: string; password: boolean; expiresAt: string }>(
    EMILY,
    `/api/v1/drives/${finance.id}/links`,
    body({ password: "Audit-2026-pass!" }),
  );
  assert.equal(link.password, true);
  assert.ok(link.url.startsWith(OC), link.url);
  linkUrl = link.url;
  const perms = (
    await graph<{ value: Array<{ hasPassword?: boolean; expirationDateTime?: string; link?: unknown }> }>(
      `/graph/v1beta1/drives/${finance.id}/items/${encodeURIComponent(fileId)}/permissions`,
    )
  ).value.filter((p) => p.link);
  assert.ok(
    perms.some((p) => p.hasPassword && p.expirationDateTime),
    JSON.stringify(perms),
  );
  const mine = await as<{ links: Array<{ for: string | null }> }>(EMILY, "/api/v1/links");
  assert.ok(mine.links.some((l) => l.for === "Auditor"));
});

await step("opening the link with its password is read from OpenCloud's audit log", async () => {
  if (!AUDIT) throw new Error("OC_AUDIT is not set");
  const token = linkUrl.replace(/\/$/, "").split("/").at(-1)!;
  // What OpenCloud's web page does for a link with a password: WebDAV on the public link, with the password.
  const res = await fetch(`${OC}/dav/public-files/${token}/`, {
    method: "PROPFIND",
    headers: { depth: "1", authorization: `Basic ${Buffer.from(`public:Audit-2026-pass!`).toString("base64")}` },
  });
  assert.ok(res.status === 207, `public link answered ${res.status}`);
  await fetch(`${OC}/dav/public-files/${token}/Trial%20balance.csv`, {
    headers: { authorization: `Basic ${Buffer.from(`public:Audit-2026-pass!`).toString("base64")}` },
  }).then((r) => r.arrayBuffer());
  const n = await eventually(async () => {
    const read = readAuditLog(db, AUDIT);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM link_opens").get() as { n: number };
    assert.ok(rows.n > 0, `nothing read yet (${read} new lines)`);
    return rows.n;
  }, 20);
  assert.ok(n > 0);
});

await step("a deleted file is in the recycle bin and comes back", async () => {
  await as(EMILY, `/api/v1/drives/${finance.id}/content?${q("Old note.txt")}`, { method: "PUT", body: "old", headers: { "content-type": "text/plain" } });
  await as(EMILY, `/api/v1/drives/${finance.id}/items?${q("Old note.txt")}`, { method: "DELETE" });
  const bin = await eventually(async () => {
    const b = await as<{ items: Array<{ name: string; key: string; location: string; driveId: string }> }>(EMILY, "/api/v1/bin");
    assert.ok(
      b.items.some((i) => i.name === "Old note.txt"),
      JSON.stringify(b.items),
    );
    return b;
  });
  const item = bin.items.find((i) => i.name === "Old note.txt")!;
  await as(EMILY, "/api/v1/bin/restore", { method: "POST", body: JSON.stringify({ driveId: item.driveId, key: item.key, location: item.location }) });
  assert.equal(await as(EMILY, `/api/v1/drives/${finance.id}/content?${q("Old note.txt")}`), "old");
});

await step("someone who leaves a group leaves the space at the next sync", async () => {
  files.rememberPerson(PEOPLE[MARK]!.email, PEOPLE[MARK]!.name, ["everyone"]);
  await files.syncNow();
  await eventually(async () => assert.ok(!(await mySpaces(MARK)).some((s) => s.name === "Finance"), "Mark still sees Finance"));
});

await step("a handover copies someone's own files to a space their manager runs", async () => {
  const own = (await mySpaces(MARK)).find((s) => s.kind === "personal")!;
  // Into a folder that is not there yet: OpenCloud refuses, and Files says why.
  const missing = await as(MARK, `/api/v1/drives/${own.id}/content?${q("Plans/Q4 plan.txt")}`, { method: "PUT", body: "q4" }).catch((e: Error) => e.message);
  assert.match(String(missing), /folder it goes in is not there/);
  await as(MARK, `/api/v1/drives/${own.id}/folders`, { method: "POST", body: JSON.stringify({ path: "Plans" }) });
  await as(MARK, `/api/v1/drives/${own.id}/content?${q("Plans/Q4 plan.txt")}`, { method: "PUT", body: "q4", headers: { "content-type": "text/plain" } });
  const h = await as<{ status: string; driveId: string | null; error: string | null }>(ADMIN, "/api/v1/handovers", {
    method: "POST",
    body: JSON.stringify({ person: PEOPLE[MARK]!.email, manager: PEOPLE[EMILY]!.email }),
  });
  assert.equal(h.status, "done", h.error ?? "");
  const space = (await mySpaces(EMILY)).find((s) => s.id === h.driveId);
  assert.ok(space, "Emily runs the handover space");
  assert.equal(await as(EMILY, `/api/v1/drives/${space.id}/content?${q("Plans/Q4 plan.txt")}`), "q4");
  // Their OpenCloud account is disabled, and Files says so rather than that OpenCloud is down.
  const after = await as(MARK, "/api/v1/me").catch((e: Error) => e.message);
  assert.match(String(after), /403.*disabled/);
});

await step("a space taken out of the file is disabled in OpenCloud, not deleted", async () => {
  const before = (await graph<{ value: Array<{ id: string; name: string }> }>("/graph/v1.0/drives")).value.find((d) => d.name === "Northwind rollout")!;
  await files.setConfig(parseConfig(SPACES().replace(/  - name: Northwind rollout[\s\S]*$/, "")));
  const after = await graph<{ root?: { deleted?: { state?: string } } }>(`/graph/v1.0/drives/${before.id}`).catch(() => null);
  assert.equal(after?.root?.deleted?.state, "trashed", JSON.stringify(after));
  assert.ok(!(await mySpaces(SARAH)).some((s) => s.name === "Northwind rollout"));
});

server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
