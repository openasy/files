import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createFiles } from "./files.ts";
import { log } from "./log.ts";
import { createOpenCloud } from "./opencloud.ts";
import { watchAuditLog } from "./opens.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.FILES_DB ?? "/data/files.db";
const configPath = process.env.FILES_CONFIG?.trim() || "/config/files.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.FILES_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.FILES_METRICS_PORT ? Number(process.env.FILES_METRICS_PORT) : undefined;

// The address people open Files at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.FILES_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const openCloudUrl = process.env.FILES_OPENCLOUD_URL?.trim() || "http://opencloud:9200";
// The address people open OpenCloud at, for the desktop and phone apps and the links. Defaults to FILES_OPENCLOUD_URL.
const openCloudPublicUrl = (process.env.FILES_OPENCLOUD_PUBLIC_URL?.trim() || openCloudUrl).replace(/\/$/, "");
const openCloudUser = process.env.FILES_OPENCLOUD_USER?.trim() || "admin";
const tokenFile = process.env.FILES_OPENCLOUD_TOKEN_FILE ?? "/run/secrets/opencloud-token";
const openCloudToken = process.env.FILES_OPENCLOUD_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
if (!openCloudToken) throw new Error(`The OpenCloud service account's app token is missing: mount it at ${tokenFile} or set FILES_OPENCLOUD_TOKEN.`);
const auditLog = process.env.FILES_AUDIT_LOG?.trim() || undefined;

const db = openDb(dbPath);
let files: ReturnType<typeof createFiles> | undefined;
const secretsKeyFile = process.env.FILES_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "files",
  productName: "OpenAsy Files",
  origin: publicUrl,
  // Locally the same Files is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.FILES_PASSWORD_SIGN_IN !== "false",
  // Everyone signs in to reach their files; only some of them manage Files.
  users: true,
  oidc: oidcFromEnv(process.env, "FILES_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Identity's groups decide who is in which space: they are kept for the sync (ADR 0033).
  onOidcSignIn: ({ userId, groups }) => {
    const u = db.prepare("SELECT email, name FROM auth_users WHERE id = ?").get(userId) as { email: string; name: string } | undefined;
    if (!u || !files) return;
    files.rememberPerson(u.email, u.name, groups);
    void files.syncNow();
  },
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const oc = createOpenCloud({ url: openCloudUrl, user: openCloudUser, token: openCloudToken });
let file: ReturnType<typeof watchConfig> | undefined;
files = createFiles(db, oc, { serviceUser: openCloudUser, openCloudUrl: openCloudPublicUrl, fileState: () => file?.state ?? null });
const spaces = files;
// The spaces come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config) => void spaces.setConfig(config), {
  onChange: (state) =>
    state.error
      ? log("warn", "spaces file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "spaces file applied", { file: state.path, spaces: state.spaces }),
});
const audit = watchAuditLog(db, auditLog);
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    files,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(files, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () =>
  log("info", "files started", { version, port, db: dbPath, config: configPath, opencloud: openCloudUrl, auditLog: auditLog ?? null, headless }),
);
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "FILES_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Files behind TLS (ADR 0026)", { url: publicUrl });
}
if (!auditLog) log("info", "FILES_AUDIT_LOG is not set: the Links page cannot show what was opened through a link");
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  // Changes made in OpenCloud by hand are put back, links made there are checked, and a sync that failed is tried again.
  setInterval(() => void spaces.syncNow(), 5 * 60_000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  audit.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
