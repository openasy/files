// OpenCloud keeps the files. Files talks to it over HTTP only: LibreGraph (/graph) for spaces, their members, groups,
// people and sharing links, and WebDAV (/remote.php/dav) for listing, upload, download, versions and the recycle bin.
// Shapes follow opencloud-eu/libre-graph-api v1.0.8 and reva's ocdav handlers as shipped in OpenCloud 7.2 and later.
//
// Two kinds of calls: the service account (an OpenCloud admin, with an app token) manages spaces, groups and quotas;
// everything a person does goes to OpenCloud as that person, with an app token the service account makes for them
// through the auth-app impersonation API (AUTH_APP_ENABLE_IMPERSONATION). People never give Files a password.

/** Unified role ids of OpenCloud's space roles (services/graph/pkg/unifiedrole/roles.go). */
export const SPACE_ROLES = {
  viewer: "a8d5fe5e-96e3-418d-825b-534dbdf22b99",
  editor: "58c63c02-1d89-4572-916a-870abc5a1b7d",
  manager: "312c0871-5ef7-4b3a-85b6-0e4074c64049",
} as const;

export interface Quota {
  total?: number;
  used?: number;
  remaining?: number;
  deleted?: number;
  state?: string;
}

/** A drive (space), with only the properties Files reads. */
export interface Drive {
  id: string;
  name: string;
  driveType: "personal" | "project" | "virtual" | "share" | string;
  description?: string;
  owner?: { user?: { id: string; displayName?: string } };
  quota?: Quota;
  root?: { id?: string; deleted?: { state?: string } };
}

export interface Identity {
  id: string;
  displayName?: string;
}

/** A sharing permission: a group or user grant, or a link. */
export interface Permission {
  id: string;
  roles?: string[];
  grantedToV2?: { user?: Identity; group?: Identity };
  link?: { type: string; webUrl: string; "@libre.graph.displayName"?: string };
  hasPassword?: boolean;
  expirationDateTime?: string | null;
  createdDateTime?: string | null;
}

export interface DriveItem {
  id: string;
  name: string;
  folder?: object;
  file?: { mimeType?: string };
  parentReference?: { driveId?: string; driveType?: string; path?: string; name?: string };
  permissions?: Permission[];
}

export interface User {
  id: string;
  displayName: string;
  mail?: string;
  onPremisesSamAccountName: string;
  accountEnabled?: boolean;
}

export interface Group {
  id: string;
  displayName: string;
  members?: User[];
}

/** One entry of a WebDAV listing. */
export interface DavEntry {
  /** The path in the space, without a leading slash; "" for the folder listed. */
  path: string;
  name: string;
  folder: boolean;
  size: number;
  modified: string | null;
  contentType: string | null;
  fileId: string | null;
  etag: string | null;
  hasPreview: boolean;
  /** 3 is a public link (oc:share-types). */
  shareTypes: number[];
}

export interface TrashEntry {
  key: string;
  name: string;
  location: string;
  deletedAt: string | null;
  size: number;
  folder: boolean;
}

export interface Version {
  key: string;
  modified: string | null;
  size: number;
}

export class OpenCloudError extends Error {
  /** The HTTP status OpenCloud answered with, or 0 when it could not be reached. */
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export interface OpenCloudOptions {
  /** Where Files reaches OpenCloud's proxy, such as http://opencloud:9200. */
  url: string;
  /** The service account: an OpenCloud user with the admin role. */
  user: string;
  /** Its app token (opencloud auth-app create). */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  clock?: () => number;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const DAV = "/remote.php/dav";
const PROPS = [
  "d:getlastmodified",
  "d:getcontentlength",
  "d:getcontenttype",
  "d:getetag",
  "d:resourcetype",
  "oc:fileid",
  "oc:size",
  "oc:has-preview",
  "oc:share-types",
];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

/** The responses of a WebDAV multistatus, with each property of a 200 propstat by its local name. */
export function parseMultistatus(xml: string): Array<{ href: string; props: Record<string, string> }> {
  const out: Array<{ href: string; props: Record<string, string> }> = [];
  for (const [, body] of xml.matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)) {
    const href = /<(?:[\w-]+:)?href>([\s\S]*?)<\/(?:[\w-]+:)?href>/.exec(body!)?.[1] ?? "";
    const props: Record<string, string> = {};
    for (const [, stat] of body!.matchAll(/<(?:[\w-]+:)?propstat>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/g)) {
      if (!/<(?:[\w-]+:)?status>[^<]*\s200\s/.test(stat!)) continue;
      const prop = /<(?:[\w-]+:)?prop>([\s\S]*)<\/(?:[\w-]+:)?prop>/.exec(stat!)?.[1] ?? "";
      for (const [, name, inner] of prop.matchAll(/<(?:[\w-]+:)?([\w-]+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?\1>)/g)) props[name!] = inner ?? "";
    }
    out.push({ href: unescape(href.trim()), props });
  }
  return out;
}

/** A path in a space as URL segments, refusing anything that climbs out of it. */
export function davPath(path: string): string {
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.includes("\\") || p.includes("\0"))) throw new OpenCloudError("Not a path in this space.", 400);
  return parts.map(encodeURIComponent).join("/");
}

const decodePath = (segments: string[]) => segments.map((s) => decodeURIComponent(s)).join("/");

export function createOpenCloud({ url, user, token, fetch: f = fetch, timeoutMs = 30_000, clock = Date.now }: OpenCloudOptions) {
  const base = url.replace(/\/$/, "");
  const admin = basic(user, token);
  const tokens = new Map<string, { authorization: string; until: number }>();

  async function request(path: string, authorization: string, init: RequestInit & { who?: string } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await f(base + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization },
        signal: AbortSignal.timeout(timeoutMs),
        ...(init.body && typeof init.body === "object" && "getReader" in init.body ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (err) {
      throw new OpenCloudError(`OpenCloud at ${base} cannot be reached: ${(err as Error).message}`);
    }
    if (res.status === 401) {
      if (init.who) tokens.delete(init.who);
      throw new OpenCloudError(
        init.who
          ? `OpenCloud refused the app token made for ${init.who}.`
          : "OpenCloud refused the service account; check FILES_OPENCLOUD_USER and its app token.",
        401,
      );
    }
    if (!res.ok && res.status !== 207) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        // WebDAV answers in XML; the start of it is enough.
      }
      throw new OpenCloudError(`OpenCloud answered ${res.status}: ${detail}`, res.status);
    }
    return res;
  }

  /** Every call one identity can make; `who` names the person for errors, undefined for the service account. */
  function client(authorization: string, who?: string) {
    const call = (path: string, init: RequestInit = {}) => request(path, authorization, { ...init, who });
    const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const res = await call(path, {
        ...init,
        headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
      });
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    };
    const propfind = async (path: string, props: string[], depth: "0" | "1") => {
      const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>${props.map((p) => `<${p}/>`).join("")}</d:prop></d:propfind>`;
      const res = await call(path, { method: "PROPFIND", headers: { depth, "content-type": "application/xml" }, body });
      return parseMultistatus(await res.text());
    };
    const spaceUrl = (driveId: string, path: string) => `${DAV}/spaces/${encodeURIComponent(driveId)}${path ? `/${davPath(path)}` : ""}`;

    return {
      /** The drives this identity is a member of: a person's own and their spaces. */
      async myDrives(): Promise<Drive[]> {
        return (await json<{ value: Drive[] }>("/graph/v1.0/me/drives")).value;
      },
      async sharedByMe(): Promise<DriveItem[]> {
        return (await json<{ value: DriveItem[] }>("/graph/v1beta1/me/drive/sharedByMe")).value;
      },
      async itemPermissions(driveId: string, itemId: string): Promise<Permission[]> {
        return (await json<{ value: Permission[] }>(`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/permissions`))
          .value;
      },
      async createLink(
        driveId: string,
        itemId: string,
        link: { type: string; displayName?: string; password?: string; expirationDateTime: string },
      ): Promise<Permission> {
        return json<Permission>(`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/createLink`, {
          method: "POST",
          body: JSON.stringify(link),
        });
      },
      async updatePermission(driveId: string, itemId: string, permId: string, patch: { expirationDateTime?: string }): Promise<Permission> {
        return json<Permission>(
          `/graph/v1beta1/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/permissions/${encodeURIComponent(permId)}`,
          {
            method: "PATCH",
            body: JSON.stringify(patch),
          },
        );
      },
      async deletePermission(driveId: string, itemId: string, permId: string): Promise<void> {
        await call(`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/permissions/${encodeURIComponent(permId)}`, {
          method: "DELETE",
        });
      },

      /** A folder and what is in it; the first entry is the folder itself. */
      async list(driveId: string, path: string): Promise<DavEntry[]> {
        const prefix = `${DAV}/spaces/`;
        return (await propfind(spaceUrl(driveId, path), PROPS, "1")).map(({ href, props }) => {
          const segments = href
            .slice(href.indexOf(prefix) + prefix.length)
            .split("/")
            .filter(Boolean)
            .slice(1);
          const p = decodePath(segments);
          return {
            path: p,
            name: segments.length ? decodeURIComponent(segments.at(-1)!) : "",
            folder: /collection/.test(props.resourcetype ?? ""),
            size: Number(props.size ?? props.getcontentlength ?? 0) || 0,
            modified: props.getlastmodified ? new Date(props.getlastmodified).toISOString() : null,
            contentType: props.getcontenttype || null,
            fileId: props.fileid ? unescape(props.fileid) : null,
            etag: props.getetag ? props.getetag.replace(/&quot;|"/g, "") : null,
            hasPreview: props["has-preview"] === "1",
            shareTypes: [...(props["share-types"] ?? "").matchAll(/share-type>(\d+)</g)].map((m) => Number(m[1])),
          };
        });
      },
      async download(driveId: string, path: string): Promise<Response> {
        return call(spaceUrl(driveId, path));
      },
      /** A picture of the file from OpenCloud's thumbnails service. */
      async preview(driveId: string, path: string): Promise<Response> {
        return call(`${spaceUrl(driveId, path)}?preview=1&a=1&x=640&y=480&scalingup=0`);
      },
      async upload(driveId: string, path: string, body: ReadableStream | Buffer, length: number, type: string): Promise<void> {
        await call(spaceUrl(driveId, path), {
          method: "PUT",
          headers: { "content-length": String(length), "content-type": type },
          body: body as RequestInit["body"],
        });
      },
      async mkdir(driveId: string, path: string): Promise<void> {
        await call(spaceUrl(driveId, path), { method: "MKCOL" });
      },
      /** Moves a file or folder to the recycle bin. */
      async remove(driveId: string, path: string): Promise<void> {
        await call(spaceUrl(driveId, path), { method: "DELETE" });
      },
      /** Copies within a space or into another one this identity may write to. */
      async copy(fromDrive: string, fromPath: string, toDrive: string, toPath: string): Promise<void> {
        await call(spaceUrl(fromDrive, fromPath), { method: "COPY", headers: { destination: base + spaceUrl(toDrive, toPath), overwrite: "F" } });
      },

      /** Earlier versions of a file, newest first. */
      async versions(fileId: string): Promise<Version[]> {
        const all = await propfind(`${DAV}/meta/${encodeURIComponent(fileId)}/v`, ["d:getlastmodified", "d:getcontentlength"], "1");
        return all
          .filter(({ href }) => !/\/v\/?$/.test(href))
          .map(({ href, props }) => ({
            key: decodeURIComponent(href.replace(/\/$/, "").split("/").at(-1)!),
            modified: props.getlastmodified ? new Date(props.getlastmodified).toISOString() : null,
            size: Number(props.getcontentlength ?? 0) || 0,
          }))
          .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
      },
      async restoreVersion(fileId: string, key: string, driveId: string, path: string): Promise<void> {
        await call(`${DAV}/meta/${encodeURIComponent(fileId)}/v/${encodeURIComponent(key)}`, {
          method: "COPY",
          headers: { destination: base + spaceUrl(driveId, path) },
        });
      },

      async trash(driveId: string): Promise<TrashEntry[]> {
        const props = ["oc:trashbin-original-filename", "oc:trashbin-original-location", "oc:trashbin-delete-datetime", "oc:size", "d:resourcetype"];
        const root = `${DAV}/spaces/trash-bin/${encodeURIComponent(driveId)}`;
        return (await propfind(root, props, "1"))
          .map(({ href, props: p }) => ({ href, p }))
          .filter(({ p }) => p["trashbin-original-location"] !== undefined)
          .map(({ href, p }) => ({
            key: href.replace(/\/$/, "").split("/").at(-1)!,
            name: unescape(p["trashbin-original-filename"] ?? ""),
            location: unescape(p["trashbin-original-location"] ?? ""),
            deletedAt: p["trashbin-delete-datetime"] ? new Date(p["trashbin-delete-datetime"]).toISOString() : null,
            size: Number(p.size ?? 0) || 0,
            folder: /collection/.test(p.resourcetype ?? ""),
          }));
      },
      async restoreTrash(driveId: string, key: string, location: string): Promise<void> {
        await call(`${DAV}/spaces/trash-bin/${encodeURIComponent(driveId)}/${key}`, {
          method: "MOVE",
          headers: { destination: base + spaceUrl(driveId, location), overwrite: "F" },
        });
      },
      /** Removes an item from the recycle bin for good. */
      async purgeTrash(driveId: string, key: string): Promise<void> {
        await call(`${DAV}/spaces/trash-bin/${encodeURIComponent(driveId)}/${key}`, { method: "DELETE" });
      },
    };
  }

  const service = client(admin);
  const serviceJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await request(path, admin, {
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const q = (s: string) => encodeURIComponent(`"${s}"`);

  return {
    url: base,
    /** What the service account does in spaces it manages: the recycle bin of the file's spaces. */
    service,

    /** The calls of one person, with an app token made for them; it is kept until shortly before it expires. */
    async as(username: string) {
      const hit = tokens.get(username);
      if (hit && hit.until > clock()) return client(hit.authorization, username);
      const made = await serviceJson<{ token: string; expiration_date: string }>(
        `/auth-app/tokens?expiry=2h&userName=${encodeURIComponent(username)}&label=${encodeURIComponent("OpenAsy Files")}`,
        { method: "POST" },
      );
      const authorization = basic(username, made.token);
      tokens.set(username, { authorization, until: Math.min(Date.parse(made.expiration_date), clock() + 2 * 3_600_000) - 10 * 60_000 });
      return client(authorization, username);
    },

    // ---- spaces, as the service account
    async drives(): Promise<Drive[]> {
      return (await serviceJson<{ value: Drive[] }>("/graph/v1.0/drives")).value;
    },
    async createDrive(d: { name: string; description?: string | null; quota: number | null }): Promise<Drive> {
      return serviceJson<Drive>("/graph/v1.0/drives", {
        method: "POST",
        body: JSON.stringify({ name: d.name, ...(d.description && { description: d.description }), ...(d.quota !== null && { quota: { total: d.quota } }) }),
      });
    },
    async updateDrive(id: string, patch: { name?: string; description?: string; quota?: { total: number } }): Promise<void> {
      await serviceJson(`/graph/v1.0/drives/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    },
    /** Disables a space; without the Purge header OpenCloud keeps it and its files. Files never sends Purge. */
    async disableDrive(id: string): Promise<void> {
      await serviceJson(`/graph/v1.0/drives/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async enableDrive(id: string): Promise<void> {
      await serviceJson(`/graph/v1.0/drives/${encodeURIComponent(id)}`, { method: "PATCH", headers: { restore: "true" }, body: "{}" });
    },
    async rootPermissions(driveId: string): Promise<Permission[]> {
      return (await serviceJson<{ value: Permission[] }>(`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/root/permissions`)).value;
    },
    async invite(driveId: string, recipient: { objectId: string; type: "user" | "group" }, roleId: string): Promise<void> {
      await serviceJson(`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/root/invite`, {
        method: "POST",
        body: JSON.stringify({ recipients: [{ objectId: recipient.objectId, "@libre.graph.recipient.type": recipient.type }], roles: [roleId] }),
      });
    },
    async setRole(driveId: string, permId: string, roleId: string): Promise<void> {
      await serviceJson(`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/root/permissions/${encodeURIComponent(permId)}`, {
        method: "PATCH",
        body: JSON.stringify({ roles: [roleId] }),
      });
    },
    async removePermission(driveId: string, permId: string): Promise<void> {
      await serviceJson(`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/root/permissions/${encodeURIComponent(permId)}`, { method: "DELETE" });
    },

    // ---- groups and people, as the service account
    async findGroup(name: string): Promise<Group | undefined> {
      const { value } = await serviceJson<{ value: Group[] }>(`/graph/v1.0/groups?$search=${q(name)}`);
      return value.find((g) => g.displayName.toLowerCase() === name.toLowerCase());
    },
    async createGroup(name: string): Promise<Group> {
      return serviceJson<Group>("/graph/v1.0/groups", { method: "POST", body: JSON.stringify({ displayName: name }) });
    },
    async groupMembers(id: string): Promise<User[]> {
      return (await serviceJson<Group>(`/graph/v1.0/groups/${encodeURIComponent(id)}?$expand=members`)).members ?? [];
    },
    async addMember(groupId: string, userId: string): Promise<void> {
      await serviceJson(`/graph/v1.0/groups/${encodeURIComponent(groupId)}/members/$ref`, {
        method: "POST",
        body: JSON.stringify({ "@odata.id": `${base}/graph/v1.0/users/${userId}` }),
      });
    },
    async removeMember(groupId: string, userId: string): Promise<void> {
      await serviceJson(`/graph/v1.0/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`, { method: "DELETE" });
    },
    /** The OpenCloud account whose username is this email address. */
    async findUser(email: string): Promise<User | undefined> {
      const { value } = await serviceJson<{ value: User[] }>(`/graph/v1.0/users?$search=${q(email)}`);
      return value.find((u) => u.onPremisesSamAccountName.toLowerCase() === email.toLowerCase());
    },
    /** An account named by email, as OpenCloud's own sign-in through Identity would make it (see compose.yaml). */
    async createUser(email: string, name: string): Promise<User> {
      return serviceJson<User>("/graph/v1.0/users", {
        method: "POST",
        body: JSON.stringify({ onPremisesSamAccountName: email, mail: email, displayName: name }),
      });
    },
    async disableUser(id: string): Promise<void> {
      await serviceJson(`/graph/v1.0/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ accountEnabled: false }) });
    },
    /** The service account itself, whose own grant as each space's maker stays. */
    async me(): Promise<User> {
      return serviceJson<User>("/graph/v1.0/me");
    },
    async ping(): Promise<void> {
      await serviceJson("/graph/v1.0/me");
    },
  };
}

export type OpenCloud = ReturnType<typeof createOpenCloud>;
export type OpenCloudClient = Awaited<ReturnType<OpenCloud["as"]>>;
