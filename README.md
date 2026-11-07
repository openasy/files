# files

[![CI](https://github.com/openasy/files/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/files/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Files product: your company's files in your own install. Team and project
spaces set in a file and opened by Identity group, links for people outside that always expire, and a recycle bin
and earlier versions, on [OpenCloud](https://github.com/opencloud-eu/opencloud), the open-source file server that
stores the files and syncs them with its desktop and phone apps.

```
files.yaml ──▶ files ── LibreGraph, WebDAV (service account) ──▶ OpenCloud ◀── sync ── desktop and phone apps
                │  ▲                                                ▲
    web UI ─────┘  └── LibreGraph, WebDAV, as the person ───────────┘◀── links ── people outside
```

Files keeps no files. It talks to OpenCloud over HTTP only: with a service account to keep the spaces in step with the
file, and as the signed-in person, with an app token it makes for them, to list, upload, download and share their files.
People never give Files a password, and OpenCloud's management calls are never passed on from a person's request.

## Spaces and rules

List them in the spaces file, `/config/files.yaml` (`FILES_CONFIG`):

```yaml
links:
  maxDays: 90
  passwordRequired: true
bin:
  keepDays: 30
personal:
  quota: 20GB
spaces:
  - name: Finance
    quota: 100GB
    members:
      - { group: finance, role: editor }
      - { group: finance-leads, role: manager }
  - name: Office move 2025
    disabled: true
```

The file is the only way in: no screen and no API route adds, changes or removes a space, a member or a rule, so they
can live in git and be reviewed like code. The Spaces page shows them read-only. The file is read at start and again
within a minute of a change, and applied whole or not at all. A file with a mistake leaves the last good version in
place, and the log and the Spaces page say which space and field to fix.

| Field | | |
| --- | --- | --- |
| `links.maxDays` | `90` | The longest a link to someone outside may last, 1 to 365 days |
| `links.passwordRequired` | `true` | Links need a password |
| `bin.keepDays` | `30` | Days a deleted file stays in a recycle bin before Files removes it for good |
| `personal.quota` | OpenCloud's | Such as `20GB`: what each person's own space may hold |
| `spaces[].name` | required | Up to 64 characters; it is the space's name in OpenCloud |
| `spaces[].kind` | `team` | `team` or `project`: how the Files page groups it |
| `spaces[].description` | | Shown in OpenCloud |
| `spaces[].quota` | no limit | Such as `100GB` |
| `spaces[].members[].group` | | An Identity group, by the name its `groups` claim carries |
| `spaces[].members[].role` | | `viewer` reads, `editor` also changes, `manager` also shares the space in OpenCloud |
| `spaces[].disabled` | `false` | `true`: nobody can open it; its files are kept |

After every change, and every five minutes, Files brings OpenCloud in step: it makes each space as an OpenCloud
project space, sets its name, description and quota, gives its groups their roles and takes away any other group or
person given access in OpenCloud by hand, and sets the personal quota. A space taken out of the file is disabled, never
deleted; an admin deletes it in OpenCloud when it is no longer needed. Spaces Files did not make are left alone. A
renamed space is a new space: rename it in OpenCloud first, then in the file, to keep its files.

Groups named in the file are made in OpenCloud when they are not there yet. People are put in them from the groups
Identity sends: at each sign-in to OpenCloud (its autoprovisioning) and at each sign-in to Files.

## Links

People share a file or folder with someone outside from the Files page: a link to download, or for a folder, a link to
upload only. Files makes it in OpenCloud as that person and enforces the file's rules first: every link expires, at most
`links.maxDays` from today, and has a password when `links.passwordRequired` is set.

Links can also be made in OpenCloud's own apps. Each sync reads every person's links, shortens those that last longer
than `links.maxDays` from the day they were made, and flags those without a password on the Links page; set
`OC_SHARING_PUBLIC_SHARE_MUST_HAVE_PASSWORD` in OpenCloud to match so it refuses them in the first place.

The Links page shows when each link was opened and whether the password was right, read from OpenCloud's audit log
(`FILES_AUDIT_LOG`, the `public_link_accessed` events). OpenCloud does not record the address a link was opened from,
nor which file of a shared folder was downloaded through it, so Files cannot show those.

## Leaving

Identity says who someone is and which groups they are in, not who their manager is or when they leave, so an admin
plans a handover on the Spaces page: who leaves, their manager and the day. With the first sync of that day Files
makes a space named "Files of" and the person's name, with their manager as its manager, copies the person's own files
into it as them, and disables their OpenCloud account. Their own space is kept as it is; nothing goes to the recycle
bin. The Recycle bin page shows who leaves when, and a handover that fails is tried again at every sync.

## Recycle bin and versions

Deleting moves a file or folder to its space's recycle bin; anyone who may change the space brings it back from the
Recycle bin page. Files removes what has been there longer than `bin.keepDays`, as the space's maker for the file's
spaces and as each person for their own. OpenCloud keeps every earlier version of a file; the Files page lists them
and brings one back. OpenCloud has no way to remove versions by age, so the file has no rule for them yet.

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/files.yaml   # your spaces and rules
docker compose up -d opencloud
```

OpenCloud signs people in through Identity: set `OPENCLOUD_PUBLIC_URL`, `IDENTITY_URL` (its issuer) and
`IDENTITY_HOST` before the first start. Its first start writes its configuration, with the password of its own `admin`
account, to the `opencloud-config` volume. Files signs in to OpenCloud as that `admin` with an app token:

```bash
docker compose exec opencloud opencloud auth-app create --user-name=admin --expiration=8760h
printf '%s' 'the token it printed' > opencloud-token
docker compose up -d files
docker compose logs files | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). Files is on
http://localhost:8080 and OpenCloud on http://localhost:9200; put both behind TLS. In Identity, add Files as an
OpenAsy application with the groups that may use it, and set the `OPENASY_OIDC_*` variables it shows, with
`OPENASY_OIDC_DEFAULT_ROLE=user` so everyone with files signs in as a user. `openasy-kek` encrypts sign-in secrets in
Files' database (ADR 0021): keep it apart from the volume and with your backups. Back up OpenCloud's volumes: they hold
every file. Make a new app token before the old one expires, in a year.

For an S3-compatible store instead of files on disk, set `STORAGE_USERS_DRIVER=decomposeds3` and its
`STORAGE_USERS_DECOMPOSEDS3_*` endpoint, region, keys and bucket on `opencloud`, as in OpenCloud's
[compose files](https://github.com/opencloud-eu/opencloud-compose/blob/main/storage/decomposeds3.yml).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `FILES_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `FILES_CONFIG` | `/config/files.yaml` | The spaces file |
| `FILES_OPENCLOUD_URL` | `http://opencloud:9200` | Where Files reaches OpenCloud |
| `FILES_OPENCLOUD_PUBLIC_URL` | `FILES_OPENCLOUD_URL` | Where people open OpenCloud and point its sync apps |
| `FILES_OPENCLOUD_USER` | `admin` | The service account: an OpenCloud admin |
| `FILES_OPENCLOUD_TOKEN_FILE` | `/run/secrets/opencloud-token` | Its app token, or `FILES_OPENCLOUD_TOKEN` |
| `FILES_AUDIT_LOG` | | OpenCloud's audit log (JSON), for link openings; without it the Links page shows none |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `FILES_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `FILES_DB` | `/data/files.db` | SQLite file (WAL), on the `/data` volume |
| `FILES_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `FILES_HEADLESS` | `false` | `true` serves only the API |
| `FILES_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

### What OpenCloud needs

The settings in `compose.yaml` are what Files relies on; keep them when you run OpenCloud another way.

| Setting | Why |
| --- | --- |
| `OC_EXCLUDE_RUN_SERVICES=idp`, `OC_OIDC_ISSUER` | People sign in to OpenCloud through Identity; its built-in LDAP keeps the accounts |
| `PROXY_USER_OIDC_CLAIM=email`, `PROXY_AUTOPROVISION_CLAIM_USERNAME=email`, `GRAPH_USERNAME_MATCH=none` | Accounts are named by email, so the one Files makes for someone is the one they sign in to |
| `PROXY_AUTOPROVISION_CLAIM_GROUPS=groups` | Group membership follows Identity at each sign-in to OpenCloud |
| `PROXY_ENABLE_APP_AUTH=true`, `AUTH_APP_ENABLE_IMPERSONATION=true` | Files signs in with an app token and makes two-hour tokens to act as each person |
| `OC_ADD_RUN_SERVICES=audit`, `AUDIT_LOG_TO_FILE`, `AUDIT_FORMAT=json` | Link openings for the Links page |

OpenCloud's documentation says impersonation is meant for migrations, not regular use. Files uses it because it is the
only way OpenCloud offers to act as a person without their own sign-in token; the tokens it makes last two hours and
are kept in memory only.

## Roles

Users reach their own spaces and files and their own links. Viewers also see the spaces, every link and the handovers;
editors also stop anyone's link; admins also sync on request, plan handovers and manage members and API tokens
(ADR 0003). API tokens never reach anyone's files.

## Coming next

Rules for versions once OpenCloud can remove them by age, editing documents together in the browser, saving files sent
in Chat to a space, and importing from another drive.

## Develop

```bash
npm install
npm test        # the spaces file, the sync, links, handovers and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

Tests run against OpenCloud in memory (`server/fake-opencloud.ts`) that answers the LibreGraph, WebDAV and auth-app
calls Files makes, the way OpenCloud 7.2 does.

`npm run e2e` (`e2e/run.sh`, also in CI) starts the OpenCloud that `compose.yaml` pins, with the settings above, makes
the service account's app token as the first start does, and runs Files' server against it: the spaces file applied,
people's accounts and spaces, uploads, versions, links with a password and their openings from the audit log, the
recycle bin, someone leaving a group, a handover and a space taken out of the file, each checked in OpenCloud itself.

## Licence

AGPL-3.0 (ADR 0008). OpenCloud is Apache-2.0; Files uses only what is in its open-source repository.
