import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAuditLog } from "./opens.ts";
import { startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const drive = () => encodeURIComponent(app.finance.id);
const q = (path: string) => `?path=${encodeURIComponent(path)}`;

describe("a person's files", () => {
  it("lists the person's spaces, their own first, with the rules that apply", async () => {
    const me = await json(await app.emily("/api/v1/me"));
    expect(me.spaces.map((s: any) => [s.name, s.kind])).toEqual([
      ["My files", "personal"],
      ["Finance", "team"],
      ["Northwind rollout", "project"],
    ]);
    expect(me.spaces[1]).toMatchObject({ groups: ["finance", "finance-leads"], quota: 100 * 1024 ** 3 });
    expect(me.policy.links).toEqual({ maxDays: 90, passwordRequired: true });
    // Sarah is only in everyone: they see their own space and Northwind, which they can read.
    const sarah = await json(await app.sarah("/api/v1/me"));
    expect(sarah.spaces.map((s: any) => s.name)).toEqual(["My files", "Northwind rollout"]);
  });

  it("lists a folder, folders and files with what OpenCloud says about them", async () => {
    const r = await json(await app.emily(`/api/v1/drives/${drive()}/items${q("Audit 2026")}`));
    expect(r.path).toBe("Audit 2026");
    expect(r.items.map((i: any) => [i.name, i.folder])).toEqual([
      ["Trial balance 2026-09.xlsx", false],
      ["Financial statements draft.pdf", false],
      ["Inventory count, signed.jpg", false],
      ["Receipts from the auditor", true],
    ]);
    expect(r.items[2]).toMatchObject({ hasPreview: true, contentType: "image/jpeg", size: 3 });
    expect((await app.emily(`/api/v1/drives/${drive()}/items${q("../../etc")}`)).status).toBe(422);
    expect((await app.sarah(`/api/v1/drives/${drive()}/items`)).status).toBe(404);
  });

  it("uploads, downloads as an attachment, and previews pictures", async () => {
    const put = await app.emily(`/api/v1/drives/${drive()}/content${q("Audit 2026/Management representation letter.docx")}`, {
      method: "PUT",
      body: "<script>alert(1)</script>",
      headers: { "content-type": "text/html" },
    });
    expect(put.status).toBe(204);
    const down = await app.emily(`/api/v1/drives/${drive()}/content${q("Audit 2026/Management representation letter.docx")}`);
    expect(down.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Management%20representation%20letter.docx");
    expect(down.headers.get("content-security-policy")).toBe("sandbox");
    expect(await down.text()).toBe("<script>alert(1)</script>");
    expect((await app.emily(`/api/v1/drives/${drive()}/preview${q("Audit 2026/Inventory count, signed.jpg")}`)).headers.get("content-type")).toBe("image/png");
    expect((await app.emily(`/api/v1/drives/${drive()}/preview${q("Audit 2026/Financial statements draft.pdf")}`)).status).toBe(404);
    // Viewers of a space cannot add to it: OpenCloud says no and Files passes that on.
    const north = (await json(await app.sarah("/api/v1/me"))).spaces[1].id;
    expect((await app.sarah(`/api/v1/drives/${encodeURIComponent(north)}/content${q("x.txt")}`, { method: "PUT", body: "x" })).status).toBe(403);
  });

  it("makes folders, and deletes to the recycle bin, from where it comes back", async () => {
    expect(
      (await app.emily(`/api/v1/drives/${drive()}/folders`, { method: "POST", body: JSON.stringify({ path: "Audit 2026/Bank statements" }) })).status,
    ).toBe(201);
    expect(
      (await app.emily(`/api/v1/drives/${drive()}/folders`, { method: "POST", body: JSON.stringify({ path: "Audit 2026/Bank statements" }) })).status,
    ).toBe(409);
    expect((await app.emily(`/api/v1/drives/${drive()}/items${q("Audit 2026/Bank statements")}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.emily(`/api/v1/drives/${drive()}/items${q("")}`, { method: "DELETE" })).status).toBe(422);
    const bin = await json(await app.emily("/api/v1/bin"));
    expect(bin.keepDays).toBe(30);
    const item = bin.items.find((i: any) => i.name === "Bank statements");
    expect(item).toMatchObject({ space: "Finance", location: "Audit 2026/Bank statements", folder: true, keptUntil: "2026-12-04T10:00:00.000Z" });
    const back = await app.emily("/api/v1/bin/restore", {
      method: "POST",
      body: JSON.stringify({ driveId: item.driveId, key: item.key, location: item.location }),
    });
    expect(back.status).toBe(204);
    expect((await json(await app.emily("/api/v1/bin"))).items.some((i: any) => i.name === "Bank statements")).toBe(false);
  });

  it("lists a file's earlier versions and brings one back", async () => {
    const list = await json(await app.emily(`/api/v1/drives/${drive()}/items${q("Audit 2026")}`));
    const fs = list.items.find((i: any) => i.name === "Financial statements draft.pdf");
    const v = await json(await app.emily(`/api/v1/drives/${drive()}/versions?fileId=${encodeURIComponent(fs.fileId)}`));
    expect(v.versions.map((x: any) => x.key)).toEqual(["v1", "v2"]);
    const r = await app.emily(`/api/v1/drives/${drive()}/versions/restore`, {
      method: "POST",
      body: JSON.stringify({ fileId: fs.fileId, key: "v2", path: fs.path }),
    });
    expect(r.status).toBe(204);
    expect(await (await app.emily(`/api/v1/drives/${drive()}/content${q(fs.path)}`)).text()).toBe("%PDF v2");
  });
});

describe("links", () => {
  let audit: { id: string; url: string };

  it("are made within the file's rules: a password, and at most links.maxDays", async () => {
    const list = await json(await app.emily(`/api/v1/drives/${drive()}/items`));
    const folder = list.items.find((i: any) => i.name === "Audit 2026");
    const make = (b: object) =>
      app.emily(`/api/v1/drives/${drive()}/links`, { method: "POST", body: JSON.stringify({ itemId: folder.fileId, name: "Audit 2026", folder: true, ...b }) });
    const noPassword = await make({ for: "selin.aydin@audit-firm.example", expires: "2026-11-18" });
    expect(noPassword.status).toBe(422);
    expect((await json(noPassword)).detail).toBe("Links need a password: links.passwordRequired is set in files.yaml.");
    const tooLong = await make({ password: "Audit-2026!", expires: "2027-03-01" });
    expect((await json(tooLong)).detail).toBe("A link lasts at most 90 days, until 2027-02-02: links.maxDays is set in files.yaml.");
    const made = await make({ for: "selin.aydin@audit-firm.example", password: "Audit-2026!", expires: "2026-11-18" });
    expect(made.status).toBe(201);
    audit = await json(made);
    expect(audit).toMatchObject({ for: "selin.aydin@audit-firm.example", kind: "download", password: true, expiresAt: "2026-11-18T23:59:59Z" });
    expect(audit.url).toMatch(/^https:\/\/cloud\.example\.com\/s\//);
    const upload = await make({ kind: "upload", password: "Receipts-2026!" });
    expect((await json(upload)).expiresAt).toBe("2027-02-02T23:59:59Z");
    expect((await json(await app.emily(`/api/v1/drives/${drive()}/links?itemId=${encodeURIComponent(folder.fileId)}`))).links.map((l: any) => l.kind)).toEqual([
      "download",
      "upload",
    ]);
  });

  it("are listed whole for viewers and up, and each person's own for everyone else", async () => {
    const all = await json(await app.emily("/api/v1/links"));
    expect(all.links.map((l: any) => [l.item, l.space, l.by])).toEqual([
      ["Audit 2026", "Finance", "emily.clark@example.com"],
      ["Audit 2026", "Finance", "emily.clark@example.com"],
    ]);
    expect((await json(await app.mark("/api/v1/links"))).links).toEqual([]);
    expect((await app.mark(`/api/v1/links/${audit.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("show what was opened through them, from OpenCloud's audit log", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "files-audit-")), "audit.log");
    const token = audit.url.split("/").at(-1);
    const line = (time: string, success: boolean) =>
      JSON.stringify({ Action: "public_link_accessed", Time: time, ShareToken: token, FileID: "x", Success: success, Message: "link was accessed" });
    writeFileSync(path, [line("2026-11-04T10:40:00Z", true), line("2026-11-04T10:39:00Z", false), JSON.stringify({ Action: "file_read" }), "{half"].join("\n"));
    expect(readAuditLog(app.db, path, () => new Date("2026-11-04T11:00:00Z"))).toBe(2);
    // The line still being written is read once it is whole; nothing is read twice.
    expect(readAuditLog(app.db, path)).toBe(0);
    const opens = await json(await app.emily(`/api/v1/links/${audit.id}/opens`));
    expect(opens.opens).toEqual([
      { at: "2026-11-04T10:40:00.000Z", success: true },
      { at: "2026-11-04T10:39:00.000Z", success: false },
    ]);
    expect((await json(await app.emily("/api/v1/links"))).links.find((l: any) => l.id === audit.id).opens).toBe(1);
    expect((await json(await app.admin("/api/v1/summary"))).links.openedThisWeek).toBe(1);
  });

  it("can be stopped by their maker", async () => {
    expect((await app.emily(`/api/v1/links/${audit.id}`, { method: "DELETE" })).status).toBe(204);
    expect(app.fake.links.has(audit.id)).toBe(false);
    expect((await json(await app.emily("/api/v1/links"))).links.length).toBe(1);
  });
});

describe("administration", () => {
  it("shows the spaces of the file with their size, read-only", async () => {
    const r = await json(await app.admin("/api/v1/spaces"));
    expect(r.spaces.map((s: any) => [s.name, s.state, s.members.length])).toEqual([
      ["Finance", "active", 2],
      ["Northwind rollout", "active", 2],
    ]);
    expect(r.policy.bin.keepDays).toBe(30);
    expect((await app.emily("/api/v1/spaces", { method: "POST" })).status).toBe(404);
    expect((await app.mark("/api/v1/spaces")).status).toBe(403);
  });

  it("plans a handover and cancels it", async () => {
    const made = await app.emily("/api/v1/handovers", {
      method: "POST",
      body: JSON.stringify({ person: "Mark.Wilson@example.com", manager: "emily.clark@example.com", on: "2026-11-30" }),
    });
    expect(made.status).toBe(201);
    const h = await json(made);
    expect(h).toMatchObject({ person: "mark.wilson@example.com", on: "2026-11-30", status: "planned", createdBy: "emily.clark@example.com" });
    expect((await json(await app.emily("/api/v1/bin"))).leaving).toEqual([
      { person: "mark.wilson@example.com", manager: "emily.clark@example.com", on: "2026-11-30" },
    ]);
    expect((await app.mark("/api/v1/handovers", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await app.admin(`/api/v1/handovers/${h.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.admin(`/api/v1/handovers/${h.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("syncs on request and keeps the history", async () => {
    expect(await json(await app.admin("/api/v1/sync", { method: "POST" }))).toMatchObject({ ok: true, created: [] });
    expect((await json(await app.admin("/api/v1/sync"))).runs.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a person's files from API tokens, and says when OpenCloud does not answer", async () => {
    expect((await app.admin("/api/v1/me")).status).toBe(401);
    app.fake.state.down = true;
    try {
      const res = await app.mark("/api/v1/bin");
      expect(res.status).toBe(502);
      expect((await json(res)).code).toBe("opencloud-unavailable");
    } finally {
      app.fake.state.down = false;
    }
  });
});
