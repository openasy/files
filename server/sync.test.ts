import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { fakeOpenCloud, SERVICE_USER } from "./fake-opencloud.ts";
import { createOpenCloud, SPACE_ROLES } from "./opencloud.ts";
import { judgeLink } from "./sync.ts";
import { MARK, NOW, PEOPLE, setup, SPACES } from "./test-app.ts";

const GB = 1024 ** 3;
const DAY = 86_400_000;

function world() {
  const t = { now: NOW };
  const s = setup({ clock: () => t.now });
  const grants = (name: string) =>
    s.fake
      .driveByName(name)!
      .grants.map((g) => [g.kind === "group" ? s.fake.groups.get(g.objectId)!.displayName : s.fake.users.get(g.objectId)!.onPremisesSamAccountName, g.role]);
  const user = (email: string) => s.fake.userByName(email)!;
  return { ...s, t, grants, user };
}

describe("keeping OpenCloud in step with the file", () => {
  it("makes each space with its quota and groups, and sets the personal quota", async () => {
    const { files, fake, grants, user } = world();
    const r = await files.setConfig(parseConfig(SPACES));
    expect(r).toMatchObject({ ok: true, created: ["Finance", "Northwind rollout"], disabled: [], error: null });
    expect(fake.driveByName("Finance")!.quota).toBe(100 * GB);
    expect(fake.driveByName("Northwind rollout")!.description).toBe("The Northwind customer rollout.");
    // The maker's own grant stays; the groups get the roles of the file.
    expect(grants("Finance")).toEqual([
      [SERVICE_USER, "manager"],
      ["finance", "editor"],
      ["finance-leads", "manager"],
    ]);
    // Groups nobody signed in to OpenCloud with yet are made, and people Files knows are put in them.
    expect([...fake.groups.values()].map((g) => g.displayName).sort()).toEqual(["everyone", "finance", "finance-leads", "project-northwind"]);
    const finance = [...fake.groups.values()].find((g) => g.displayName === "finance")!;
    expect([...finance.members].sort()).toEqual([user("emily.clark@example.com").id, user("mark.wilson@example.com").id].sort());
    expect(fake.personalOf(user("emily.clark@example.com").id)!.quota).toBe(20 * GB);
    // Emily is in finance-leads, so they manage Finance; Mark edits it.
    expect(fake.roleIn(fake.driveByName("Finance")!.id, user("emily.clark@example.com").id)).toBe("manager");
    expect(fake.roleIn(fake.driveByName("Finance")!.id, user("mark.wilson@example.com").id)).toBe("editor");
  });

  it("changes nothing when OpenCloud already matches", async () => {
    const { files, fake } = world();
    await files.setConfig(parseConfig(SPACES));
    const before = fake.calls.length;
    const r = await files.syncNow();
    expect(r).toMatchObject({ ok: true, created: [], updated: [], disabled: [], links: 0, purged: 0 });
    const writes = fake.calls.slice(before).filter((c) => !["GET", "PROPFIND"].includes(c.method) && c.path !== "/auth-app/tokens");
    expect(writes).toEqual([]);
  });

  it("puts back what was changed in OpenCloud by hand, and takes away grants the file does not give", async () => {
    const { files, fake, grants, user } = world();
    await files.setConfig(parseConfig(SPACES));
    const finance = fake.driveByName("Finance")!;
    finance.quota = 5 * GB;
    finance.grants.find((g) => g.role === "editor")!.role = "viewer";
    finance.grants.push({ id: "by-hand", kind: "user", objectId: user("mark.wilson@example.com").id, role: "manager" });
    const r = await files.syncNow();
    expect(r.updated).toEqual(["Finance"]);
    expect(finance.quota).toBe(100 * GB);
    expect(grants("Finance")).toEqual([
      [SERVICE_USER, "manager"],
      ["finance", "editor"],
      ["finance-leads", "manager"],
    ]);
  });

  it("follows changes of the file, disables spaces taken out of it and never deletes one", async () => {
    const { files, fake, grants, oc } = world();
    await files.setConfig(parseConfig(SPACES));
    // A space made in OpenCloud by hand is not the file's.
    const scratch = await oc.createDrive({ name: "Scratch", quota: null });
    const next = `
spaces:
  - name: Finance
    quota: 200GB
    members: [{ group: finance, role: viewer }]
`;
    const r = await files.setConfig(parseConfig(next));
    expect(r).toMatchObject({ ok: true, created: [], updated: ["Finance"], disabled: ["Northwind rollout"] });
    expect(grants("Finance")).toEqual([
      [SERVICE_USER, "manager"],
      ["finance", "viewer"],
    ]);
    expect(fake.driveByName("Northwind rollout")!.disabled).toBe(true);
    expect(fake.drives.get(scratch.id)!.disabled).toBe(false);
    // Back in the file, the same space comes back with its files.
    const again = await files.setConfig(parseConfig(SPACES));
    expect(again).toMatchObject({ created: [], updated: expect.arrayContaining(["Northwind rollout"]) });
    expect(fake.driveByName("Northwind rollout")!.disabled).toBe(false);
    const off = await files.setConfig(parseConfig(SPACES.replace("kind: project", "kind: project\n    disabled: true")));
    expect(off.disabled).toEqual(["Northwind rollout"]);
  });

  it("shortens links made in OpenCloud's apps beyond links.maxDays, and flags those without a password", async () => {
    const { files, fake, db, user } = world();
    await files.setConfig(parseConfig(SPACES));
    const finance = fake.driveByName("Finance")!;
    const f = fake.put(finance.id, "Audit 2026/Trial balance 2026-09.xlsx", "tb");
    const forever = fake.addLink(user("emily.clark@example.com").id, f.fileId, { createdDateTime: "2026-11-01T09:00:00Z", password: "Secret-123" });
    const open = fake.addLink(user("mark.wilson@example.com").id, f.fileId, {
      expirationDateTime: "2026-11-10T23:59:59Z",
      displayName: "Anyone with the link",
    });
    const r = await files.syncNow();
    expect(r).toMatchObject({ ok: true, links: 1 });
    expect(forever.expirationDateTime).toBe("2027-01-30T09:00:00Z");
    expect(open.expirationDateTime).toBe("2026-11-10T23:59:59Z");
    const rows = db.prepare("SELECT id, by_email, problem, expires_at FROM links ORDER BY by_email").all();
    expect(rows).toEqual([
      { id: forever.id, by_email: "emily.clark@example.com", problem: null, expires_at: "2027-01-30T09:00:00Z" },
      { id: open.id, by_email: "mark.wilson@example.com", problem: "no-password", expires_at: "2026-11-10T23:59:59Z" },
    ]);
    // A link stopped in OpenCloud leaves the list at the next sync.
    fake.links.delete(open.id);
    await files.syncNow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM links").get()).toEqual({ n: 1 });
  });

  it("judges a link by when it was made", () => {
    const rules = { maxDays: 14, passwordRequired: false };
    const at = new Date(NOW);
    expect(judgeLink({ id: "l", createdDateTime: "2026-11-04T10:00:00Z", expirationDateTime: "2026-11-18T10:00:00Z" }, rules, at)).toEqual({
      shortenTo: null,
      problem: null,
    });
    expect(judgeLink({ id: "l", createdDateTime: "2026-11-04T10:00:00Z", expirationDateTime: null }, rules, at).shortenTo).toBe("2026-11-18T10:00:00Z");
    expect(judgeLink({ id: "l", link: { type: "view", webUrl: "" } }, { ...rules, passwordRequired: true }, at).problem).toBe("no-password");
  });

  it("removes from recycle bins what was deleted longer ago than bin.keepDays", async () => {
    const { files, fake, user, t } = world();
    await files.setConfig(parseConfig(SPACES));
    const finance = fake.driveByName("Finance")!;
    const own = fake.personalOf(user("mark.wilson@example.com").id)!;
    fake.trash
      .get(finance.id)!
      .set("old", { key: "old", location: "Q3 board deck v1.pptx", deletedAt: NOW - 31 * DAY, nodes: [fake.put(finance.id, "x", "1")] });
    fake.trash
      .get(finance.id)!
      .set("new", { key: "new", location: "Q3 board deck v2.pptx", deletedAt: NOW - 2 * DAY, nodes: [fake.put(finance.id, "y", "1")] });
    fake.trash.get(own.id)!.set("mine", { key: "mine", location: "Old CV.pdf", deletedAt: NOW - 40 * DAY, nodes: [fake.put(own.id, "z", "1")] });
    const r = await files.syncNow();
    expect(r.purged).toBe(2);
    expect([...fake.trash.get(finance.id)!.keys()]).toEqual(["new"]);
    expect(fake.trash.get(own.id)!.size).toBe(0);
    t.now += 29 * DAY;
    expect((await files.syncNow()).purged).toBe(1);
  });

  it("hands someone's own files to their manager on the day they leave", async () => {
    const { files, fake, user, t, db } = world();
    await files.setConfig(parseConfig(SPACES));
    const mark = user("mark.wilson@example.com");
    const own = fake.personalOf(mark.id)!;
    fake.put(own.id, "Customers/Northwind notes.docx", "notes");
    fake.put(own.id, "Expenses October.xlsx", "x".repeat(100));
    const h = await files.planHandover("emily.clark@example.com", { person: PEOPLE[MARK]!.email, manager: "emily.clark@example.com", on: "2026-11-30" });
    expect(h).toMatchObject({ status: "planned", on: "2026-11-30" });
    await files.syncNow();
    expect(fake.driveByName("Files of Mark Wilson")).toBeUndefined();

    t.now = Date.parse("2026-11-30T06:00:00Z");
    const r = await files.syncNow();
    expect(r.error).toBeNull();
    const handed = fake.driveByName("Files of Mark Wilson")!;
    expect([...fake.files.get(handed.id)!.keys()].sort()).toEqual(["", "Customers", "Customers/Northwind notes.docx", "Expenses October.xlsx"]);
    expect(fake.roleIn(handed.id, user("emily.clark@example.com").id)).toBe("manager");
    expect(fake.roleIn(handed.id, mark.id)).toBeUndefined();
    // Nothing went to the bin, and Mark can no longer sign in to OpenCloud.
    expect(fake.files.get(own.id)!.has("Expenses October.xlsx")).toBe(true);
    expect(fake.trash.get(own.id)!.size).toBe(0);
    expect(mark.accountEnabled).toBe(false);
    expect(db.prepare("SELECT status, bytes FROM handovers").get()).toEqual({ status: "done", bytes: 105 });
    // The handover's space is not the file's: later syncs leave it alone.
    await files.syncNow();
    expect(handed.disabled).toBe(false);
  });

  it("refuses a second plan for the same person, and keeps a failed handover to try again", async () => {
    const { files } = world();
    await files.setConfig(parseConfig(SPACES));
    const plan = { person: "nobody@example.com", manager: "emily.clark@example.com", on: "2026-11-04" };
    await files.planHandover("emily.clark@example.com", plan);
    await expect(files.planHandover("emily.clark@example.com", plan)).rejects.toThrow("already planned");
    expect(files.handovers()[0]).toMatchObject({
      status: "planned",
      error: "nobody@example.com has no OpenCloud account, so there are no files to hand over.",
    });
    await expect(files.planHandover("x", { person: "a@example.com", manager: "a@example.com" })).rejects.toThrow("someone other");
  });

  it("reports OpenCloud it cannot reach, and names the service account when it is refused", async () => {
    const { files, fake } = world();
    fake.state.down = true;
    const r = await files.setConfig(parseConfig(SPACES));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot be reached/);
    const wrong = fakeOpenCloud();
    const oc = createOpenCloud({ url: "http://opencloud:9200", user: SERVICE_USER, token: "wrong", fetch: wrong.fetch });
    await expect(oc.drives()).rejects.toThrow(/FILES_OPENCLOUD_USER/);
    expect(SPACE_ROLES.manager).toBe("312c0871-5ef7-4b3a-85b6-0e4074c64049");
  });
});
