// OpenCloud in memory for tests, answering the LibreGraph, WebDAV and auth-app calls Files makes the way OpenCloud 7.2
// does. Given to createOpenCloud() as its fetch, so the real client code runs against it. It implements only what Files
// calls, with OpenCloud's rules where Files relies on them: who may see and change a space, and that a deleted space is
// disabled unless the Purge header is sent.
import { SPACE_ROLES } from "./opencloud.ts";

export const SERVICE_USER = "admin";
export const SERVICE_TOKEN = "service-app-token";
export const PUBLIC = "https://cloud.example.com";

type RoleName = keyof typeof SPACE_ROLES;
const ROLE_OF = Object.fromEntries(Object.entries(SPACE_ROLES).map(([k, v]) => [v, k as RoleName]));

interface FakeUser {
  id: string;
  displayName: string;
  mail: string;
  onPremisesSamAccountName: string;
  accountEnabled: boolean;
}
interface Grant {
  id: string;
  kind: "user" | "group";
  objectId: string;
  role: RoleName;
}
interface FakeDrive {
  id: string;
  name: string;
  driveType: "personal" | "project";
  description?: string;
  ownerId?: string;
  quota?: number;
  disabled: boolean;
  grants: Grant[];
}
interface Node {
  path: string;
  folder: boolean;
  data: Buffer;
  type: string;
  modified: number;
  fileId: string;
  versions: Array<{ key: string; data: Buffer; modified: number }>;
}
interface Trashed {
  key: string;
  location: string;
  deletedAt: number;
  nodes: Node[];
}
interface Link {
  id: string;
  driveId: string;
  itemId: string;
  by: string;
  type: string;
  displayName?: string;
  password?: string;
  expirationDateTime: string | null;
  createdDateTime: string;
  token: string;
}

export function fakeOpenCloud({ clock = Date.now }: { clock?: () => number } = {}) {
  let next = 0;
  const id = (p = "") => `${p}${(++next).toString(36).padStart(4, "0")}`;
  const users = new Map<string, FakeUser>();
  const groups = new Map<string, { id: string; displayName: string; members: Set<string> }>();
  const drives = new Map<string, FakeDrive>();
  const files = new Map<string, Map<string, Node>>();
  const trash = new Map<string, Map<string, Trashed>>();
  const links = new Map<string, Link>();
  const appTokens = new Map<string, string>();
  /** Every request, with who made it: the service account or the person it was made for. */
  const calls: Array<{ as: string; method: string; path: string }> = [];
  const state = { down: false, impersonation: true };

  const admin: FakeUser = { id: "u-admin", displayName: "Admin", mail: "", onPremisesSamAccountName: SERVICE_USER, accountEnabled: true };
  users.set(admin.id, admin);

  function makeDrive(d: Omit<FakeDrive, "id" | "disabled" | "grants"> & { grants?: Grant[] }): FakeDrive {
    const drive: FakeDrive = { id: `storage$${id("sp-")}`, disabled: false, grants: [], ...d };
    drives.set(drive.id, drive);
    files.set(
      drive.id,
      new Map([["", { path: "", folder: true, data: Buffer.alloc(0), type: "", modified: clock(), fileId: `${drive.id}!root`, versions: [] }]]),
    );
    trash.set(drive.id, new Map());
    return drive;
  }

  function addUser(email: string, displayName: string): FakeUser {
    const u: FakeUser = { id: id("u-"), displayName, mail: email, onPremisesSamAccountName: email, accountEnabled: true };
    users.set(u.id, u);
    // OpenCloud makes a person's own space at their first request; here it comes with the account.
    makeDrive({ name: displayName, driveType: "personal", ownerId: u.id });
    return u;
  }
  const userByName = (name: string) => [...users.values()].find((u) => u.onPremisesSamAccountName === name);
  const personalOf = (userId: string) => [...drives.values()].find((d) => d.driveType === "personal" && d.ownerId === userId);

  /** The role a user has in a space, or undefined. */
  function roleIn(d: FakeDrive, userId: string): RoleName | undefined {
    if (d.disabled) return undefined;
    if (d.driveType === "personal") return d.ownerId === userId ? "manager" : undefined;
    const order: RoleName[] = ["viewer", "editor", "manager"];
    let best: RoleName | undefined;
    for (const g of d.grants) {
      const hit = g.kind === "user" ? g.objectId === userId : !!groups.get(g.objectId)?.members.has(userId);
      if (hit && (!best || order.indexOf(g.role) > order.indexOf(best))) best = g.role;
    }
    return best;
  }

  const used = (driveId: string) => [...files.get(driveId)!.values()].reduce((n, f) => n + f.data.length, 0);
  const driveJson = (d: FakeDrive) => ({
    id: d.id,
    name: d.name,
    driveType: d.driveType,
    ...(d.description && { description: d.description }),
    ...(d.ownerId && { owner: { user: { id: d.ownerId, displayName: users.get(d.ownerId)?.displayName } } }),
    quota: { used: used(d.id), ...(d.quota !== undefined && { total: d.quota, remaining: d.quota - used(d.id) }), state: "normal" },
    root: { id: `${d.id}!root`, ...(d.disabled && { deleted: { state: "trashed" } }) },
  });
  const permJson = (g: Grant) => ({
    id: g.id,
    roles: [SPACE_ROLES[g.role]],
    grantedToV2:
      g.kind === "user"
        ? { user: { id: g.objectId, displayName: users.get(g.objectId)?.displayName } }
        : { group: { id: g.objectId, displayName: groups.get(g.objectId)?.displayName } },
  });
  const linkJson = (l: Link) => ({
    id: l.id,
    link: { type: l.type, webUrl: `${PUBLIC}/s/${l.token}`, ...(l.displayName && { "@libre.graph.displayName": l.displayName }) },
    hasPassword: !!l.password,
    expirationDateTime: l.expirationDateTime,
    createdDateTime: l.createdDateTime,
    roles: [],
  });

  const nodeById = (fileId: string) => {
    for (const [driveId, tree] of files) for (const n of tree.values()) if (n.fileId === fileId) return { driveId, node: n };
    return undefined;
  };
  const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
  const under = (tree: Map<string, Node>, p: string) => [...tree.values()].filter((n) => n.path === p || n.path.startsWith(`${p}/`));

  /** Who the Authorization header is: undefined when the token is wrong or the account disabled. */
  function who(header: string | null): FakeUser | undefined {
    if (!header?.startsWith("Basic ")) return undefined;
    const raw = Buffer.from(header.slice(6), "base64").toString();
    const at = raw.indexOf(":");
    const [name, token] = [raw.slice(0, at), raw.slice(at + 1)];
    if (name === SERVICE_USER && token === SERVICE_TOKEN) return admin;
    if (appTokens.get(token) !== name) return undefined;
    const u = userByName(name);
    return u?.accountEnabled ? u : undefined;
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const empty = (status: number) => new Response(null, { status });
  const fail = (status: number, message: string) => json({ error: { code: String(status), message } }, status);

  const enc = (p: string) =>
    p
      .split("/")
      .map((s) => encodeURIComponent(s).replaceAll("%24", "$"))
      .join("/");
  function multistatus(entries: Array<{ href: string; props: string }>) {
    const body = entries
      .map((e) => `<d:response><d:href>${e.href}</d:href><d:propstat><d:prop>${e.props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns">${body}</d:multistatus>`,
      {
        status: 207,
        headers: { "content-type": "application/xml; charset=utf-8" },
      },
    );
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nodeProps = (driveId: string, n: Node) =>
    [
      `<d:getlastmodified>${new Date(n.modified).toUTCString()}</d:getlastmodified>`,
      n.folder ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>",
      n.folder ? "" : `<d:getcontentlength>${n.data.length}</d:getcontentlength><d:getcontenttype>${n.type}</d:getcontenttype>`,
      `<d:getetag>&quot;${n.modified.toString(16)}&quot;</d:getetag>`,
      `<oc:fileid>${esc(n.fileId)}</oc:fileid>`,
      `<oc:size>${n.folder ? under(files.get(driveId)!, n.path).reduce((s, x) => s + x.data.length, 0) : n.data.length}</oc:size>`,
      `<oc:has-preview>${n.type.startsWith("image/") ? 1 : 0}</oc:has-preview>`,
      [...links.values()].some((l) => l.itemId === n.fileId) ? "<oc:share-types><oc:share-type>3</oc:share-type></oc:share-types>" : "<oc:share-types/>",
    ].join("");

  /** Parses a WebDAV destination header into a space and path. */
  function destination(h: string | null): { driveId: string; path: string } | undefined {
    const m = /\/remote\.php\/dav\/spaces\/([^/]+)\/?(.*)$/.exec(new URL(h ?? "", "http://x").pathname);
    return m ? { driveId: decodeURIComponent(m[1]!), path: m[2]!.split("/").filter(Boolean).map(decodeURIComponent).join("/") } : undefined;
  }

  async function dav(u: FakeUser, method: string, url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const parts = url.pathname.split("/").filter(Boolean).slice(3); // after remote.php/dav/spaces
    const t = url.pathname.split("/")[3];
    if (t === "meta") {
      const found = nodeById(decodeURIComponent(parts[0]!));
      if (!found || !roleIn(drives.get(found.driveId)!, u.id)) return empty(404);
      const { driveId, node } = found;
      const vbase = `/remote.php/dav/meta/${enc(node.fileId)}/v`;
      if (method === "PROPFIND")
        return multistatus([
          { href: `${vbase}/`, props: "<d:resourcetype><d:collection/></d:resourcetype>" },
          ...node.versions.map((v) => ({
            href: `${vbase}/${encodeURIComponent(v.key)}`,
            props: `<d:getlastmodified>${new Date(v.modified).toUTCString()}</d:getlastmodified><d:getcontentlength>${v.data.length}</d:getcontentlength>`,
          })),
        ]);
      if (method === "COPY") {
        const v = node.versions.find((x) => x.key === decodeURIComponent(parts[2] ?? ""));
        const dst = destination(headers.get("destination"));
        if (!v || !dst || dst.driveId !== driveId) return empty(404);
        if (roleIn(drives.get(driveId)!, u.id) === "viewer") return empty(403);
        node.versions.unshift({ key: String(node.modified), data: node.data, modified: node.modified });
        node.versions = node.versions.filter((x) => x !== v);
        Object.assign(node, { data: v.data, modified: clock() });
        return empty(204);
      }
      return empty(405);
    }
    if (parts[0] === "trash-bin") {
      const driveId = decodeURIComponent(parts[1] ?? "");
      const d = drives.get(driveId);
      const role = d && roleIn(d, u.id);
      if (!d || !role) return empty(404);
      const bin = trash.get(driveId)!;
      const key = parts[2];
      if (method === "PROPFIND")
        return multistatus([
          { href: `/remote.php/dav/spaces/trash-bin/${enc(driveId)}/`, props: "<d:resourcetype><d:collection/></d:resourcetype>" },
          ...[...bin.values()].map((x) => ({
            href: `/remote.php/dav/spaces/trash-bin/${enc(driveId)}/${x.key}/`,
            props:
              `<oc:trashbin-original-filename>${esc(x.location.split("/").at(-1)!)}</oc:trashbin-original-filename>` +
              `<oc:trashbin-original-location>${esc(x.location)}</oc:trashbin-original-location>` +
              `<oc:trashbin-delete-datetime>${new Date(x.deletedAt).toUTCString()}</oc:trashbin-delete-datetime>` +
              `<oc:size>${x.nodes.reduce((s, n) => s + n.data.length, 0)}</oc:size>` +
              (x.nodes[0]!.folder ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>"),
          })),
        ]);
      const item = key ? bin.get(key) : undefined;
      if (!item) return empty(404);
      if (role === "viewer") return empty(403);
      if (method === "DELETE") return (bin.delete(item.key), empty(204));
      if (method === "MOVE") {
        const dst = destination(headers.get("destination"));
        if (!dst || dst.driveId !== driveId) return empty(400);
        const tree = files.get(driveId)!;
        if (tree.has(dst.path)) return empty(412);
        if (!tree.get(parentOf(dst.path))?.folder) return empty(409);
        for (const n of item.nodes) tree.set(dst.path + n.path.slice(item.location.length), { ...n, path: dst.path + n.path.slice(item.location.length) });
        bin.delete(item.key);
        return empty(201);
      }
      return empty(405);
    }

    const driveId = decodeURIComponent(parts[0] ?? "");
    const path = parts.slice(1).map(decodeURIComponent).join("/");
    const d = drives.get(driveId);
    const role = d && roleIn(d, u.id);
    if (!d || !role) return empty(404);
    const tree = files.get(driveId)!;
    const node = tree.get(path);
    const write = role !== "viewer";
    switch (method) {
      case "PROPFIND": {
        if (!node) return empty(404);
        const depth = headers.get("depth") ?? "1";
        const kids = depth === "0" || !node.folder ? [] : [...tree.values()].filter((n) => n.path !== path && parentOf(n.path) === path);
        return multistatus(
          [node, ...kids].map((n) => ({
            href: `/remote.php/dav/spaces/${enc(driveId)}/${enc(n.path)}${n.folder && n.path ? "/" : ""}`,
            props: nodeProps(driveId, n),
          })),
        );
      }
      case "GET":
        if (!node || node.folder) return empty(404);
        if (url.searchParams.get("preview") === "1")
          return node.type.startsWith("image/") ? new Response(new Uint8Array(Buffer.from("PNG")), { headers: { "content-type": "image/png" } }) : empty(404);
        return new Response(new Uint8Array(node.data), { headers: { "content-type": node.type, "content-length": String(node.data.length) } });
      case "PUT": {
        if (!write) return empty(403);
        if (!headers.get("content-length")) return empty(400);
        if (!tree.get(parentOf(path))?.folder) return empty(409);
        const data = Buffer.from(await new Response(init.body).arrayBuffer());
        if (d.quota !== undefined && used(driveId) - (node?.data.length ?? 0) + data.length > d.quota) return empty(507);
        if (node) {
          node.versions.unshift({ key: `v${node.modified}`, data: node.data, modified: node.modified });
          Object.assign(node, { data, modified: clock(), type: headers.get("content-type") ?? node.type });
          return empty(204);
        }
        tree.set(path, {
          path,
          folder: false,
          data,
          type: headers.get("content-type") ?? "application/octet-stream",
          modified: clock(),
          fileId: `${driveId}!${id("f")}`,
          versions: [],
        });
        return empty(201);
      }
      case "MKCOL":
        if (!write) return empty(403);
        if (node) return empty(405);
        if (!tree.get(parentOf(path))?.folder) return empty(409);
        tree.set(path, { path, folder: true, data: Buffer.alloc(0), type: "", modified: clock(), fileId: `${driveId}!${id("f")}`, versions: [] });
        return empty(201);
      case "DELETE": {
        if (!write) return empty(403);
        if (!node || !path) return empty(404);
        const moved = under(tree, path);
        for (const n of moved) tree.delete(n.path);
        const key = id("t");
        trash.get(driveId)!.set(key, { key, location: path, deletedAt: clock(), nodes: moved });
        return empty(204);
      }
      case "COPY": {
        const dst = destination(headers.get("destination"));
        const target = dst && drives.get(dst.driveId);
        if (!node || !dst || !target) return empty(404);
        const tRole = roleIn(target, u.id);
        if (!tRole || tRole === "viewer") return empty(403);
        const into = files.get(dst.driveId)!;
        if (into.has(dst.path)) return empty(412);
        if (!into.get(parentOf(dst.path))?.folder) return empty(409);
        for (const n of under(tree, path)) {
          const p = dst.path + n.path.slice(path.length);
          into.set(p, { ...n, path: p, fileId: `${dst.driveId}!${id("f")}`, versions: [] });
        }
        return empty(201);
      }
    }
    return empty(405);
  }

  async function graph(u: FakeUser, method: string, url: URL, init: RequestInit): Promise<Response> {
    const p = url.pathname;
    const body = init.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : {};
    const isAdmin = u === admin;
    let m: RegExpExecArray | null;

    if (p === "/graph/v1.0/me") return json({ id: u.id, displayName: u.displayName, onPremisesSamAccountName: u.onPremisesSamAccountName });
    if (p === "/graph/v1.0/me/drives") return json({ value: [...drives.values()].filter((d) => roleIn(d, u.id)).map(driveJson) });
    if (p === "/graph/v1.0/drives") {
      if (method === "GET") return isAdmin ? json({ value: [...drives.values()].map(driveJson) }) : fail(403, "permission denied");
      if (method === "POST") {
        if (!isAdmin) return fail(403, "permission denied");
        // The account that creates a space becomes its manager.
        const d = makeDrive({ name: body.name, driveType: "project", description: body.description, quota: body.quota?.total });
        d.grants.push({ id: id("p-"), kind: "user", objectId: u.id, role: "manager" });
        return json(driveJson(d), 201);
      }
    }
    if ((m = /^\/graph\/v1\.0\/drives\/([^/]+)$/.exec(p))) {
      const d = drives.get(decodeURIComponent(m[1]!));
      if (!d || !isAdmin) return fail(404, "drive not found");
      if (method === "DELETE") {
        if (new Headers(init.headers).get("purge")) throw new Error("Files must never purge a space.");
        return ((d.disabled = true), empty(204));
      }
      if (method === "PATCH") {
        if (new Headers(init.headers).get("restore") === "true") d.disabled = false;
        if (body.name) d.name = body.name;
        if (body.description !== undefined) d.description = body.description;
        if (body.quota?.total !== undefined) d.quota = body.quota.total;
        return json(driveJson(d));
      }
    }
    if ((m = /^\/graph\/v1beta1\/drives\/([^/]+)\/root\/(permissions|invite)(?:\/([^/]+))?$/.exec(p))) {
      const d = drives.get(decodeURIComponent(m[1]!));
      if (!d || roleIn(d, u.id) !== "manager") return fail(404, "drive not found");
      if (m[2] === "invite" && method === "POST") {
        const r = body.recipients[0];
        const g: Grant = {
          id: id("p-"),
          kind: r["@libre.graph.recipient.type"] === "group" ? "group" : "user",
          objectId: r.objectId,
          role: ROLE_OF[body.roles[0]]!,
        };
        if (d.grants.some((x) => x.objectId === g.objectId)) return fail(409, "already shared");
        d.grants.push(g);
        return json({ value: [permJson(g)] });
      }
      if (!m[3] && method === "GET") return json({ value: d.grants.map(permJson) });
      const g = d.grants.find((x) => x.id === decodeURIComponent(m![3] ?? ""));
      if (!g) return fail(404, "permission not found");
      if (method === "PATCH") return ((g.role = ROLE_OF[body.roles[0]]!), json(permJson(g)));
      if (method === "DELETE") return ((d.grants = d.grants.filter((x) => x !== g)), empty(204));
    }
    if (p === "/graph/v1.0/groups") {
      if (method === "GET") {
        const s = (url.searchParams.get("$search") ?? "").replace(/"/g, "").toLowerCase();
        return json({
          value: [...groups.values()].filter((g) => g.displayName.toLowerCase().includes(s)).map((g) => ({ id: g.id, displayName: g.displayName })),
        });
      }
      if (!isAdmin) return fail(403, "permission denied");
      const g = { id: id("g-"), displayName: body.displayName as string, members: new Set<string>() };
      groups.set(g.id, g);
      return json({ id: g.id, displayName: g.displayName }, 201);
    }
    if ((m = /^\/graph\/v1\.0\/groups\/([^/]+)(\/members\/\$ref|\/members\/([^/]+)\/\$ref)?$/.exec(p))) {
      const g = groups.get(decodeURIComponent(m[1]!));
      if (!g) return fail(404, "group not found");
      if (!m[2] && method === "GET") return json({ id: g.id, displayName: g.displayName, members: [...g.members].map((x) => users.get(x)) });
      if (!isAdmin) return fail(403, "permission denied");
      if (m[3] && method === "DELETE") return (g.members.delete(decodeURIComponent(m[3])), empty(204));
      if (method === "POST") return (g.members.add(String(body["@odata.id"]).split("/").at(-1)!), empty(204));
    }
    if (p === "/graph/v1.0/users") {
      if (!isAdmin) return fail(403, "permission denied");
      if (method === "GET") {
        const s = (url.searchParams.get("$search") ?? "").replace(/"/g, "").toLowerCase();
        return json({
          value: [...users.values()].filter((x) => x !== admin && `${x.mail} ${x.displayName} ${x.onPremisesSamAccountName}`.toLowerCase().includes(s)),
        });
      }
      if (userByName(body.onPremisesSamAccountName)) return fail(409, "user exists");
      return json(addUser(body.onPremisesSamAccountName, body.displayName), 201);
    }
    if ((m = /^\/graph\/v1\.0\/users\/([^/]+)$/.exec(p)) && method === "PATCH") {
      const x = users.get(decodeURIComponent(m[1]!));
      if (!x || !isAdmin) return fail(404, "user not found");
      if (typeof body.accountEnabled === "boolean") x.accountEnabled = body.accountEnabled;
      return json(x);
    }
    if (p === "/graph/v1beta1/me/drive/sharedByMe") {
      const byItem = new Map<string, Link[]>();
      for (const l of links.values()) if (l.by === u.id) byItem.set(l.itemId, [...(byItem.get(l.itemId) ?? []), l]);
      return json({
        value: [...byItem].flatMap(([itemId, ls]) => {
          const found = nodeById(itemId);
          if (!found) return [];
          const d = drives.get(found.driveId)!;
          return [
            {
              id: itemId,
              name: found.node.path.split("/").at(-1) || d.name,
              ...(found.node.folder ? { folder: {} } : { file: { mimeType: found.node.type } }),
              parentReference: { driveId: d.id, driveType: d.driveType, name: d.name },
              permissions: ls.map(linkJson),
            },
          ];
        }),
      });
    }
    if ((m = /^\/graph\/v1beta1\/drives\/([^/]+)\/items\/([^/]+)\/(permissions|createLink)(?:\/([^/]+))?$/.exec(p))) {
      const driveId = decodeURIComponent(m[1]!);
      const itemId = decodeURIComponent(m[2]!);
      const d = drives.get(driveId);
      const role = d && roleIn(d, u.id);
      const found = nodeById(itemId);
      if (!role || !found || found.driveId !== driveId) return fail(404, "item not found");
      if (m[3] === "createLink") {
        if (role === "viewer") return fail(403, "permission denied");
        const l: Link = {
          id: id("l-"),
          driveId,
          itemId,
          by: u.id,
          type: body.type,
          displayName: body.displayName,
          password: body.password,
          expirationDateTime: body.expirationDateTime ?? null,
          createdDateTime: new Date(clock()).toISOString(),
          token: id("tok"),
        };
        links.set(l.id, l);
        return json(linkJson(l));
      }
      if (!m[4]) return json({ value: [...links.values()].filter((l) => l.itemId === itemId).map(linkJson) });
      const l = links.get(decodeURIComponent(m[4]));
      if (!l || l.itemId !== itemId) return fail(404, "permission not found");
      if (role === "viewer" && l.by !== u.id) return fail(403, "permission denied");
      if (method === "DELETE") return (links.delete(l.id), empty(204));
      if (method === "PATCH") return ((l.expirationDateTime = body.expirationDateTime ?? l.expirationDateTime), json(linkJson(l)));
    }
    return fail(404, `no route ${method} ${p}`);
  }

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (state.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const u = who(new Headers(init.headers).get("authorization"));
    if (!u) return new Response("Unauthorized", { status: 401 });
    calls.push({ as: u.onPremisesSamAccountName, method, path: url.pathname });
    if (url.pathname === "/auth-app/tokens" && method === "POST") {
      const name = url.searchParams.get("userName");
      if (!name) {
        const token = id("own");
        appTokens.set(token, u.onPremisesSamAccountName);
        return json({ token, expiration_date: new Date(clock() + 3_600_000).toISOString() });
      }
      if (!state.impersonation) return new Response("impersonation is disabled", { status: 403 });
      if (u !== admin) return new Response("user is not admin", { status: 403 });
      const target = userByName(name);
      if (!target) return new Response("user not found", { status: 400 });
      const token = id("imp");
      appTokens.set(token, name);
      const hours = Number(/^(\d+)h$/.exec(url.searchParams.get("expiry") ?? "")?.[1] ?? 1);
      return json({ token, expiration_date: new Date(clock() + hours * 3_600_000).toISOString(), label: url.searchParams.get("label") });
    }
    if (url.pathname.startsWith("/remote.php/dav/")) return dav(u, method, url, init);
    if (url.pathname.startsWith("/graph/")) return graph(u, method, url, init);
    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    users,
    groups,
    drives,
    files,
    trash,
    links,
    calls,
    state,
    /** An account as OpenCloud's own sign-in through Identity makes it, with its own space. */
    addUser,
    /** Puts a file or folder in a space for a test, making the folders above it. */
    put(driveId: string, path: string, content?: string, { type = "text/plain", modified = clock(), versions = 0 } = {}) {
      const tree = files.get(driveId)!;
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (!tree.has(p)) tree.set(p, { path: p, folder: true, data: Buffer.alloc(0), type: "", modified, fileId: `${driveId}!${id("f")}`, versions: [] });
      }
      const node: Node = {
        path,
        folder: content === undefined,
        data: Buffer.from(content ?? ""),
        type: content === undefined ? "" : type,
        modified,
        fileId: `${driveId}!${id("f")}`,
        versions: Array.from({ length: versions }, (_, i) => ({
          key: `v${i + 1}`,
          data: Buffer.from(`${content} v${i + 1}`),
          modified: modified - (i + 1) * 86_400_000,
        })),
      };
      tree.set(path, node);
      return node;
    },
    /** A link made in OpenCloud's own apps, without Files. */
    addLink(
      userId: string,
      fileId: string,
      l: { type?: string; password?: string; expirationDateTime?: string | null; displayName?: string; createdDateTime?: string },
    ) {
      const found = nodeById(fileId)!;
      const link: Link = {
        id: id("l-"),
        driveId: found.driveId,
        itemId: fileId,
        by: userId,
        type: l.type ?? "view",
        displayName: l.displayName,
        password: l.password,
        expirationDateTime: l.expirationDateTime ?? null,
        createdDateTime: l.createdDateTime ?? new Date(clock()).toISOString(),
        token: id("tok"),
      };
      links.set(link.id, link);
      return link;
    },
    personalOf,
    userByName,
    roleIn: (driveId: string, userId: string) => roleIn(drives.get(driveId)!, userId),
    driveByName: (name: string) => [...drives.values()].find((d) => d.name === name && d.driveType === "project"),
  };
}

export type FakeOpenCloud = ReturnType<typeof fakeOpenCloud>;
