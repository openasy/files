// What the routes call: the spaces and rules from the file, keeping OpenCloud in step with them, the links and the
// handovers, and a person's own files. The files stay in OpenCloud; Files keeps none of them. Everything a person does
// goes to OpenCloud as that person, so OpenCloud decides what they may see and change; Files adds its own rules on top
// (the link policy) and never passes on anything that manages OpenCloud.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_POLICY, type ConfigFileState, type FilesConfig } from "./config.ts";
import { log } from "./log.ts";
import { OpenCloudError, type DavEntry, type Drive, type OpenCloud, type OpenCloudClient, type Permission, type User } from "./opencloud.ts";
import { judgeLink, sync, tokenOf, type SyncResult } from "./sync.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "not-found"
  | "not-allowed"
  | "conflict"
  | "quota-exceeded"
  | "opencloud-unavailable"
  | "payload-too-large"
  | "internal-error";

export class FilesError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const DAY = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SpaceKind = "personal" | "team" | "project" | "other";

/** One of a person's spaces, as the Files page lists them. */
export interface MySpace {
  id: string;
  name: string;
  kind: SpaceKind;
  groups: string[];
  used: number;
  quota: number | null;
}

export interface Item {
  path: string;
  name: string;
  folder: boolean;
  size: number;
  modified: string | null;
  contentType: string | null;
  fileId: string | null;
  hasPreview: boolean;
  /** In at least one link to someone outside. */
  shared: boolean;
}

export interface LinkRow {
  id: string;
  driveId: string;
  space: string;
  itemId: string;
  item: string;
  folder: boolean;
  by: string;
  byName: string | null;
  for: string | null;
  kind: "download" | "upload" | "edit";
  password: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  url: string;
  opens: number;
  /** What the policy found wrong that Files could not fix: no-password. */
  problem: string | null;
}

export interface FilesOptions {
  /** The OpenCloud username of the service account. */
  serviceUser: string;
  /** The address people open OpenCloud at, for the sync apps. */
  openCloudUrl: string;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
}

/** OpenCloud's link types as the Links page names them: createOnly is a file drop, upload and edit can change files. */
const kindOfLink = (type: string): LinkRow["kind"] => (type === "createOnly" ? "upload" : type === "upload" || type === "edit" ? "edit" : "download");
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

export function createFiles(db: DatabaseSync, oc: OpenCloud, { serviceUser, openCloudUrl, clock = Date.now, fileState = () => null }: FilesOptions) {
  let config: FilesConfig = { policy: DEFAULT_POLICY, spaces: [] };
  let last: SyncResult | null = null;
  let drives: Drive[] = [];
  let running: Promise<SyncResult> | null = null;
  let again = false;
  const accounts = new Map<string, User>();
  const mine = new Map<string, { drives: Drive[]; until: number }>();

  const insert = db.prepare("INSERT INTO sync_runs (at, ok, created, updated, disabled, links, purged, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

  /** Brings OpenCloud in step with the file; a call while one runs makes it run once more after. */
  function syncNow(): Promise<SyncResult> {
    if (running) {
      again = true;
      return running;
    }
    running = sync({ db, oc, serviceUser, now: () => new Date(clock()) }, config)
      .then(({ drives: seen, ...r }) => {
        last = r;
        if (seen.length) drives = seen;
        // A handover disables the person's OpenCloud account: they are looked up again, and told so, next time.
        for (const h of db.prepare("SELECT person FROM handovers WHERE status = 'done'").all() as Array<{ person: string }>) {
          accounts.delete(h.person);
          mine.delete(h.person);
        }
        insert.run(r.at, r.ok ? 1 : 0, r.created.length, r.updated.length, r.disabled.length, r.links, r.purged, r.error);
        db.prepare("DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 100)").run();
        if (r.created.length || r.updated.length || r.disabled.length || r.links || r.purged)
          log("info", "OpenCloud updated from the file", { created: r.created, updated: r.updated, disabled: r.disabled, links: r.links, purged: r.purged });
        if (!r.ok) log("warn", "OpenCloud not fully in step; trying again in five minutes", { error: r.error });
        return r;
      })
      .finally(() => {
        running = null;
        if (again) ((again = false), void syncNow());
      });
    return running;
  }

  /** OpenCloud's failures as a problem the page can show; other errors go up as they are. */
  async function server<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof OpenCloudError)) throw err;
      if (err.status === 404) throw new FilesError(404, "not-found", "Not found, or not shared with you.");
      if (err.status === 403) throw new FilesError(403, "not-allowed", "OpenCloud does not let you do that here.");
      // WebDAV answers 405 to a folder that is already there, and 409 when the folder something goes in is not.
      if (err.status === 405 || err.status === 412) throw new FilesError(409, "conflict", "Something with that name is already there.");
      if (err.status === 409) throw new FilesError(409, "conflict", "The folder it goes in is not there: it may have been moved or deleted.");
      if (err.status === 507) throw new FilesError(507, "quota-exceeded", "The space is full: its quota is set in files.yaml.");
      if (err.status === 400) throw new FilesError(422, "invalid-body", err.message.replace(/^OpenCloud answered 400: /, ""));
      log("warn", "OpenCloud call failed", { error: err.message, status: err.status });
      throw new FilesError(502, "opencloud-unavailable", "OpenCloud did not answer; try again in a moment.");
    }
  }

  /** The person's OpenCloud account, made the way OpenCloud's own sign-in would when they have none yet. */
  async function account(email: string, name: string): Promise<User> {
    const key = email.toLowerCase();
    const hit = accounts.get(key);
    if (hit) return hit;
    let made = false;
    const u = await server(async () => (await oc.findUser(key)) ?? ((made = true), await oc.createUser(key, name || key)));
    if (u.accountEnabled === false) throw new FilesError(403, "not-allowed", "Your OpenCloud account is disabled.");
    accounts.set(key, u);
    // A new account joins the file's groups at the next sync; that sync runs now, so the spaces are there at once.
    if (made) await syncNow();
    return u;
  }

  async function as(email: string, name = ""): Promise<OpenCloudClient> {
    const u = await account(email, name);
    return server(() => oc.as(u.onPremisesSamAccountName));
  }

  /** The person's spaces, kept a minute; any call naming a space checks it is one of them. */
  async function myDrives(email: string, name = "", fresh = false): Promise<Drive[]> {
    const hit = mine.get(email);
    if (hit && hit.until > clock() && !fresh) return hit.drives;
    const c = await as(email, name);
    const list = (await server(() => c.myDrives())).filter(
      (d) => (d.driveType === "personal" || d.driveType === "project") && d.root?.deleted?.state !== "trashed",
    );
    mine.set(email, { drives: list, until: clock() + 60_000 });
    return list;
  }
  async function drive(email: string, driveId: string): Promise<{ c: OpenCloudClient; d: Drive }> {
    const d = (await myDrives(email)).find((x) => x.id === driveId) ?? (await myDrives(email, "", true)).find((x) => x.id === driveId);
    if (!d) throw new FilesError(404, "not-found", "No such space, or it is not shared with you.");
    return { c: await as(email), d };
  }

  const spaceRows = () =>
    new Map((db.prepare("SELECT name, drive_id FROM spaces").all() as Array<{ name: string; drive_id: string }>).map((r) => [r.drive_id, r.name]));
  function spaceOf(d: Drive, rows = spaceRows()): { kind: SpaceKind; groups: string[] } {
    if (d.driveType === "personal") return { kind: "personal", groups: [] };
    const s = config.spaces.find((x) => x.name.toLowerCase() === rows.get(d.id)?.toLowerCase());
    return s ? { kind: s.kind, groups: s.members.map((m) => m.group) } : { kind: "other", groups: [] };
  }

  function linkRows(where = "", ...args: string[]): LinkRow[] {
    const names = new Map(drives.map((d) => [d.id, d.driveType === "personal" ? `${d.owner?.user?.displayName ?? d.name} (personal)` : d.name]));
    const people = new Map((db.prepare("SELECT email, name FROM people").all() as Array<{ email: string; name: string }>).map((r) => [r.email, r.name]));
    return (
      db
        .prepare(
          `SELECT l.*, (SELECT COUNT(*) FROM link_opens o WHERE o.token = l.token AND o.success = 1) AS opens FROM links l ${where} ORDER BY COALESCE(l.expires_at, '9999') ASC`,
        )
        .all(...args) as Array<Record<string, string | number | null>>
    ).map((r) => ({
      id: String(r.id),
      driveId: String(r.drive_id),
      space: names.get(String(r.drive_id)) ?? "",
      itemId: String(r.item_id),
      item: String(r.item_name),
      folder: r.folder === 1,
      by: String(r.by_email),
      byName: people.get(String(r.by_email)) ?? null,
      for: (r.display_name as string | null) ?? null,
      kind: kindOfLink(String(r.type)),
      password: r.has_password === 1,
      createdAt: (r.created_at as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
      url: String(r.web_url),
      opens: Number(r.opens),
      problem: (r.problem as string | null) ?? null,
    }));
  }

  const toItem = (e: DavEntry): Item => ({
    path: e.path,
    name: e.name,
    folder: e.folder,
    size: e.size,
    modified: e.modified,
    contentType: e.contentType,
    fileId: e.fileId,
    hasPreview: e.hasPreview,
    shared: e.shareTypes.includes(3),
  });

  /** Records a person and the Identity groups their sign-in carried, for the file's groups in OpenCloud. */
  function rememberPerson(email: string, name: string, groups: string[]) {
    db.prepare(
      "INSERT INTO people (email, name, groups, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name, groups = excluded.groups, seen_at = excluded.seen_at",
    ).run(email.toLowerCase(), name, JSON.stringify(groups), new Date(clock()).toISOString());
  }

  return {
    /** Takes the file and starts bringing OpenCloud in step; the promise is that sync. */
    setConfig(next: FilesConfig): Promise<SyncResult> {
      config = next;
      return syncNow();
    },
    config: () => config,
    syncNow,
    lastSync: () => last,
    rememberPerson,

    summary() {
      const now = clock();
      const working = linkRows().filter((l) => !l.expiresAt || Date.parse(l.expiresAt) >= now);
      return {
        spaces: config.spaces.length,
        disabled: config.spaces.filter((s) => s.disabled).length,
        personal: drives.filter((d) => d.driveType === "personal").length,
        stored: drives.reduce((n, d) => n + (d.quota?.used ?? 0), 0),
        file: fileState(),
        sync: last,
        policy: config.policy,
        openCloudUrl,
        links: {
          working: working.length,
          expiringThisWeek: working.filter((l) => l.expiresAt && Date.parse(l.expiresAt) < now + 7 * DAY).length,
          withoutPassword: working.filter((l) => !l.password).length,
          openedThisWeek: (
            db.prepare("SELECT COUNT(*) AS n FROM link_opens WHERE success = 1 AND at >= ?").get(new Date(now - 7 * DAY).toISOString()) as { n: number }
          ).n,
        },
        handoversPlanned: (db.prepare("SELECT COUNT(*) AS n FROM handovers WHERE status = 'planned'").get() as { n: number }).n,
      };
    },

    /** The spaces of the file, with what OpenCloud says about each at the last sync. */
    spaceList() {
      const rows = new Map(
        (db.prepare("SELECT name, drive_id FROM spaces").all() as Array<{ name: string; drive_id: string }>).map((r) => [r.name.toLowerCase(), r.drive_id]),
      );
      const byId = new Map(drives.map((d) => [d.id, d]));
      const links = db
        .prepare("SELECT drive_id, COUNT(*) AS n FROM links WHERE expires_at IS NULL OR expires_at >= ? GROUP BY drive_id")
        .all(new Date(clock()).toISOString()) as Array<{
        drive_id: string;
        n: number;
      }>;
      const linkCount = new Map(links.map((l) => [l.drive_id, l.n]));
      return config.spaces.map((s) => {
        const d = byId.get(rows.get(s.name.toLowerCase()) ?? "");
        return {
          ...s,
          driveId: d?.id ?? null,
          used: d?.quota?.used ?? null,
          state: !d ? "pending" : d.root?.deleted?.state === "trashed" ? "disabled" : "active",
          links: d ? (linkCount.get(d.id) ?? 0) : 0,
        };
      });
    },

    // ---- handovers

    handovers() {
      return (db.prepare("SELECT * FROM handovers ORDER BY on_date ASC").all() as Array<Record<string, string | number | null>>).map((r) => ({
        id: String(r.id),
        person: String(r.person),
        manager: String(r.manager),
        on: String(r.on_date),
        status: r.status as "planned" | "done" | "cancelled",
        createdBy: String(r.created_by),
        createdAt: String(r.created_at),
        doneAt: (r.done_at as string | null) ?? null,
        driveId: (r.drive_id as string | null) ?? null,
        bytes: (r.bytes as number | null) ?? null,
        error: (r.error as string | null) ?? null,
      }));
    },
    async planHandover(by: string, body: unknown) {
      const b = (body ?? {}) as { person?: unknown; manager?: unknown; on?: unknown };
      const person = typeof b.person === "string" ? b.person.trim().toLowerCase() : "";
      const manager = typeof b.manager === "string" ? b.manager.trim().toLowerCase() : "";
      const on = typeof b.on === "string" && DATE.test(b.on) && !Number.isNaN(Date.parse(b.on)) ? b.on : today(clock());
      if (!EMAIL.test(person) || !EMAIL.test(manager))
        throw new FilesError(422, "invalid-body", "person and manager are email addresses, such as mark.wilson@example.com.");
      if (person === manager) throw new FilesError(422, "invalid-body", "The manager is someone other than the person who leaves.");
      if (b.on !== undefined && on !== b.on) throw new FilesError(422, "invalid-body", "on is a date, such as 2026-11-30.");
      if (db.prepare("SELECT 1 FROM handovers WHERE person = ? AND status = 'planned'").get(person))
        throw new FilesError(409, "conflict", `A handover of ${person}'s files is already planned.`);
      const id = randomUUID();
      db.prepare("INSERT INTO handovers (id, person, manager, on_date, status, created_by, created_at) VALUES (?, ?, ?, ?, 'planned', ?, ?)").run(
        id,
        person,
        manager,
        on,
        by,
        new Date(clock()).toISOString(),
      );
      log("info", "handover planned", { person, manager, on, by });
      // A handover for today runs now, with the sync.
      if (on <= today(clock())) await syncNow();
      return this.handovers().find((h) => h.id === id)!;
    },
    cancelHandover(id: string, by: string) {
      if (db.prepare("UPDATE handovers SET status = 'cancelled' WHERE id = ? AND status = 'planned'").run(id).changes === 0)
        throw new FilesError(404, "not-found", "No planned handover with that id.");
      log("info", "handover cancelled", { id, by });
    },

    // ---- links

    /** Every link to someone outside for viewers and up; the person's own links for everyone else. */
    links(email: string, all: boolean) {
      return { links: all ? linkRows() : linkRows("WHERE l.by_email = ?", email.toLowerCase()), policy: config.policy.links };
    },
    opens(email: string, all: boolean, id: string) {
      const row = db.prepare("SELECT token, by_email FROM links WHERE id = ?").get(id) as { token: string; by_email: string } | undefined;
      if (!row || (!all && row.by_email !== email.toLowerCase())) throw new FilesError(404, "not-found", "No such link.");
      return {
        opens: (
          db.prepare("SELECT at, success FROM link_opens WHERE token = ? ORDER BY at DESC LIMIT 200").all(row.token) as Array<{ at: string; success: number }>
        ).map((o) => ({
          at: o.at,
          success: o.success === 1,
        })),
      };
    },
    /** Stops a link: its maker may, and so may editors and up. It is removed in OpenCloud as its maker. */
    async stopLink(email: string, mayAll: boolean, id: string) {
      const row = db.prepare("SELECT drive_id, item_id, by_email FROM links WHERE id = ?").get(id) as
        { drive_id: string; item_id: string; by_email: string } | undefined;
      if (!row || (!mayAll && row.by_email !== email.toLowerCase())) throw new FilesError(404, "not-found", "No such link.");
      const c = await as(row.by_email);
      await server(() => c.deletePermission(row.drive_id, row.item_id, id));
      db.prepare("DELETE FROM links WHERE id = ?").run(id);
      log("info", "link stopped", { link: id, by: email, maker: row.by_email });
    },

    // ---- a person's own files

    /** The signed-in person's spaces and the rules that apply to them. */
    async me(email: string, name: string) {
      const list = await myDrives(email.toLowerCase(), name, true);
      const rows = spaceRows();
      const spaces: MySpace[] = list.map((d) => ({
        id: d.id,
        name: d.driveType === "personal" ? "My files" : d.name,
        ...spaceOf(d, rows),
        used: d.quota?.used ?? 0,
        quota: d.quota?.total || null,
      }));
      const order: SpaceKind[] = ["personal", "team", "project", "other"];
      spaces.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
      return { email: email.toLowerCase(), name, openCloudUrl, policy: config.policy, spaces };
    },
    async list(email: string, driveId: string, path: string) {
      const { c } = await drive(email, driveId);
      const all = await server(() => c.list(driveId, path));
      const [self, ...items] = all;
      if (!self?.folder) throw new FilesError(404, "not-found", "Not a folder.");
      return { path: self.path, items: items.map(toItem) };
    },
    async download(email: string, driveId: string, path: string) {
      const { c } = await drive(email, driveId);
      return server(() => c.download(driveId, path));
    },
    async preview(email: string, driveId: string, path: string) {
      const { c } = await drive(email, driveId);
      return server(() => c.preview(driveId, path));
    },
    async upload(email: string, driveId: string, path: string, body: ReadableStream, length: number, type: string) {
      const { c } = await drive(email, driveId);
      await server(() => c.upload(driveId, path, body, length, type));
      log("info", "file uploaded", { by: email, drive: driveId, size: length });
    },
    async mkdir(email: string, driveId: string, path: string) {
      const { c } = await drive(email, driveId);
      await server(() => c.mkdir(driveId, path));
    },
    async remove(email: string, driveId: string, path: string) {
      if (!path.replace(/\//g, "")) throw new FilesError(422, "invalid-body", "path names a file or folder in the space, not the space itself.");
      const { c } = await drive(email, driveId);
      await server(() => c.remove(driveId, path));
    },
    async versions(email: string, driveId: string, fileId: string) {
      const { c } = await drive(email, driveId);
      return { versions: await server(() => c.versions(fileId)) };
    },
    async restoreVersion(email: string, driveId: string, body: unknown) {
      const b = (body ?? {}) as { fileId?: unknown; key?: unknown; path?: unknown };
      if (typeof b.fileId !== "string" || typeof b.key !== "string" || typeof b.path !== "string")
        throw new FilesError(422, "invalid-body", "fileId, key and path name the version to bring back.");
      const { c } = await drive(email, driveId);
      await server(() => c.restoreVersion(b.fileId as string, b.key as string, driveId, b.path as string));
    },

    /** The links on one item, as OpenCloud has them now. */
    async itemLinks(email: string, driveId: string, itemId: string) {
      const { c } = await drive(email, driveId);
      const perms = (await server(() => c.itemPermissions(driveId, itemId))).filter((p) => p.link && p.link.type !== "internal");
      return {
        links: perms.map((p) => ({
          id: p.id,
          for: p.link!["@libre.graph.displayName"] ?? null,
          kind: kindOfLink(p.link!.type),
          password: !!p.hasPassword,
          expiresAt: p.expirationDateTime ?? null,
          url: p.link!.webUrl,
        })),
        policy: config.policy.links,
      };
    },
    /** A link to someone outside, within the file's rules: it always expires, at most links.maxDays from today. */
    async createLink(email: string, driveId: string, body: unknown) {
      const b = (body ?? {}) as { itemId?: unknown; name?: unknown; kind?: unknown; for?: unknown; password?: unknown; expires?: unknown; folder?: unknown };
      const { links: rules } = config.policy;
      if (typeof b.itemId !== "string" || !b.itemId) throw new FilesError(422, "invalid-body", "itemId names the file or folder to share.");
      if (b.kind !== undefined && b.kind !== "download" && b.kind !== "upload") throw new FilesError(422, "invalid-body", "kind is download or upload.");
      if (b.for !== undefined && (typeof b.for !== "string" || b.for.length > 128)) throw new FilesError(422, "invalid-body", "for is up to 128 characters.");
      const password = typeof b.password === "string" && b.password ? b.password : undefined;
      if (rules.passwordRequired && !password) throw new FilesError(422, "invalid-body", "Links need a password: links.passwordRequired is set in files.yaml.");
      const now = clock();
      const latest = today(now + rules.maxDays * DAY);
      const expires = b.expires === undefined ? latest : typeof b.expires === "string" && DATE.test(b.expires) ? b.expires : "";
      if (!expires || Number.isNaN(Date.parse(expires))) throw new FilesError(422, "invalid-body", "expires is a date, such as 2026-11-18.");
      if (expires < today(now)) throw new FilesError(422, "invalid-body", "expires is today or later.");
      if (expires > latest)
        throw new FilesError(422, "invalid-body", `A link lasts at most ${rules.maxDays} days, until ${latest}: links.maxDays is set in files.yaml.`);
      const { c, d } = await drive(email, driveId);
      const link: Permission = await server(() =>
        c.createLink(driveId, b.itemId as string, {
          type: b.kind === "upload" ? "createOnly" : "view",
          ...(typeof b.for === "string" && b.for.trim() && { displayName: b.for.trim() }),
          ...(password && { password }),
          expirationDateTime: `${expires}T23:59:59Z`,
        }),
      );
      const { problem } = judgeLink(link, rules, new Date(now));
      db.prepare(
        `INSERT INTO links (id, drive_id, item_id, item_name, folder, by_email, display_name, type, has_password, created_at, expires_at, web_url, token, problem, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      ).run(
        link.id,
        d.id,
        b.itemId,
        typeof b.name === "string" ? b.name.slice(0, 255) : "",
        b.folder === true ? 1 : 0,
        email.toLowerCase(),
        link.link?.["@libre.graph.displayName"] ?? null,
        link.link?.type ?? "view",
        link.hasPassword ? 1 : 0,
        link.createdDateTime ?? new Date(now).toISOString(),
        link.expirationDateTime ?? null,
        link.link?.webUrl ?? "",
        tokenOf(link.link?.webUrl ?? ""),
        problem,
        new Date(now).toISOString(),
      );
      log("info", "link made", { by: email, drive: driveId, item: b.itemId, kind: b.kind ?? "download", expires });
      return {
        id: link.id,
        for: link.link?.["@libre.graph.displayName"] ?? null,
        kind: kindOfLink(link.link?.type ?? "view"),
        password: !!link.hasPassword,
        expiresAt: link.expirationDateTime ?? null,
        url: link.link?.webUrl ?? "",
      };
    },

    /** What was deleted in the person's spaces, and until when it is kept. */
    async bin(email: string) {
      const list = await myDrives(email.toLowerCase(), "", true);
      const c = await as(email);
      const rows = spaceRows();
      const keep = config.policy.bin.keepDays;
      const items = [];
      for (const d of list) {
        let trash;
        try {
          trash = await c.trash(d.id);
        } catch (err) {
          // Viewers of a space cannot see its recycle bin.
          if (err instanceof OpenCloudError && (err.status === 403 || err.status === 404)) continue;
          return server(() => Promise.reject(err));
        }
        for (const t of trash)
          items.push({
            driveId: d.id,
            space: d.driveType === "personal" ? "My files" : d.name,
            kind: spaceOf(d, rows).kind,
            key: t.key,
            name: t.name,
            location: t.location,
            folder: t.folder,
            size: t.size,
            deletedAt: t.deletedAt,
            keptUntil: t.deletedAt ? new Date(Date.parse(t.deletedAt) + keep * DAY).toISOString() : null,
          });
      }
      items.sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
      const leaving = this.handovers()
        .filter((h) => h.status === "planned")
        .map((h) => ({ person: h.person, manager: h.manager, on: h.on }));
      return { items, keepDays: keep, leaving };
    },
    async restore(email: string, body: unknown) {
      const b = (body ?? {}) as { driveId?: unknown; key?: unknown; location?: unknown };
      if (typeof b.driveId !== "string" || typeof b.key !== "string" || typeof b.location !== "string" || !/^[\w=+.-]+$/.test(b.key))
        throw new FilesError(422, "invalid-body", "driveId, key and location name the item to bring back.");
      const { c } = await drive(email, b.driveId);
      await server(() => c.restoreTrash(b.driveId as string, b.key as string, b.location as string));
    },

    /** 1 when OpenCloud answers the service account. */
    async reachable(): Promise<boolean> {
      try {
        await oc.ping();
        return true;
      } catch {
        return false;
      }
    },

    gauges() {
      const s = this.summary();
      return {
        spaces: s.spaces,
        stored: s.stored,
        syncOk: last ? last.ok : null,
        links: s.links.working,
        linksWithoutPassword: s.links.withoutPassword,
        handovers: s.handoversPlanned,
      };
    },
  };
}

export type Files = ReturnType<typeof createFiles>;
