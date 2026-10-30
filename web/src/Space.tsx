// The Files page: a person's spaces on the left, the folder in the middle, and the file that is open on the right with
// its picture, its links and its earlier versions. Everything here goes to OpenCloud as the signed-in person.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  IconButton,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  TextField,
  cn,
  formatBytes,
  useAgo,
  type Column,
} from "@openasy/ui";
import {
  CheckCircle2,
  ChevronRight,
  Download,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  Lock,
  RotateCcw,
  Share2,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { at, type Call, type Item, type ItemLink, type Me, type MySpace, type Version } from "./api.ts";
import { useT, type T } from "./i18n.ts";
import { useDate } from "./when.ts";

const ICONS = { folder: Folder, sheet: FileSpreadsheet, doc: FileText, image: FileImage, other: File } as const;

function kindOf(item: Pick<Item, "folder" | "name" | "contentType">): keyof typeof ICONS {
  if (item.folder) return "folder";
  const type = item.contentType ?? "";
  const ext = item.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (["xlsx", "xls", "csv", "ods"].includes(ext) || type.includes("spreadsheet")) return "sheet";
  if (["pdf", "doc", "docx", "odt", "txt", "md", "pptx"].includes(ext) || type === "application/pdf" || type.startsWith("text/")) return "doc";
  return "other";
}

const join = (...parts: string[]) => parts.filter(Boolean).join("/");

/** The spaces, grouped as the file sets them: the person's own, teams, projects, and any others OpenCloud shows. */
function SpaceList({ spaces, current, onPick, t }: { spaces: MySpace[]; current: string; onPick: (id: string) => void; t: T }) {
  const groups = (["personal", "team", "project", "other"] as const).filter((k) => spaces.some((s) => s.kind === k));
  return (
    <Panel flush aria-label={t("space.spaces")}>
      {groups.map((k) => (
        <div key={k} className="border-b border-line py-1 last:border-0">
          <span className="block px-3 pt-1 text-2xs font-semibold tracking-wide text-fg-subtle uppercase files-pb-half">{t(`space.group.${k}`)}</span>
          <ul className="files-list">
            {spaces
              .filter((s) => s.kind === k)
              .map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onPick(s.id)}
                    aria-current={s.id === current ? "true" : undefined}
                    className={cn(
                      "files-space flex w-full items-center gap-2 px-3 py-1 text-left text-sm",
                      s.id === current ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-canvas",
                    )}
                  >
                    {s.kind === "personal" ? (
                      <Lock aria-hidden className="files-icon-sm shrink-0" />
                    ) : (
                      <Folder aria-hidden className="files-icon-sm shrink-0" />
                    )}
                    <span className="truncate font-medium">{s.name}</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </Panel>
  );
}

function Usage({ space, me, t }: { space: MySpace; me: Me; t: T }) {
  const share = space.quota ? Math.min(1, space.used / space.quota) : 0;
  return (
    <Panel>
      <div className="flex flex-col files-gap-1">
        <span className="flex justify-between text-xs">
          <span className="font-medium text-fg">{space.name}</span>
          <span className="text-fg-muted tabular-nums">
            {space.quota ? t("space.usedOf", { used: formatBytes(space.used), quota: formatBytes(space.quota) }) : formatBytes(space.used)}
          </span>
        </span>
        {space.quota && (
          <span aria-hidden className="files-bar">
            <span className={cn("files-bar-fill", share > 0.9 ? "bg-warning" : "bg-accent")} style={{ width: `${share * 100}%` }} />
          </span>
        )}
        <span className="text-2xs text-fg-muted">{t("space.keeping", { days: me.policy.bin.keepDays })}</span>
      </div>
    </Panel>
  );
}

/** Making a link to someone outside, within the file's rules. */
function ShareDialog({
  call,
  me,
  driveId,
  item,
  onClose,
  onMade,
}: {
  call: Call;
  me: Me;
  driveId: string;
  item: Item;
  onClose: () => void;
  onMade: () => void;
}) {
  const t = useT();
  const date = useDate();
  const rules = me.policy.links;
  const [now] = useState(() => Date.now());
  const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
  const latest = day(rules.maxDays);
  const [kind, setKind] = useState<"download" | "upload">("download");
  const [to, setTo] = useState("");
  const [password, setPassword] = useState("");
  const [expires, setExpires] = useState(() => day(Math.min(14, rules.maxDays)));
  const [made, setMade] = useState<ItemLink>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function make() {
    setBusy(true);
    setError(undefined);
    try {
      const l = await call<ItemLink>(`/api/v1/drives/${encodeURIComponent(driveId)}/links`, {
        method: "POST",
        body: JSON.stringify({
          itemId: item.fileId,
          name: item.name,
          folder: item.folder,
          kind,
          for: to.trim() || undefined,
          password: password || undefined,
          expires,
        }),
      });
      setMade(l);
      onMade();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (made)
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        icon={<CheckCircle2 />}
        iconTone="success"
        title={t("share.made")}
        description={made.expiresAt ? t("share.madeDetail", { date: date(made.expiresAt) }) : undefined}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t("share.done")}
          </Button>
        }
      >
        <pre className="m-0 overflow-x-auto rounded-md bg-subtle font-mono text-xs text-fg files-wrap files-code">{made.url}</pre>
        {made.password && <p className="m-0 files-mt-2 text-xs text-fg-muted">{t("share.sendPassword")}</p>}
      </Dialog>
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("share.title", { name: item.name })}
      description={t("share.rules", { days: rules.maxDays })}
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("share.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={rules.passwordRequired && !password}>
            {t("share.make")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <Callout tone="danger" title={t("share.failed")}>
            {error}
          </Callout>
        )}
        {item.folder && (
          <SegmentedControl
            label={t("share.kind")}
            value={kind}
            onChange={setKind}
            options={[
              { value: "download", label: t("share.download") },
              { value: "upload", label: t("share.upload") },
            ]}
          />
        )}
        <TextField label={t("share.for")} hint={t("share.forHint")} value={to} onChange={(e) => setTo(e.target.value)} maxLength={128} />
        <TextField
          label={t("share.password")}
          hint={rules.passwordRequired ? t("share.passwordRequired") : t("share.passwordOptional")}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label={t("share.expires")}
          hint={t("share.expiresHint", { days: rules.maxDays, date: date(latest) })}
          type="date"
          min={day(0)}
          max={latest}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          required
        />
      </div>
    </Dialog>
  );
}

/** The file that is open: its picture, what to do with it, the links it is in and its earlier versions. */
function Preview({ call, me, driveId, item, onChanged }: { call: Call; me: Me; driveId: string; item: Item; onChanged: () => void }) {
  const t = useT();
  const date = useDate();
  const ago = useAgo();
  const [versions, setVersions] = useState<Version[]>();
  const [links, setLinks] = useState<ItemLink[]>();
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    if (!item.fileId) return;
    const id = encodeURIComponent(item.fileId);
    void call<{ links: ItemLink[] }>(`/api/v1/drives/${encodeURIComponent(driveId)}/links?itemId=${id}`).then(
      (r) => setLinks(r.links),
      () => setLinks([]),
    );
    if (!item.folder)
      void call<{ versions: Version[] }>(`/api/v1/drives/${encodeURIComponent(driveId)}/versions?fileId=${id}`).then(
        (r) => setVersions(r.versions),
        () => setVersions([]),
      );
  }, [call, driveId, item]);
  useEffect(load, [load]);

  async function restore(v: Version) {
    try {
      await call(`/api/v1/drives/${encodeURIComponent(driveId)}/versions/restore`, {
        method: "POST",
        body: JSON.stringify({ fileId: item.fileId, key: v.key, path: item.path }),
      });
      onChanged();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove() {
    try {
      await call(at(driveId, "items", item.path), { method: "DELETE" });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const Icon = ICONS[kindOf(item)];
  return (
    <Panel aria-label={t("preview.title")} className="self-start">
      <div className="flex flex-col gap-3">
        {item.hasPreview ? (
          <img src={at(driveId, "preview", item.path)} alt="" className="files-picture rounded-md border border-line bg-canvas" />
        ) : (
          <div aria-hidden className="files-picture flex items-center justify-center rounded-md border border-line bg-canvas">
            <Icon className="files-icon-xl text-fg-subtle" />
          </div>
        )}
        <div className="flex items-start gap-2">
          <Icon aria-hidden className="size-4 shrink-0 text-fg-muted files-mt-half" />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold break-words text-fg">{item.name}</span>
            <span className="text-xs text-fg-muted">
              {item.folder ? t("preview.folder") : formatBytes(item.size)}
              {item.modified && ` · ${t("preview.changed", { when: ago(item.modified) })}`}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap files-gap-1">
          {!item.folder && (
            <Button size="sm" icon={<Download />} onClick={() => window.location.assign(at(driveId, "content", item.path))}>
              {t("preview.download")}
            </Button>
          )}
          <Button size="sm" icon={<Share2 />} onClick={() => setSharing(true)} disabled={!item.fileId}>
            {t("preview.share")}
          </Button>
          <IconButton label={t("preview.delete", { name: item.name })} size="sm" variant="ghost" onClick={() => void remove()}>
            <Trash2 />
          </IconButton>
        </div>
        {error && <p className="m-0 text-xs text-danger">{error}</p>}
        {links?.map((l) => (
          <p key={l.id} className="m-0 rounded-md bg-warning-soft text-xs text-fg files-note">
            {t(l.password ? "preview.inLinkPassword" : "preview.inLink", { to: l.for ?? t("links.anyone"), date: l.expiresAt ? date(l.expiresAt) : "–" })}
          </p>
        ))}
        {!item.folder && (
          <section className="flex flex-col files-gap-1 border-t border-line files-pt">
            <h2 className="m-0 text-xs font-semibold text-fg-muted">{t("preview.versions")}</h2>
            <ol aria-label={t("preview.versions")} className="files-list flex flex-col files-gap-1">
              <li className="flex items-center gap-2 text-xs">
                <Avatar name={me.name || me.email} size="sm" className="size-5" />
                <span className="text-fg">
                  {t("preview.current")}
                  {item.modified && ` · ${date(item.modified, true)}`}
                </span>
              </li>
              {versions?.map((v, i) => (
                <li key={v.key} className="flex items-center gap-2 text-xs">
                  <span aria-hidden className="size-5 shrink-0" />
                  <span className="flex min-w-0 grow flex-col">
                    <span className="text-fg">
                      {t("preview.version", { n: versions.length - i })}
                      {v.modified && ` · ${date(v.modified, true)}`}
                    </span>
                    <span className="truncate text-fg-muted">{formatBytes(v.size)}</span>
                  </span>
                  <IconButton label={t("preview.restore", { n: versions.length - i })} size="xs" onClick={() => void restore(v)}>
                    <RotateCcw />
                  </IconButton>
                </li>
              ))}
            </ol>
            {versions?.length === 0 && <p className="m-0 text-2xs text-fg-muted">{t("preview.noVersions")}</p>}
          </section>
        )}
      </div>
      {sharing && <ShareDialog call={call} me={me} driveId={driveId} item={item} onClose={() => setSharing(false)} onMade={load} />}
    </Panel>
  );
}

export function SpacePage({ call, me }: { call: Call; me: Me }) {
  const t = useT();
  const ago = useAgo();
  const [driveId, setDriveId] = useState(me.spaces.find((s) => s.kind !== "personal")?.id ?? me.spaces[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [items, setItems] = useState<Item[]>();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>();
  const [error, setError] = useState<string>();
  const [making, setMaking] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [uploading, setUploading] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const space = me.spaces.find((s) => s.id === driveId);

  const load = useCallback(() => {
    if (!driveId) return;
    void call<{ items: Item[] }>(at(driveId, "items", path)).then(
      (r) => (setItems(r.items), setError(undefined)),
      (e: Error) => (setItems([]), setError(e.message)),
    );
  }, [call, driveId, path]);
  useEffect(load, [load]);

  function open(id: string, to = "") {
    setDriveId(id);
    setPath(to);
    setActive(undefined);
    setItems(undefined);
    setQuery("");
  }

  async function upload(list: FileList | File[]) {
    const all = [...list];
    setUploading(all.length);
    try {
      for (const f of all)
        await call(at(driveId, "content", join(path, f.name)), { method: "PUT", body: f, headers: { "content-type": f.type || "application/octet-stream" } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(0);
      load();
    }
  }
  async function mkdir() {
    try {
      await call(`/api/v1/drives/${encodeURIComponent(driveId)}/folders`, { method: "POST", body: JSON.stringify({ path: join(path, folderName.trim()) }) });
      setMaking(false);
      setFolderName("");
      load();
    } catch (e) {
      setError((e as Error).message);
      setMaking(false);
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  };

  if (!space)
    return (
      <Callout tone="info" title={t("space.none")}>
        {t("space.noneDetail")}
      </Callout>
    );
  const rows = (items ?? []).filter((i) => i.name.toLowerCase().includes(query.trim().toLowerCase()));
  const cur = items?.find((i) => i.path === active);
  const crumbs = path ? path.split("/") : [];
  const title = crumbs.at(-1) ?? space.name;
  const cols: Column<Item>[] = [
    {
      id: "name",
      header: t("space.name"),
      width: "56%",
      sortValue: (i) => `${i.folder ? 0 : 1}${i.name.toLowerCase()}`,
      cell: (i) => {
        const Icon = ICONS[kindOf(i)];
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className={cn("size-4 shrink-0", i.folder ? "text-accent" : "text-fg-muted")} />
            <span className="truncate font-medium">{i.name}</span>
            {i.shared && <Link2 aria-label={t("space.sharedByLink")} className="files-icon-sm shrink-0 text-warning-text" />}
          </span>
        );
      },
    },
    {
      id: "modified",
      header: t("space.changed"),
      sortValue: (i) => i.modified ?? "",
      cell: (i) => <span className="text-xs whitespace-nowrap">{i.modified ? ago(i.modified) : "–"}</span>,
    },
    { id: "size", header: t("space.size"), align: "right", mono: true, sortValue: (i) => i.size, cell: (i) => formatBytes(i.size) },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: space.name, href: "/files" }, ...crumbs.map((c) => ({ label: c }))]}
        title={title}
        meta={
          <Badge icon={<Users aria-hidden className="files-icon-xs" />}>
            {space.kind === "personal"
              ? t("space.onlyYou")
              : space.groups.length
                ? t("space.groups", { groups: space.groups.join(", ") })
                : t("space.sharedSpace")}
          </Badge>
        }
        actions={
          <>
            <Button icon={<FolderPlus />} onClick={() => setMaking(true)}>
              {t("space.newFolder")}
            </Button>
            <Button variant="primary" icon={<Upload />} loading={uploading > 0} onClick={() => input.current?.click()}>
              {t("space.upload")}
            </Button>
            <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
          </>
        }
      />
      {error && (
        <Callout tone="danger" title={t("space.failed")} onDismiss={() => setError(undefined)} className="mb-3">
          {error}
        </Callout>
      )}
      <div className="files-three">
        <div className="flex flex-col files-gap-25">
          <SpaceList spaces={me.spaces} current={driveId} onPick={(id) => open(id)} t={t} />
          <Usage space={space} me={me} t={t} />
        </div>

        <Panel flush aria-label={t("space.folder")} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 files-py-2">
            <nav aria-label={t("space.path")} className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
              <button type="button" className="files-crumb" onClick={() => open(driveId)}>
                {space.name}
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight aria-hidden className="files-icon-xs" />
                  <button
                    type="button"
                    className={cn("files-crumb", i === crumbs.length - 1 && "font-medium text-fg")}
                    onClick={() => open(driveId, crumbs.slice(0, i + 1).join("/"))}
                  >
                    {c}
                  </button>
                </span>
              ))}
            </nav>
            <SearchInput
              label={t("space.search")}
              placeholder={t("space.searchIn", { name: title })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-56"
            />
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("space.files")}
              columns={cols}
              rows={rows}
              getRowId={(i) => i.path}
              loading={!items}
              empty={query ? t("space.noMatch") : t("space.empty")}
              onRowClick={(i) => (i.folder ? open(driveId, i.path) : setActive(i.path))}
              activeRowId={active}
              defaultSort={{ id: "name", direction: "asc" }}
              minWidth={480}
            />
          </div>
          <p className="m-0 border-t border-line px-3 files-py-2 text-xs text-fg-muted">{t("space.drop", { url: me.openCloudUrl })}</p>
        </Panel>

        {cur && <Preview key={cur.path} call={call} me={me} driveId={driveId} item={cur} onChanged={load} />}
      </div>
      <Dialog
        open={making}
        onOpenChange={setMaking}
        title={t("space.newFolder")}
        onSubmit={(e) => {
          e.preventDefault();
          void mkdir();
        }}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setMaking(false)}>
              {t("share.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!folderName.trim() || /[/\\]/.test(folderName)}>
              {t("space.make")}
            </Button>
          </>
        }
      >
        <TextField label={t("space.name")} value={folderName} onChange={(e) => setFolderName(e.target.value)} maxLength={255} />
      </Dialog>
    </>
  );
}
