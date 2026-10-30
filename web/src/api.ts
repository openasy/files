// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export type ConfigFile = { path: string; appliedAt: string | null; spaces: number; error: string | null; text: string | null } | null;

export interface Policy {
  links: { maxDays: number; passwordRequired: boolean };
  bin: { keepDays: number };
  personal: { quota: number | null };
}

export interface SyncResult {
  at: string;
  ok: boolean;
  created: string[];
  updated: string[];
  disabled: string[];
  links: number;
  purged: number;
  error: string | null;
}

export interface Summary {
  spaces: number;
  disabled: number;
  personal: number;
  stored: number;
  file: ConfigFile;
  sync: SyncResult | null;
  policy: Policy;
  openCloudUrl: string;
  links: { working: number; expiringThisWeek: number; withoutPassword: number; openedThisWeek: number };
  handoversPlanned: number;
}

export type Role = "viewer" | "editor" | "manager";

export interface SpaceRow {
  name: string;
  kind: "team" | "project";
  description: string | null;
  quota: number | null;
  members: Array<{ group: string; role: Role }>;
  disabled: boolean;
  driveId: string | null;
  used: number | null;
  state: "pending" | "active" | "disabled";
  links: number;
}

export interface Handover {
  id: string;
  person: string;
  manager: string;
  on: string;
  status: "planned" | "done" | "cancelled";
  createdBy: string;
  createdAt: string;
  doneAt: string | null;
  driveId: string | null;
  bytes: number | null;
  error: string | null;
}

export type SpaceKind = "personal" | "team" | "project" | "other";

export interface MySpace {
  id: string;
  name: string;
  kind: SpaceKind;
  groups: string[];
  used: number;
  quota: number | null;
}

export interface Me {
  email: string;
  name: string;
  openCloudUrl: string;
  policy: Policy;
  spaces: MySpace[];
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
  shared: boolean;
}

export interface Version {
  key: string;
  modified: string | null;
  size: number;
}

export type LinkKind = "download" | "upload" | "edit";

export interface ItemLink {
  id: string;
  for: string | null;
  kind: LinkKind;
  password: boolean;
  expiresAt: string | null;
  url: string;
}

export interface Link {
  id: string;
  driveId: string;
  space: string;
  itemId: string;
  item: string;
  folder: boolean;
  by: string;
  byName: string | null;
  for: string | null;
  kind: LinkKind;
  password: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  url: string;
  opens: number;
  problem: "no-password" | null;
}

export interface BinItem {
  driveId: string;
  space: string;
  kind: SpaceKind;
  key: string;
  name: string;
  location: string;
  folder: boolean;
  size: number;
  deletedAt: string | null;
  keptUntil: string | null;
}

export interface Bin {
  items: BinItem[];
  keepDays: number;
  leaving: Array<{ person: string; manager: string; on: string }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, problem.code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

/** The address of a file or folder in a space, for the routes that take ?path=. */
export const at = (driveId: string, route: string, path: string) => `/api/v1/drives/${encodeURIComponent(driveId)}/${route}?path=${encodeURIComponent(path)}`;
