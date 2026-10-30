import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  StatusBadge,
  Tabs,
  TextField,
  cn,
  formatBytes,
  toLocale,
  usePath,
  useAgo,
  useLocalePreference,
  useThemePreference,
  type Column,
  type ProductId,
  type Tone,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  File,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  KeyRound,
  Link2,
  Lock,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  MfaSetupRequired,
  Unauthorized,
  type Bin,
  type BinItem,
  type Call,
  type ConfigFile,
  type Handover,
  type Link,
  type Me,
  type Policy,
  type ProductLink,
  type SpaceRow,
  type Summary,
  type SyncResult,
} from "./api.ts";
import { useT, type T } from "./i18n.ts";
import { SpacePage } from "./Space.tsx";
import { daysLeft, useDate } from "./when.ts";

const PAGES = ["files", "links", "bin", "spaces", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
function parseRoute(path: string): Page {
  const page = path.replace(/^\//, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "files";
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi(): Call {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}

// ---------------------------------------------------------------- Links

const expiryTone = (d: number): Tone => (d < 0 ? "neutral" : d <= 2 ? "warning" : "success");

function LinksPage({ call, email }: { call: Call; email: string }) {
  const t = useT();
  const date = useDate();
  const ago = useAgo();
  const { can } = useAuth();
  const [data, setData] = useState<{ links: Link[]; policy: Policy["links"] }>();
  const [tab, setTab] = useState<"working" | "expired">("working");
  const [active, setActive] = useState<string>();
  const [opens, setOpens] = useState<Array<{ at: string; success: boolean }>>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    void call<{ links: Link[]; policy: Policy["links"] }>("/api/v1/links").then(
      (r) => (setData(r), setActive((a) => a ?? r.links.find((l) => !l.expiresAt || daysLeft(l.expiresAt) >= 0)?.id)),
      (e: Error) => setError(e.message),
    );
  }, [call]);
  useEffect(load, [load]);
  useEffect(() => {
    setOpens(undefined);
    if (active)
      void call<{ opens: Array<{ at: string; success: boolean }> }>(`/api/v1/links/${encodeURIComponent(active)}/opens`).then(
        (r) => setOpens(r.opens),
        () => setOpens([]),
      );
  }, [call, active]);

  const links = data?.links ?? [];
  const left = (l: Link) => (l.expiresAt ? daysLeft(l.expiresAt) : Infinity);
  const working = links.filter((l) => left(l) >= 0);
  const rows = tab === "working" ? working : links.filter((l) => left(l) < 0);
  const cur = links.find((l) => l.id === active);
  const expiryText = (l: Link) => {
    if (!l.expiresAt) return t("links.never");
    const d = left(l);
    return d < 0 ? t("links.expired", { date: date(l.expiresAt) }) : d === 0 ? t("links.today") : t("links.expiresIn", { date: date(l.expiresAt), count: d });
  };

  async function stop(l: Link) {
    try {
      await call(`/api/v1/links/${encodeURIComponent(l.id)}`, { method: "DELETE" });
      setNotice(t("links.stopped", { name: l.item }));
      setActive(undefined);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const cols: Column<Link>[] = [
    {
      id: "item",
      header: t("links.opens"),
      width: "30%",
      sortValue: (l) => l.item,
      cell: (l) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{l.item || "–"}</span>
          <span className="text-2xs text-fg-muted">{t("links.inBy", { space: l.space, by: l.byName ?? l.by })}</span>
        </span>
      ),
    },
    {
      id: "for",
      header: t("links.for"),
      width: "22%",
      cell: (l) => <span className={cn("block truncate text-xs", l.for?.includes("@") && "font-mono")}>{l.for ?? t("links.anyone")}</span>,
    },
    {
      id: "kind",
      header: t("links.kind"),
      cell: (l) => (
        <span className="flex items-center gap-1">
          <Badge tone={l.kind === "download" ? "neutral" : "info"}>{t(`links.kinds.${l.kind}`)}</Badge>
          {l.password ? (
            <Lock aria-label={t("links.passwordSet")} className="files-icon-sm text-fg-muted" />
          ) : (
            l.problem && <Badge tone="warning">{t("links.noPassword")}</Badge>
          )}
        </span>
      ),
    },
    {
      id: "expires",
      header: t("links.expires"),
      sortValue: (l) => left(l),
      cell: (l) => <StatusBadge tone={expiryTone(left(l))}>{expiryText(l)}</StatusBadge>,
    },
    { id: "opened", header: t("links.opened"), align: "right", mono: true, sortValue: (l) => l.opens, cell: (l) => l.opens },
  ];
  const weekly = working.filter((l) => left(l) <= 7);

  return (
    <>
      <PageHeader title={t("links.title")} description={data ? t("links.description", { days: data.policy.maxDays }) : undefined} />
      <KpiGrid minWidth={170} className="files-gap-below">
        <KpiCard label={t("links.working")} value={working.length} icon={Link2} />
        <KpiCard
          label={t("links.thisWeek")}
          value={weekly.length}
          delta={{ label: t("links.withoutPassword", { count: weekly.filter((l) => !l.password).length }), intent: "neutral" }}
        />
        <KpiCard label={t("links.anyoneCount")} value={working.filter((l) => !l.for).length} />
        <KpiCard label={t("links.openedTotal")} value={working.reduce((n, l) => n + l.opens, 0)} />
      </KpiGrid>
      {error && (
        <Callout tone="danger" title={t("links.failed")} onDismiss={() => setError(undefined)} className="mb-3">
          {error}
        </Callout>
      )}
      {notice && (
        <div role="status" className="mb-3 rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
          {notice}
        </div>
      )}
      <div className="files-side">
        <Panel flush>
          <div className="px-3 files-pt-2">
            <Tabs
              label={t("links.title")}
              value={tab}
              onChange={setTab}
              items={[
                { value: "working", label: t("links.tabWorking"), count: working.length },
                { value: "expired", label: t("links.tabExpired"), count: links.length - working.length },
              ]}
              className="border-b-0"
            />
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("links.title")}
              columns={cols}
              rows={rows}
              getRowId={(l) => l.id}
              loading={!data}
              empty={t("links.none")}
              onRowClick={(l) => setActive(l.id)}
              activeRowId={active}
              defaultSort={{ id: "expires", direction: "asc" }}
              minWidth={720}
            />
          </div>
        </Panel>
        {cur && (
          <Panel
            aria-label={t("links.link")}
            title={cur.item || "–"}
            description={cur.for ?? t("links.anyone")}
            actions={
              left(cur) >= 0 &&
              (can("editor") || cur.by === email.toLowerCase()) && (
                <Button size="sm" variant="danger" onClick={() => void stop(cur)}>
                  {t("links.stop")}
                </Button>
              )
            }
            className="self-start"
          >
            <div className="flex flex-col gap-3">
              <dl className="files-facts m-0 text-xs">
                <dt className="text-fg-muted">{t("links.address")}</dt>
                <dd className="m-0 truncate font-mono text-fg">{cur.url.replace(/^https?:\/\//, "")}</dd>
                <dt className="text-fg-muted">{t("links.password")}</dt>
                <dd className="m-0 text-fg">{cur.password ? t("links.passwordSet") : t("links.passwordNone")}</dd>
                <dt className="text-fg-muted">{t("links.expires")}</dt>
                <dd className="m-0 text-fg">{expiryText(cur)}</dd>
              </dl>
              {cur.problem === "no-password" && (
                <Callout tone="warning" title={t("links.problem")}>
                  {t("links.problemDetail")}
                </Callout>
              )}
              <section className="flex flex-col files-gap-1 border-t border-line files-pt">
                <h2 className="m-0 text-xs font-semibold text-fg-muted">{t("links.whatOpened")}</h2>
                {opens?.length === 0 && <p className="m-0 text-xs text-fg-muted">{t("links.notOpened")}</p>}
                <ol aria-label={t("links.whatOpened")} className="files-list flex flex-col files-gap-1">
                  {opens?.map((o) => (
                    <li key={o.at} className="flex flex-col text-xs">
                      <span className="truncate text-fg">{o.success ? t("links.openedWith") : t("links.wrongPassword")}</span>
                      <span className="text-2xs text-fg-muted">{ago(o.at)}</span>
                    </li>
                  ))}
                </ol>
                <p className="m-0 text-2xs text-fg-subtle">{t("links.auditNote")}</p>
              </section>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Recycle bin

function BinPage({ call }: { call: Call }) {
  const t = useT();
  const date = useDate();
  const [bin, setBin] = useState<Bin>();
  const [restored, setRestored] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    void call<Bin>("/api/v1/bin").then(setBin, (e: Error) => setError(e.message));
  }, [call]);
  useEffect(load, [load]);

  async function restore(d: BinItem) {
    try {
      await call("/api/v1/bin/restore", { method: "POST", body: JSON.stringify({ driveId: d.driveId, key: d.key, location: d.location }) });
      const folder = d.location.split("/").slice(0, -1).join("/");
      setRestored(t("bin.restored", { name: d.name, where: folder ? `${d.space} / ${folder}` : d.space }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const cols: Column<BinItem>[] = [
    {
      id: "name",
      header: t("bin.name"),
      width: "32%",
      sortValue: (d) => d.name,
      cell: (d) => {
        const Icon = d.folder ? Folder : /\.(pdf|docx?|txt|md)$/i.test(d.name) ? FileText : File;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <span className="truncate font-medium">{d.name}</span>
          </span>
        );
      },
    },
    {
      id: "from",
      header: t("bin.wasIn"),
      width: "26%",
      cell: (d) => <span className="block truncate text-xs">{[d.space, d.location.split("/").slice(0, -1).join("/")].filter(Boolean).join(" / ")}</span>,
    },
    {
      id: "when",
      header: t("bin.when"),
      sortValue: (d) => d.deletedAt ?? "",
      cell: (d) => <span className="text-xs whitespace-nowrap">{d.deletedAt ? date(d.deletedAt, true) : "–"}</span>,
    },
    { id: "kept", header: t("bin.keptUntil"), cell: (d) => <span className="text-xs whitespace-nowrap">{d.keptUntil ? date(d.keptUntil) : "–"}</span> },
    { id: "size", header: t("bin.size"), align: "right", mono: true, cell: (d) => formatBytes(d.size) },
    {
      id: "restore",
      header: <span className="sr-only">{t("bin.restore")}</span>,
      label: t("bin.restore"),
      align: "right",
      cell: (d) => (
        <Button size="xs" icon={<RotateCcw />} onClick={() => void restore(d)}>
          {t("bin.restore")}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t("bin.title")} description={bin ? t("bin.description", { days: bin.keepDays }) : undefined} />
      {bin?.leaving.map((l) => (
        <Callout key={l.person} tone="info" title={t("bin.leaves", { person: l.person, date: date(l.on) })} className="mb-3">
          {t("bin.leavesDetail", { manager: l.manager })}
        </Callout>
      ))}
      {error && (
        <Callout tone="danger" title={t("bin.failed")} onDismiss={() => setError(undefined)} className="mb-3">
          {error}
        </Callout>
      )}
      {restored && (
        <div role="status" className="mb-3 rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
          {restored}
        </div>
      )}
      <Panel flush>
        <DataTable
          label={t("bin.deleted")}
          columns={cols}
          rows={bin?.items ?? []}
          getRowId={(d) => `${d.driveId}/${d.key}`}
          loading={!bin}
          empty={t("bin.empty")}
          defaultSort={{ id: "when", direction: "desc" }}
          minWidth={820}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Spaces

function FileCallout({ file, t }: { file: ConfigFile; t: T }) {
  if (!file?.error) return null;
  return (
    <Callout tone="warning" title={t("file.error")} className="mb-3">
      <span className="files-wrap">{file.error}</span>
    </Callout>
  );
}

function SyncPanel({ call, sync, onSynced }: { call: Call; sync: SyncResult | null; onSynced: () => void }) {
  const t = useT();
  const ago = useAgo();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      await call<SyncResult>("/api/v1/sync", { method: "POST" });
      onSynced();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title={t("sync.title")}
      description={t("sync.description")}
      actions={
        can("admin") && (
          <Button size="sm" icon={<RefreshCw />} loading={busy} onClick={() => void run()}>
            {t("sync.now")}
          </Button>
        )
      }
    >
      {error && <p className="m-0 mb-2 text-sm text-danger">{error}</p>}
      {!sync ? (
        <p className="m-0 text-sm text-fg-muted">{t("sync.never")}</p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          <span>
            <StatusBadge tone={sync.ok ? "success" : "danger"}>{t(sync.ok ? "sync.ok" : "sync.failed")}</StatusBadge>{" "}
            <span className="text-fg-muted">{ago(sync.at)}</span>
          </span>
          <span className="text-xs text-fg-muted">
            {t("sync.changed", {
              created: sync.created.length,
              updated: sync.updated.length,
              disabled: sync.disabled.length,
              links: sync.links,
              purged: sync.purged,
            })}
          </span>
          {sync.error && <span className="text-xs text-fg-muted files-wrap">{sync.error}</span>}
        </div>
      )}
    </Panel>
  );
}

function Leaving({ call, onChanged }: { call: Call; onChanged: () => void }) {
  const t = useT();
  const date = useDate();
  const { can } = useAuth();
  const [list, setList] = useState<Handover[]>();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => ({ person: "", manager: "", on: new Date().toISOString().slice(0, 10) }));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void call<{ handovers: Handover[] }>("/api/v1/handovers").then(
      (r) => setList(r.handovers),
      () => setList([]),
    );
  }, [call]);
  useEffect(load, [load]);

  async function plan() {
    setBusy(true);
    setError(undefined);
    try {
      await call("/api/v1/handovers", { method: "POST", body: JSON.stringify(form) });
      setOpen(false);
      setForm({ person: "", manager: "", on: form.on });
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(h: Handover) {
    await call(`/api/v1/handovers/${encodeURIComponent(h.id)}`, { method: "DELETE" }).catch((e: Error) => setError(e.message));
    load();
  }
  const shown = (list ?? []).filter((h) => h.status !== "cancelled");

  return (
    <Panel
      title={t("leaving.title")}
      description={t("leaving.description")}
      actions={
        can("admin") && (
          <Button size="sm" icon={<UserRound />} onClick={() => setOpen(true)}>
            {t("leaving.plan")}
          </Button>
        )
      }
    >
      {shown.length === 0 && <p className="m-0 text-sm text-fg-muted">{t("leaving.none")}</p>}
      <ul className="files-list flex flex-col gap-2">
        {shown.map((h) => (
          <li key={h.id} className="flex flex-col text-xs">
            <span className="text-sm text-fg">{t("leaving.row", { person: h.person, manager: h.manager })}</span>
            <span className="flex items-center gap-2 text-fg-muted">
              {h.status === "done" ? (
                <StatusBadge tone="success">{t("leaving.done", { size: formatBytes(h.bytes ?? 0) })}</StatusBadge>
              ) : (
                <StatusBadge tone={h.error ? "warning" : "info"}>{t("leaving.on", { date: date(h.on) })}</StatusBadge>
              )}
              {h.status === "planned" && can("admin") && (
                <button type="button" className="files-crumb text-xs" onClick={() => void cancel(h)}>
                  {t("leaving.cancel")}
                </button>
              )}
            </span>
            {h.error && <span className="text-fg-muted files-wrap">{h.error}</span>}
          </li>
        ))}
      </ul>
      {error && !open && <p className="m-0 files-mt-2 text-xs text-danger">{error}</p>}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("leaving.plan")}
        description={t("leaving.planDetail")}
        onSubmit={(e) => {
          e.preventDefault();
          void plan();
        }}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t("share.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!form.person || !form.manager}>
              {t("leaving.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && (
            <Callout tone="danger" title={t("leaving.failed")}>
              {error}
            </Callout>
          )}
          <TextField label={t("leaving.person")} type="email" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })} required />
          <TextField label={t("leaving.manager")} type="email" value={form.manager} onChange={(e) => setForm({ ...form, manager: e.target.value })} required />
          <TextField
            label={t("leaving.date")}
            hint={t("leaving.dateHint")}
            type="date"
            value={form.on}
            onChange={(e) => setForm({ ...form, on: e.target.value })}
            required
          />
        </div>
      </Dialog>
    </Panel>
  );
}

function SpacesPage({ call }: { call: Call }) {
  const t = useT();
  const ago = useAgo();
  const [data, setData] = useState<{ spaces: SpaceRow[]; policy: Policy; file: ConfigFile }>();
  const [summary, setSummary] = useState<Summary>();
  const load = useCallback(() => {
    void call<{ spaces: SpaceRow[]; policy: Policy; file: ConfigFile }>("/api/v1/spaces").then(setData, () => {});
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
  }, [call]);
  useEffect(load, [load]);

  const cols: Column<SpaceRow>[] = [
    {
      id: "name",
      header: t("spaces.space"),
      width: "24%",
      sortValue: (s) => s.name,
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{s.name}</span>
          <span className="text-2xs text-fg-muted">{t(`spaces.kind.${s.kind}`)}</span>
        </span>
      ),
    },
    {
      id: "groups",
      header: t("spaces.groups"),
      cell: (s) => (
        <span className="flex flex-col">
          {s.members.map((m) => (
            <span key={m.group} className="text-xs">
              <span className="font-mono">{m.group}</span> <span className="text-fg-muted">{t(`spaces.role.${m.role}`)}</span>
            </span>
          ))}
          {s.members.length === 0 && "–"}
        </span>
      ),
    },
    {
      id: "used",
      header: t("spaces.used"),
      width: "26%",
      sortValue: (s) => (s.quota ? (s.used ?? 0) / s.quota : 0),
      cell: (s) =>
        s.state !== "active" ? (
          <StatusBadge tone="neutral">{t(`spaces.state.${s.state}`)}</StatusBadge>
        ) : (
          <span className="flex items-center gap-2">
            {s.quota && (
              <span aria-hidden className="files-bar grow">
                <span
                  className={cn("files-bar-fill", (s.used ?? 0) / s.quota > 0.7 ? "bg-warning" : "bg-accent")}
                  style={{ width: `${Math.min(100, ((s.used ?? 0) / s.quota) * 100)}%` }}
                />
              </span>
            )}
            <span className="shrink-0 font-mono text-xs tabular-nums">
              {s.quota ? `${formatBytes(s.used ?? 0)} / ${formatBytes(s.quota)}` : formatBytes(s.used ?? 0)}
            </span>
          </span>
        ),
    },
    { id: "links", header: t("spaces.links"), align: "right", mono: true, sortValue: (s) => s.links, cell: (s) => s.links },
  ];

  return (
    <>
      <PageHeader title={t("spaces.title")} description={t("spaces.description")} />
      <FileCallout file={data?.file ?? null} t={t} />
      {summary && (
        <KpiGrid minWidth={170} className="files-gap-below">
          <KpiCard label={t("spaces.stored")} value={formatBytes(summary.stored)} icon={HardDrive} />
          <KpiCard label={t("spaces.title")} value={summary.spaces} unit={t("spaces.personal", { count: summary.personal })} icon={FolderOpen} />
          <KpiCard
            label={t("links.working")}
            value={summary.links.working}
            icon={Link2}
            delta={{ label: t("links.withoutPassword", { count: summary.links.withoutPassword }), intent: "neutral" }}
          />
          <KpiCard label={t("spaces.leaving")} value={summary.handoversPlanned} icon={Users} />
        </KpiGrid>
      )}
      <div className="files-side">
        <Panel flush title={t("spaces.title")}>
          <DataTable
            label={t("spaces.title")}
            columns={cols}
            rows={data?.spaces ?? []}
            getRowId={(s) => s.name}
            loading={!data}
            empty={t("spaces.none")}
            defaultSort={{ id: "used", direction: "desc" }}
            minWidth={680}
          />
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel
            title="files.yaml"
            description={data?.file?.appliedAt ? t("file.applied", { when: ago(data.file.appliedAt) }) : t("file.notApplied")}
            className="self-start"
          >
            {data?.file?.text && (
              <pre className="m-0 overflow-x-auto rounded-md bg-canvas font-mono text-2xs leading-relaxed text-fg files-code">{data.file.text.trim()}</pre>
            )}
            <p className="m-0 files-mt-2 text-xs text-fg-muted files-wrap">{t("file.readOnly", { path: data?.file?.path ?? "files.yaml" })}</p>
          </Panel>
          <SyncPanel call={call} sync={summary?.sync ?? null} onSynced={load} />
          <Leaving call={call} onChanged={load} />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settings.adminsOnly")}>{t("settings.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settings.${page}`)}
        description={t(`settings.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settings.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me: who, can } = useAuth();
  const account = useAccountMenu();
  const page = parseRoute(usePath());
  const call = useApi();
  const [me, setMe] = useState<Me>();
  const [meError, setMeError] = useState<string>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "files" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
    void call<Me>("/api/v1/me").then(setMe, (e: Error) => setMeError(e instanceof ApiError ? e.message : String(e)));
  }, [call]);

  const manager = can("viewer");
  const nav = [
    { id: "files", label: msg("nav.files"), icon: FolderOpen },
    { id: "links", label: msg("nav.links"), icon: Link2 },
    { id: "bin", label: msg("nav.bin"), icon: Trash2 },
    ...(manager ? [{ id: "spaces", label: msg("nav.spaces"), icon: HardDrive }] : []),
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const roleName = who.user.role.charAt(0).toUpperCase() + who.user.role.slice(1);

  return (
    <AppShell
      product="files"
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: who.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {page === "files" ? (
        me ? (
          <SpacePage call={call} me={me} />
        ) : meError ? (
          <EmptyState icon={<FolderOpen />} title={msg("space.unavailable")}>
            {meError}
          </EmptyState>
        ) : (
          <p className="text-sm text-fg-muted">{msg("space.loading")}</p>
        )
      ) : page === "links" ? (
        <LinksPage call={call} email={who.user.email} />
      ) : page === "bin" ? (
        <BinPage call={call} />
      ) : page === "spaces" && manager ? (
        <SpacesPage call={call} />
      ) : page === "account" || page === "members" || page === "signin" || page === "tokens" ? (
        <SettingsPage page={page} />
      ) : (
        <EmptyState title={msg("settings.adminsOnly")}>{msg("settings.askAnAdmin")}</EmptyState>
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Files">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
