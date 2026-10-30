// The spaces Files runs and the rules for sharing and keeping, from one YAML file (FILES_CONFIG). As with the install's
// other files, the file is the only way in: no screen or API route adds, changes or removes a space, a member or a rule.
// It is applied whole or not at all, read again within a minute of a change, and a file with a mistake leaves the last
// good version in place.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

export type Role = "viewer" | "editor" | "manager";
export const ROLES: Role[] = ["viewer", "editor", "manager"];

export interface Member {
  /** An Identity group, by the name its `groups` claim carries, such as finance. */
  group: string;
  role: Role;
}

export interface Space {
  name: string;
  /** Team or project: how the Files page groups it. OpenCloud keeps both as project spaces. */
  kind: "team" | "project";
  description: string | null;
  /** Bytes the space may hold, or null for no limit. */
  quota: number | null;
  members: Member[];
  /** A disabled space cannot be opened; its files are kept in OpenCloud. */
  disabled: boolean;
}

export interface Policy {
  links: {
    /** The longest a link to someone outside may last, in days. */
    maxDays: number;
    /** Whether a link needs a password. */
    passwordRequired: boolean;
  };
  bin: {
    /** Days a deleted file stays in the recycle bin before Files removes it for good. */
    keepDays: number;
  };
  personal: {
    /** Bytes each person's own space may hold, or null to leave OpenCloud's default. */
    quota: number | null;
  };
}

export interface FilesConfig {
  policy: Policy;
  spaces: Space[];
}

export const DEFAULT_POLICY: Policy = { links: { maxDays: 90, passwordRequired: true }, bin: { keepDays: 30 }, personal: { quota: null } };

const NAME = /^[^/\\:*?"<>|]{1,64}$/;
const GROUP = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,127}$/;
const ROOT_KEYS = ["links", "bin", "personal", "spaces"];
const SPACE_KEYS = ["name", "kind", "description", "quota", "members", "disabled"];
const UNITS: Record<string, number> = { "": 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** "100GB", "500 MB" or a number of bytes. */
function size(v: unknown, at: string): number {
  const m = typeof v === "number" ? [String(v), String(v), ""] : typeof v === "string" ? /^(\d+)\s*([KMGT]?B)?$/i.exec(v.trim()) : null;
  const n = m ? Number(m[1]) * UNITS[(m[2] ?? "").toUpperCase()]! : NaN;
  if (!Number.isSafeInteger(n) || n < 1024 ** 2 || n > 1024 ** 5) throw new Error(`${at} is a size from 1MB to 1024TB, such as 100GB.`);
  return n;
}

/** A map of known keys only; throws naming the unknown ones. */
function only(v: unknown, keys: string[], at: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new Error(`${at} must be a map of ${keys.join(", ")}.`);
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${keys.join(", ")}.`);
  return v;
}

function days(v: unknown, fallback: number, max: number, at: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new Error(`${at} is a whole number of days from 1 to ${max}.`);
  return v;
}

/** Reads the file's text. Throws with the space and field at fault, so one message says what to fix. */
export function parseConfig(text: string): FilesConfig {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) return { policy: DEFAULT_POLICY, spaces: [] };
  const root = only(doc, ROOT_KEYS, "The file");

  const links = only(root.links, ["maxDays", "passwordRequired"], "links");
  if (links.passwordRequired !== undefined && typeof links.passwordRequired !== "boolean") throw new Error("links.passwordRequired is true or false.");
  const bin = only(root.bin, ["keepDays"], "bin");
  const personal = only(root.personal, ["quota"], "personal");
  const policy: Policy = {
    links: {
      maxDays: days(links.maxDays, DEFAULT_POLICY.links.maxDays, 365, "links.maxDays"),
      passwordRequired: (links.passwordRequired as boolean | undefined) ?? DEFAULT_POLICY.links.passwordRequired,
    },
    bin: { keepDays: days(bin.keepDays, DEFAULT_POLICY.bin.keepDays, 3650, "bin.keepDays") },
    personal: { quota: personal.quota === undefined ? null : size(personal.quota, "personal.quota") },
  };

  const list = root.spaces ?? [];
  if (!Array.isArray(list)) throw new Error("spaces must be a list.");
  if (list.length > 1000) throw new Error("spaces holds at most 1000 entries.");
  const names = new Set<string>();
  const spaces = list.map((s: unknown, i): Space => {
    const label = isObj(s) && typeof s.name === "string" ? s.name.trim() : "";
    if (!NAME.test(label)) throw new Error(`spaces[${i}].name is required: up to 64 characters, without / \\ : * ? " < > |.`);
    if (names.has(label.toLowerCase())) throw new Error(`spaces[${i}].name: ${label} is in the file twice.`);
    names.add(label.toLowerCase());
    const at = `spaces[${i}] (${label})`;
    const d = only(s, SPACE_KEYS, at);
    if (d.kind !== undefined && d.kind !== "team" && d.kind !== "project") throw new Error(`${at}.kind is team or project.`);
    if (d.description !== undefined && (typeof d.description !== "string" || d.description.length > 256))
      throw new Error(`${at}.description is up to 256 characters.`);
    if (d.disabled !== undefined && typeof d.disabled !== "boolean") throw new Error(`${at}.disabled is true or false.`);
    const raw = d.members ?? [];
    if (!Array.isArray(raw) || raw.length > 50) throw new Error(`${at}.members is a list of up to 50 groups.`);
    const seen = new Set<string>();
    const members = raw.map((m: unknown, n): Member => {
      const mat = `${at}.members[${n}]`;
      const v = only(m, ["group", "role"], mat);
      if (typeof v.group !== "string" || !GROUP.test(v.group.trim())) throw new Error(`${mat}.group is an Identity group's name, such as finance.`);
      if (!ROLES.includes(v.role as Role)) throw new Error(`${mat}.role is viewer, editor or manager.`);
      const group = v.group.trim();
      if (seen.has(group.toLowerCase())) throw new Error(`${mat}.group: ${group} is a member of this space twice.`);
      seen.add(group.toLowerCase());
      return { group, role: v.role as Role };
    });
    return {
      name: label,
      kind: (d.kind as Space["kind"] | undefined) ?? "team",
      description: typeof d.description === "string" ? d.description.trim() || null : null,
      quota: d.quota === undefined ? null : size(d.quota, `${at}.quota`),
      members,
      disabled: d.disabled === true,
    };
  });
  return { policy, spaces };
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  spaces: number;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** The text of the version that is applied, shown read-only on the Spaces page. */
  text: string | null;
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version to `apply`. A file that cannot be read or parsed leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: FilesConfig) => void,
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, spaces: 0, error: null, text: null };
  let seen = "";
  const read = () => {
    let text: string;
    let stamp: string;
    try {
      const st = statSync(path);
      text = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(text).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const config = parseConfig(text);
      apply(config);
      Object.assign(state, { appliedAt: new Date().toISOString(), spaces: config.spaces.length, error: null, text });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
