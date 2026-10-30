// Makes OpenCloud match the file. Each space of the file is an OpenCloud project space with its name, description and
// quota, open to its Identity groups with their roles and to nobody else; people's own spaces get the personal quota.
// A space taken out of the file is disabled, never deleted, so its files stay until an admin deletes it in OpenCloud.
// Spaces Files did not make, such as handovers and spaces made in OpenCloud by hand, are left alone.
//
// The same run applies the rules for links and the recycle bin to what people did in OpenCloud's own apps: a link that
// lasts longer than links.maxDays is shortened, one without a password where the file asks for one is flagged, and
// what has been in a recycle bin longer than bin.keepDays is removed.
import type { DatabaseSync } from "node:sqlite";
import type { FilesConfig, Policy, Space } from "./config.ts";
import { OpenCloudError, SPACE_ROLES, type Drive, type OpenCloud, type Permission } from "./opencloud.ts";

export interface SyncResult {
  at: string;
  ok: boolean;
  /** Spaces made in OpenCloud. */
  created: string[];
  /** Spaces whose name, description, quota, state or members changed, and personal quotas set. */
  updated: string[];
  /** Spaces disabled because they left the file or are disabled in it. */
  disabled: string[];
  /** Links made longer than the policy allows, shortened to it. */
  links: number;
  /** Items removed from recycle bins after bin.keepDays. */
  purged: number;
  error: string | null;
}

export interface SyncContext {
  db: DatabaseSync;
  oc: OpenCloud;
  /** The OpenCloud username of the service account, whose own grant as each space's maker stays. */
  serviceUser: string;
  now: () => Date;
}

const DAY = 86_400_000;
const roleName = (id: string | undefined) => (Object.entries(SPACE_ROLES).find(([, v]) => v === id)?.[0] ?? "") as keyof typeof SPACE_ROLES | "";
const isDisabled = (d: Drive) => d.root?.deleted?.state === "trashed";

/** The token at the end of a link's address, which OpenCloud's audit log names when the link is opened. */
export const tokenOf = (webUrl: string) => webUrl.replace(/\/$/, "").split("/").at(-1) ?? "";

/** Brings one space's group grants in step: the file's groups with their roles, and no other group or person. */
async function members(ctx: SyncContext, driveId: string, space: Space, groupIds: Map<string, string>, serviceId: string): Promise<boolean> {
  const { oc } = ctx;
  let changed = false;
  const have = await oc.rootPermissions(driveId);
  const wanted = new Map(space.members.map((m) => [groupIds.get(m.group.toLowerCase())!, m.role]));
  for (const p of have) {
    const group = p.grantedToV2?.group?.id;
    const user = p.grantedToV2?.user?.id;
    if (group && wanted.has(group)) {
      if (roleName(p.roles?.[0]) !== wanted.get(group)) ((changed = true), await oc.setRole(driveId, p.id, SPACE_ROLES[wanted.get(group)!]));
      wanted.delete(group);
    } else if ((group || user) && user !== serviceId) {
      changed = true;
      await oc.removePermission(driveId, p.id);
    }
  }
  for (const [group, role] of wanted) ((changed = true), await oc.invite(driveId, { objectId: group, type: "group" }, SPACE_ROLES[role]));
  return changed;
}

/**
 * People whose links and recycle bin the run looks at: the file's groups' members, and everyone who signed in to Files
 * and has an OpenCloud account. Someone without one has no files yet.
 */
async function peopleToScan(ctx: SyncContext, groupMembers: string[]): Promise<string[]> {
  const known = (ctx.db.prepare("SELECT email FROM people").all() as Array<{ email: string }>).map((r) => r.email.toLowerCase());
  const out = new Set(groupMembers.map((e) => e.toLowerCase()));
  for (const e of known) if (!out.has(e) && (await ctx.oc.findUser(e))) out.add(e);
  out.delete(ctx.serviceUser.toLowerCase());
  return [...out];
}

/** What the policy makes of one link: the expiry to shorten it to, and a problem to show. */
export function judgeLink(p: Permission, policy: Policy["links"], now: Date): { shortenTo: string | null; problem: string | null } {
  const created = p.createdDateTime ? Date.parse(p.createdDateTime) : now.getTime();
  const latest = new Date(Math.max(created, 0) + policy.maxDays * DAY);
  const expires = p.expirationDateTime ? Date.parse(p.expirationDateTime) : Infinity;
  const shortenTo = expires > latest.getTime() + 60_000 ? latest.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  const problem = policy.passwordRequired && !p.hasPassword && p.link?.type !== "internal" ? "no-password" : null;
  return { shortenTo, problem };
}

/** Links of the people scanned, shortened where they last too long, into the links table. Returns how many were shortened. */
async function links(ctx: SyncContext, policy: Policy, people: string[], problems: string[]): Promise<number> {
  const { db, oc } = ctx;
  let shortened = 0;
  const now = ctx.now();
  const upsert =
    db.prepare(`INSERT INTO links (id, drive_id, item_id, item_name, folder, by_email, display_name, type, has_password, created_at, expires_at, web_url, token, problem, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET item_name = excluded.item_name, display_name = excluded.display_name, type = excluded.type, has_password = excluded.has_password,
      expires_at = excluded.expires_at, problem = excluded.problem, seen_at = excluded.seen_at`);
  for (const email of people) {
    try {
      const as = await oc.as(email);
      const seen = now.toISOString();
      const ids: string[] = [];
      for (const item of await as.sharedByMe()) {
        const driveId = item.parentReference?.driveId;
        if (!driveId) continue;
        for (const p of item.permissions ?? []) {
          if (!p.link || p.link.type === "internal") continue;
          const { shortenTo, problem } = judgeLink(p, policy.links, now);
          let expires = p.expirationDateTime ?? null;
          if (shortenTo) {
            await as.updatePermission(driveId, item.id, p.id, { expirationDateTime: shortenTo });
            expires = shortenTo;
            shortened++;
          }
          ids.push(p.id);
          upsert.run(
            p.id,
            driveId,
            item.id,
            item.name,
            item.folder ? 1 : 0,
            email,
            p.link["@libre.graph.displayName"] ?? null,
            p.link.type,
            p.hasPassword ? 1 : 0,
            p.createdDateTime ?? null,
            expires,
            p.link.webUrl,
            tokenOf(p.link.webUrl),
            problem,
            seen,
          );
        }
      }
      // Links this person no longer has are gone from OpenCloud.
      const gone = (db.prepare("SELECT id FROM links WHERE by_email = ?").all(email) as Array<{ id: string }>).filter((r) => !ids.includes(r.id));
      for (const r of gone) db.prepare("DELETE FROM links WHERE id = ?").run(r.id);
    } catch (err) {
      if (!(err instanceof OpenCloudError)) throw err;
      problems.push(`links of ${email}: ${err.message}`);
    }
  }
  return shortened;
}

/** Removes from a space's recycle bin what was deleted more than keepDays ago. */
async function purge(
  client: { trash: (d: string) => Promise<Array<{ key: string; deletedAt: string | null }>>; purgeTrash: (d: string, k: string) => Promise<void> },
  driveId: string,
  keepDays: number,
  now: Date,
) {
  let n = 0;
  for (const t of await client.trash(driveId)) {
    if (t.deletedAt && Date.parse(t.deletedAt) < now.getTime() - keepDays * DAY) ((n += 1), await client.purgeTrash(driveId, t.key));
  }
  return n;
}

/**
 * Someone leaves: a space "Files of <name>" is made with their manager as its manager, their own files are copied into
 * it as them, and their OpenCloud account is disabled. Their own space stays as it was, so nothing goes to the bin.
 */
export async function handOver(ctx: SyncContext, person: string, manager: string, on: string): Promise<{ driveId: string; bytes: number }> {
  const { oc } = ctx;
  const leaver = await oc.findUser(person);
  if (!leaver) throw new OpenCloudError(`${person} has no OpenCloud account, so there are no files to hand over.`, 404);
  const to = await oc.findUser(manager);
  if (!to) throw new OpenCloudError(`${manager} has no OpenCloud account yet; they open Files once, then the handover runs.`, 404);
  const drive = await oc.createDrive({ name: `Files of ${leaver.displayName}`, description: `${person}'s own files, handed over on ${on}.`, quota: null });
  await oc.invite(drive.id, { objectId: to.id, type: "user" }, SPACE_ROLES.manager);
  await oc.invite(drive.id, { objectId: leaver.id, type: "user" }, SPACE_ROLES.editor);
  const as = await oc.as(leaver.onPremisesSamAccountName);
  const own = (await as.myDrives()).find((d) => d.driveType === "personal");
  let bytes = 0;
  if (own) {
    for (const e of (await as.list(own.id, "")).filter((x) => x.path && !x.path.includes("/"))) {
      await as.copy(own.id, e.path, drive.id, e.name);
      bytes += e.size;
    }
  }
  const grant = (await oc.rootPermissions(drive.id)).find((p) => p.grantedToV2?.user?.id === leaver.id);
  if (grant) await oc.removePermission(drive.id, grant.id);
  await oc.disableUser(leaver.id);
  return { driveId: drive.id, bytes };
}

export async function sync(ctx: SyncContext, config: FilesConfig): Promise<SyncResult & { drives: Drive[] }> {
  const { db, oc } = ctx;
  const now = ctx.now();
  const result: SyncResult & { drives: Drive[] } = {
    at: now.toISOString(),
    ok: false,
    created: [],
    updated: [],
    disabled: [],
    links: 0,
    purged: 0,
    error: null,
    drives: [],
  };
  const problems: string[] = [];
  try {
    const service = await oc.me();

    // Groups by name, made in OpenCloud when nobody of them has signed in there yet.
    const groupIds = new Map<string, string>();
    for (const name of new Set(config.spaces.flatMap((s) => s.members.map((m) => m.group)))) {
      const g = (await oc.findGroup(name)) ?? (await oc.createGroup(name));
      groupIds.set(name.toLowerCase(), g.id);
    }

    // People who signed in to Files are put in the file's groups that Identity says they are in.
    const people = db.prepare("SELECT email, groups FROM people").all() as Array<{ email: string; groups: string }>;
    const memberEmails: string[] = [];
    for (const [name, gid] of groupIds) {
      const inGroup = new Map((await oc.groupMembers(gid)).map((u) => [u.onPremisesSamAccountName.toLowerCase(), u.id]));
      memberEmails.push(...inGroup.keys());
      for (const p of people) {
        const should = (JSON.parse(p.groups) as string[]).some((g) => g.toLowerCase() === name);
        const has = inGroup.has(p.email);
        if (should === has) continue;
        const u = has ? { id: inGroup.get(p.email)! } : await oc.findUser(p.email);
        if (!u) continue;
        if (should) await oc.addMember(gid, u.id);
        else await oc.removeMember(gid, u.id);
      }
    }

    let drives = await oc.drives();
    const byId = new Map(drives.map((d) => [d.id, d]));
    const known = new Map(
      (db.prepare("SELECT name, drive_id FROM spaces").all() as Array<{ name: string; drive_id: string }>).map((r) => [r.name.toLowerCase(), r.drive_id]),
    );
    const remember = db.prepare(
      "INSERT INTO spaces (name, drive_id, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET drive_id = excluded.drive_id",
    );
    const ours = new Set<string>();
    const active = new Set<string>();

    for (const s of config.spaces) {
      let d = byId.get(known.get(s.name.toLowerCase()) ?? "");
      // A space of the same name made before Files kept its id, such as by an earlier install, is taken over.
      d ??= drives.find((x) => x.driveType === "project" && x.name === s.name && ![...known.values()].includes(x.id));
      if (!d) {
        d = await oc.createDrive({ name: s.name, description: s.description, quota: s.quota });
        result.created.push(s.name);
      }
      remember.run(s.name, d.id, now.toISOString());
      ours.add(d.id);
      if (s.disabled) {
        if (!isDisabled(d)) (await oc.disableDrive(d.id), result.disabled.push(s.name));
        continue;
      }
      active.add(d.id);
      let changed = false;
      if (isDisabled(d)) ((changed = true), await oc.enableDrive(d.id));
      const patch: Record<string, unknown> = {};
      if (d.name !== s.name) patch.name = s.name;
      if ((d.description || null) !== s.description) patch.description = s.description ?? "";
      if (s.quota !== null && d.quota?.total !== s.quota) patch.quota = { total: s.quota };
      if (Object.keys(patch).length) ((changed = true), await oc.updateDrive(d.id, patch));
      if (await members(ctx, d.id, s, groupIds, service.id)) changed = true;
      if (changed && !result.created.includes(s.name)) result.updated.push(s.name);
    }

    // What is left are spaces Files made that the file no longer lists.
    for (const [name, id] of known) {
      const d = byId.get(id);
      if (ours.has(id) || !d || isDisabled(d)) continue;
      await oc.disableDrive(id);
      result.disabled.push(d.name || name);
    }

    if (config.policy.personal.quota !== null) {
      for (const d of drives.filter((x) => x.driveType === "personal" && !isDisabled(x) && x.quota?.total !== config.policy.personal.quota)) {
        await oc.updateDrive(d.id, { quota: { total: config.policy.personal.quota } });
        result.updated.push(`${d.owner?.user?.displayName ?? d.name} (personal)`);
      }
    }

    // The files of the file's spaces, as their maker, and of each person's own space, as them.
    for (const id of active) {
      try {
        result.purged += await purge(oc.service, id, config.policy.bin.keepDays, now);
      } catch (err) {
        if (!(err instanceof OpenCloudError)) throw err;
        problems.push(`recycle bin of ${byId.get(id)?.name ?? id}: ${err.message}`);
      }
    }
    const scan = await peopleToScan(ctx, memberEmails);
    for (const email of scan) {
      try {
        const as = await oc.as(email);
        const own = (await as.myDrives()).find((d) => d.driveType === "personal");
        if (own) result.purged += await purge(as, own.id, config.policy.bin.keepDays, now);
      } catch (err) {
        if (!(err instanceof OpenCloudError)) throw err;
        problems.push(`recycle bin of ${email}: ${err.message}`);
      }
    }
    result.links = await links(ctx, config.policy, scan, problems);

    // Handovers whose day has come.
    const due = db
      .prepare("SELECT id, person, manager, on_date FROM handovers WHERE status = 'planned' AND on_date <= ?")
      .all(now.toISOString().slice(0, 10)) as Array<{
      id: string;
      person: string;
      manager: string;
      on_date: string;
    }>;
    for (const h of due) {
      try {
        const r = await handOver(ctx, h.person, h.manager, h.on_date);
        db.prepare("UPDATE handovers SET status = 'done', done_at = ?, drive_id = ?, bytes = ?, error = NULL WHERE id = ?").run(
          now.toISOString(),
          r.driveId,
          r.bytes,
          h.id,
        );
      } catch (err) {
        if (!(err instanceof OpenCloudError)) throw err;
        db.prepare("UPDATE handovers SET error = ? WHERE id = ?").run(err.message, h.id);
        problems.push(`handover of ${h.person}: ${err.message}`);
      }
    }

    drives = await oc.drives();
    result.drives = drives;
    result.ok = problems.length === 0;
    result.error = problems.length ? problems.join("; ") : null;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}
