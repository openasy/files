// Starts the app on a random port for tests, against OpenCloud in memory, on Wednesday 4 November 2026.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions, type Person } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { fakeOpenCloud, SERVICE_TOKEN, SERVICE_USER } from "./fake-opencloud.ts";
import { createFiles } from "./files.ts";
import { createOpenCloud } from "./opencloud.ts";

export const NOW = Date.parse("2026-11-04T10:00:00Z");
export const ADMIN_TOKEN = "test-admin-token";
/** Tokens that act as a signed-in person, as personTokens. */
export const EMILY = "test-emily-token";
export const MARK = "test-mark-token";
export const SARAH = "test-sarah-token";

export const PEOPLE: Record<string, Person & { groups: string[] }> = {
  [EMILY]: { email: "emily.clark@example.com", name: "Emily Clark", role: "admin", groups: ["finance", "finance-leads", "everyone"] },
  [MARK]: { email: "mark.wilson@example.com", name: "Mark Wilson", role: "user", groups: ["finance", "everyone"] },
  [SARAH]: { email: "sarah.chen@example.com", name: "Sarah Chen", role: "user", groups: ["everyone"] },
};

/** The spaces file the tests start with. */
export const SPACES = `
links:
  maxDays: 90
  passwordRequired: true
bin:
  keepDays: 30
personal:
  quota: 20GB
spaces:
  - name: Finance
    quota: 100GB
    members:
      - { group: finance, role: editor }
      - { group: finance-leads, role: manager }
  - name: Northwind rollout
    kind: project
    description: The Northwind customer rollout.
    quota: 20GB
    members:
      - { group: project-northwind, role: editor }
      - { group: everyone, role: viewer }
`;

/** Files and services wired together without HTTP, for the sync tests. */
export function setup({ clock = () => NOW } = {}) {
  const db = openDb(":memory:");
  const fake = fakeOpenCloud({ clock });
  const oc = createOpenCloud({ url: "http://opencloud:9200", user: SERVICE_USER, token: SERVICE_TOKEN, fetch: fake.fetch, clock });
  const files = createFiles(db, oc, { serviceUser: SERVICE_USER, openCloudUrl: "https://cloud.example.com", clock });
  // Emily and Mark have signed in to Files, and to OpenCloud's apps, before; Sarah only to Files.
  for (const p of Object.values(PEOPLE)) files.rememberPerson(p.email, p.name, p.groups);
  for (const p of [PEOPLE[EMILY]!, PEOPLE[MARK]!]) fake.addUser(p.email, p.name);
  return { db, fake, oc, files, clock };
}

export async function startApp(opts: Partial<AppOptions> & { version: string; spaces?: string }) {
  const { spaces = SPACES, ...rest } = opts;
  const { db, fake, oc, files } = setup();
  await files.setConfig(parseConfig(spaces));
  const finance = fake.driveByName("Finance")!;
  fake.put(finance.id, "Audit 2026/Trial balance 2026-09.xlsx", "tb", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    versions: 5,
  });
  fake.put(finance.id, "Audit 2026/Financial statements draft.pdf", "%PDF", { type: "application/pdf", versions: 2 });
  fake.put(finance.id, "Audit 2026/Inventory count, signed.jpg", "jpg", { type: "image/jpeg" });
  fake.put(finance.id, "Audit 2026/Receipts from the auditor");
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "files", productName: "OpenAsy Files", origin: base, users: true });
  handler = createApp({ db, files, auth, adminToken: ADMIN_TOKEN, personTokens: PEOPLE, ...rest });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, files, fake, oc, auth, base, finance, admin: as(ADMIN_TOKEN), emily: as(EMILY), mark: as(MARK), sarah: as(SARAH), as, close };
}
