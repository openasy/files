// Who opened what through a link, from OpenCloud's audit log. OpenCloud's audit service writes one JSON object per
// event to a file (AUDIT_LOG_TO_FILE, AUDIT_FORMAT=json); Files reads what was added since it last looked and keeps
// the link openings: `public_link_accessed`, with the link's token, the item it opens, when, and whether the password
// was right. OpenCloud records neither the address the link was opened from nor which file of a shared folder was
// downloaded through it, so Files shows neither.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { log } from "./log.ts";

/** One line of the audit log, with only the fields Files reads. */
interface AuditLine {
  Action?: string;
  Time?: string;
  ShareToken?: string;
  FileID?: string;
  Success?: boolean;
}

/** Reads the lines added to the audit log since the last call; a log that was rotated is read from its start. */
export function readAuditLog(db: DatabaseSync, path: string, now = () => new Date()): number {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return 0;
  }
  const get = db.prepare("SELECT value FROM settings WHERE key = 'audit_offset'");
  let offset = Number((get.get() as { value: string } | undefined)?.value ?? 0);
  if (size < offset) offset = 0;
  if (size === offset) return 0;
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(Math.min(size - offset, 32 * 1024 * 1024));
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  // Only whole lines: a line still being written is read next time.
  const end = buf.lastIndexOf(0x0a) + 1;
  const insert = db.prepare("INSERT INTO link_opens (token, item_id, at, success) VALUES (?, ?, ?, ?)");
  let n = 0;
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.includes("public_link_accessed")) continue;
    let e: AuditLine;
    try {
      e = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (e.Action !== "public_link_accessed" || !e.ShareToken) continue;
    const at = e.Time && !Number.isNaN(Date.parse(e.Time)) ? new Date(e.Time).toISOString() : now().toISOString();
    insert.run(e.ShareToken, e.FileID || null, at, e.Success === false ? 0 : 1);
    n++;
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('audit_offset', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(offset + end));
  db.prepare("DELETE FROM link_opens WHERE at < ?").run(new Date(now().getTime() - 400 * 86_400_000).toISOString());
  return n;
}

/** Reads the audit log every `everyMs`; nothing happens when FILES_AUDIT_LOG is not set. */
export function watchAuditLog(db: DatabaseSync, path: string | undefined, everyMs = 30_000) {
  if (!path) return { stop: () => {} };
  const read = () => {
    try {
      const n = readAuditLog(db, path);
      if (n) log("debug", "link openings read from the audit log", { count: n });
    } catch (err) {
      log("warn", "OpenCloud's audit log could not be read", { file: path, error: String(err) });
    }
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
