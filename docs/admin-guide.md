# Server administration

This guide is for the person who installs and runs the planner for a team. To try it on your own machine first, see [Getting started](getting-started.md).

## Overview

The planner has two parts:

- **The server**: a single Node.js process that holds all business rules, access control and storage. It serves the REST API, live updates over WebSocket, and optionally an MCP endpoint for AI assistants.
- **The client**: a single file, `index.html`, plus a small `client-config.js`. The server can serve it, or users can open it from a file share.

Data is stored either in files on disk or in an SQL database (PostgreSQL, SQLite, SQL Server or MariaDB).

## Install

Requires Node.js 22.12 or later.

```sh
git clone <repository-url> planner
cd planner
npm install
cp config.example.json config.json   # then edit, see below
npm run build
npm start
```

`npm run build` builds the shared package, the server (`server/dist`) and the client (`client/dist`). If Chromium is installed for Playwright, it also regenerates the tutorial's pictures; set `SKIP_DOCS_IMAGES=1` to leave them out.

`npm start` runs the built server from the installation directory. The server reads `config.json` from the working directory, or the file named in the `PLANNING_CONFIG` environment variable. If a `.env` file exists in the working directory, its variables are loaded first, so secrets for `${VAR}` values (e.g. `DB_PASSWORD=...`) can live there instead of in `config.json`. `.env` is ignored by git.

Run the server under a service manager (systemd, pm2, a Windows service, a container) so it starts at boot and restarts after a failure. A systemd unit, e.g. `/etc/systemd/system/planner.service`:

```ini
[Unit]
Description=Project planner
After=network.target

[Service]
User=planner
WorkingDirectory=/opt/planner
ExecStart=/usr/bin/npm start
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable it with `sudo systemctl enable --now planner`. With pm2: `pm2 start npm --name planner -- start` from the installation directory, then `pm2 save`. Either can be used as `restartCommand` for [the deploy script](#deploying-from-windows-over-ssh). To make it reachable on ports 80 and 443 with HTTPS, put nginx in front of it ([Behind nginx](#behind-nginx)).

On the first start with local sign-in and no users, the login page asks for the first administrator. Create it straight after installing.

## Configuration (`config.json`)

[`config.example.json`](../config.example.json) lists every setting with comments. The file may contain `//` comments. Relative paths (the data directory, an SQLite file, `clientDir`) are resolved against the directory of the config file.

**Secrets** do not belong in the file. Write `${VAR}` and set the environment variable instead, for example `"connectionString": "postgres://planning:${DB_PASSWORD}@db:5432/planning"`. This works for any value.

### `server`

| Setting           | Default | Meaning                                                                                        |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `port`            | 8080    | HTTP port                                                                                      |
| `allowedOrigins`  | `[]`    | Web origins allowed to call the API (CORS), e.g. `["https://planning.example.com"]`            |
| `allowFileClient` | false   | Allow clients opened from `file://` (they send `Origin: null`)                                 |
| `clientDir`       | —       | Serve the built client from this directory, e.g. `"./client/dist"`. Omit to serve only the API |
| `trustProxy`      | false   | Set to true behind a reverse proxy, so its `X-Forwarded-*` headers are trusted                 |

The server speaks plain HTTP. For HTTPS, put it behind a reverse proxy (nginx, IIS, Caddy, a load balancer) that also forwards WebSocket upgrades, and set `trustProxy: true`. See [Behind nginx](#behind-nginx) for a complete example.

## Behind nginx

nginx receives the web requests on ports 80 and 443 and forwards them to the planner on `127.0.0.1:8080`. The planner itself serves the client, the API, live updates (WebSocket at `/ws`) and MCP. The examples use `planning.example.com` and a Debian or Ubuntu server.

**1. Configure the planner** (`config.json` in the installation directory), then restart it:

```jsonc
"server": {
  "port": 8080,
  "allowedOrigins": ["https://planning.example.com"], // the address users open
  "clientDir": "./client/dist",
  "trustProxy": true
}
```

If MCP OAuth is enabled, `mcp.oauth.issuerUrl` must be the same public address.

**2. Install nginx** and create `/etc/nginx/sites-available/planner`:

```sh
sudo apt install nginx
```

```nginx
# Live updates: pass WebSocket upgrades through, close other connections normally.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name planning.example.com;

    client_max_body_size 6m;          # the API accepts JSON bodies up to 5 MB

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # The planner compares the browser's Origin with Host: keep the original
        # Host, including a non-standard port ($host would drop it).
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;          # keep idle WebSocket connections open
        proxy_buffering off;            # stream MCP responses as they are written
    }
}
```

On Red Hat-based systems the file goes in `/etc/nginx/conf.d/planner.conf` instead, and SELinux must allow nginx to connect to the planner: `sudo setsebool -P httpd_can_network_connect 1`.

**3. Enable the site** and reload nginx:

```sh
sudo ln -s /etc/nginx/sites-available/planner /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # if nginx's welcome page answers instead
sudo nginx -t && sudo systemctl reload nginx
```

**4. Add HTTPS** with a free Let's Encrypt certificate. The DNS name must already point to the server:

```sh
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d planning.example.com --redirect
```

Certbot adds the `listen 443 ssl` lines and certificate to the server block, redirects HTTP to HTTPS and renews the certificate automatically.

**5. Close port 8080** to the outside. The planner listens on all network interfaces, and requests that bypass nginx have no HTTPS. With ufw:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable                      # 8080 stays closed: it is not allowed
```

**Check:** `https://planning.example.com/api/health` answers `{"status":"ok"}`, and `https://planning.example.com/` shows the sign-in page. In the browser's developer tools, the request to `/ws` should show status 101 (live updates are working).

| Symptom                                        | Cause                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 502 Bad Gateway                                | The planner is not running or uses another port: `systemctl status planner`, `journalctl -u planner`                           |
| 502 only on `/ws`                              | The planner refused the WebSocket because of its origin: same causes as 403 below                                              |
| 403 `Origin not allowed`                       | `proxy_set_header Host $http_host` is missing, or `trustProxy` is not `true` and the public address is not in `allowedOrigins` |
| 404 `{"error":{"code":"NOT_FOUND"...}}` at `/` | `clientDir` is missing or points to a folder that does not exist                                                               |
| Other users' changes appear only after reload  | WebSocket upgrades are not forwarded: check the `Upgrade` and `Connection` headers                                             |
| 413 Request Entity Too Large                   | `client_max_body_size` is missing (nginx allows only 1 MB by default)                                                          |

The example serves the planner at the root of its own host name (`https://planning.example.com/`), which is the tested setup.

## Client deployment

The same build works in two ways.

**Hosted (recommended).** Set `server.clientDir` to `./client/dist`, and users open `https://planning.example.com/`. You can also copy `client/dist` to any web server; then set `apiUrl` in `client-config.js` to the server's URL and add the web server's origin to `allowedOrigins`.

**Opened from the file system.** Copy `client/dist/index.html` and `client-config.js` to a share, for example, and users open `index.html` directly. Then:

1. set `apiUrl` in `client-config.js` to the server URL, for example `"https://planning.example.com"`;
2. set `server.allowFileClient: true` in `config.json`.

Single sign-on does not work in this mode, because the identity provider cannot redirect back to a `file://` page; use local or LDAP sign-in.

```js
// client-config.js, next to index.html
window.PLANNING_CLIENT_CONFIG = {
  apiUrl: "", // empty when the planning server serves the client itself
};
```

## Storage

Set `backend` to `"file"` or `"sql"`.

### Files

```jsonc
"backend": "file",
"file": { "path": "./data" }
```

Each entity is a JSON file under the data directory; the audit log is append-only `.jsonl` files. Writes are atomic: a transaction writes temporary files and renames them into place, under one lock for the whole directory.

File storage suits small teams and simple installations. Only one server process may use the directory.

### SQL

```jsonc
"backend": "sql",
"sql": {
  "dialect": "postgres",   // "postgres" | "sqlite" | "mssql" | "mariadb"
  "connectionString": "postgres://planning:${DB_PASSWORD}@localhost:5432/planning"
}
```

| Dialect    | `dialect`  | Connection string                                                                          |
| ---------- | ---------- | ------------------------------------------------------------------------------------------ |
| PostgreSQL | `postgres` | `postgres://user:${DB_PASSWORD}@host:5432/planning`                                        |
| SQLite     | `sqlite`   | `./data/planning.db` (a file path)                                                         |
| SQL Server | `mssql`    | `mssql://user:${DB_PASSWORD}@host:1433/planning?encrypt=true&trustServerCertificate=false` |
| MariaDB    | `mariadb`  | `mariadb://user:${DB_PASSWORD}@host:3306/planning`                                         |

**MariaDB** 10.6 or later (tested with 11.4). Add `?ssl=true` for TLS. The server certificate is then verified; `&sslRejectUnauthorized=false` turns that off, for a self-signed certificate on a trusted network. Special characters in the user name or password must be URL-encoded (`@` → `%40`). The planner creates its tables with the `utf8mb4_nopad_bin` collation, whatever the database's default. To create the database and user:

```sql
CREATE DATABASE planning CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin;
CREATE USER 'planning'@'localhost' IDENTIFIED BY '...';
GRANT ALL PRIVILEGES ON planning.* TO 'planning'@'localhost';
```

Create an empty database and a user that may create tables. The server runs pending migrations at startup. To run them on their own, for example before an upgrade, use `npm run migrate` with `PLANNING_CONFIG` set to the config file's absolute path. Without it, the command falls back to the development configuration.

### Backups

- **Files:** back up the whole data directory, ideally while the server is stopped, or at least not while a transaction is committing (`data/.lock` exists).
- **SQL:** use the database's own backup tools.

Locked baselines and the audit log are never changed by the planner, so a backup also keeps the plan's accepted history.

## Sign-in

Choose the mode with `auth.mode`. Only the section for that mode is needed.

### Local accounts (`"local"`)

```jsonc
"auth": {
  "mode": "local",
  "local": { "passwordMinLength": 12, "sessionTimeoutMinutes": 480 }
}
```

Passwords are stored as scrypt hashes. A session lasts `sessionTimeoutMinutes`.

### LDAP (`"ldap"`)

```jsonc
"auth": {
  "mode": "ldap",
  "ldap": {
    "url": "ldaps://ldap.example.com:636",
    "bindDn": "cn=svc-planning,ou=services,dc=example,dc=com",
    "bindPassword": "${LDAP_BIND_PASSWORD}",
    "userSearchBase": "ou=users,dc=example,dc=com",
    "userFilter": "(uid={username})",
    "groupSearchBase": "ou=groups,dc=example,dc=com",
    "groupFilter": "(member={dn})"
  }
}
```

The server binds with the service account, looks up the user, checks the password and reads the user's groups.

### Single sign-on (`"sso"`, OpenID Connect)

```jsonc
"auth": {
  "mode": "sso",
  "sso": {
    "protocol": "oidc",
    "issuer": "https://login.example.com",
    "clientId": "planning",
    "clientSecret": "${SSO_CLIENT_SECRET}",
    "redirectUri": "https://planning.example.com/auth/callback",
    "groupClaim": "groups",
    "postLoginRedirect": "https://planning.example.com/"   // optional: where the browser goes after sign-in
  }
}
```

Register the planner as a confidential client with your identity provider, using `redirectUri` as the redirect URI, and include the group claim in the ID token. SAML is not supported yet: `"protocol": "saml"` stops the server at startup with a message.

### Roles from directory groups

With LDAP and SSO, users are created on their first sign-in. `roleMapping` gives roles in every project from directory groups, updated at each sign-in:

```jsonc
"roleMapping": { "planning-admins": "ADMIN", "planning-viewers": "VIEWER" }
```

## Users, roles and parties

- **Roles** per project or plan: ADMIN, PLAN_OWNER, EDITOR, APPROVER and VIEWER (see the [User guide](user-guide.md#roles)).
  - The user who creates a project becomes its administrator.
  - Project administrators assign roles in the Project panel under **Members**, for the whole project or for one plan.
- **System administrators**: the first administrator, and users created as such. They can create users and parties.
- **Parties** are organisations or teams that take part in approvals. A user can represent one or more parties.

Creating local users and parties has no screen yet; use the REST API with a system administrator's token:

```sh
# Sign in and keep the token
TOKEN=$(curl -s -X POST https://planning.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "…"}' | jq -r .token)

# Create a local user
curl -X POST https://planning.example.com/api/users \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"username": "kari", "displayName": "Kari Nordmann", "email": "kari@example.com",
       "password": "a-long-password", "isSystemAdmin": false}'

# Create a party and let a user represent it
curl -X POST https://planning.example.com/api/parties \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Customer", "description": "The customer organisation"}'
curl -X PUT https://planning.example.com/api/users/<userId>/parties \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"partyIds": ["<partyId>"]}'
```

Every change and approval is written to the audit log.

## MCP for AI assistants

With `mcp.enabled` (the default), the server exposes a Model Context Protocol endpoint at `mcp.path` (`/mcp`) over Streamable HTTP. AI assistants can use it to read plans and propose changes.

- **Authentication:** with OAuth 2.1 (below), or with a bearer token from `POST /api/auth/login`.
- **Tools:**
  - list projects and plans; read plan tasks;
  - create, update, move, reorder, indent and outdent tasks; set predecessors;
  - propose changes to external tasks;
  - create and compare baselines; create change requests;
  - list pending approvals; run reports.
- **Permissions:** every call runs as the signed-in user, with that user's roles, and is marked as MCP in the audit log.
- **Approvals:** approving or rejecting is only possible in the planner UI, never through MCP.

Set `mcp.enabled: false` to turn the endpoint off.

### Connecting ChatGPT

OpenAI connects to the MCP endpoint from its own servers, so the planning server must be reachable from the internet over **HTTPS** (for example behind a reverse proxy with TLS). `localhost` does not work.

**1. Create a user for the assistant.** Give it only the project and plan roles it needs: the assistant can do whatever this user can. In local or LDAP mode, sign in to get a bearer token (SSO mode has no password login):

```sh
curl -s -X POST https://planning.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "assistant", "password": "…"}'
# → {"token": "…", "expiresAt": "…", "user": {…}}
```

The token expires after `auth.local.sessionTimeoutMinutes`, and also when the server restarts (sessions are kept in memory). Sign in again to get a new one.

**2a. Through the OpenAI API.** The Responses API can call a remote MCP server and send the token in the `mcp` tool's `headers`:

```sh
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<a model with MCP tool support>",
    "input": "Which tasks in the Delivery plan end after the agreed date?",
    "tools": [{
      "type": "mcp",
      "server_label": "planning",
      "server_url": "https://planning.example.com/mcp",
      "headers": { "Authorization": "Bearer <token from step 1>" },
      "require_approval": "always"
    }]
  }'
```

Keep `require_approval` at `"always"` (the default) if you want to confirm each call before it is made. Tools that change data still go through the normal workflow: an assistant can create change requests and propose changes, but people approve them in the UI.

**2b. In the ChatGPT app (OAuth).** ChatGPT connects custom MCP servers as connectors in developer mode. They sign in with OAuth, which this server provides when `mcp.oauth` is enabled. Availability depends on your ChatGPT plan, and the menu names change between releases; see OpenAI's [developer mode help article](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta).

1. Enable OAuth in `config.json` and restart the server. Behind a reverse proxy, also set `"server": { "trustProxy": true }`:

   ```jsonc
   "mcp": {
     "enabled": true,
     "path": "/mcp",
     "oauth": {
       "enabled": true,
       "issuerUrl": "https://planning.example.com",
       "accessTokenMinutes": 60,
       "refreshTokenDays": 30
     }
   }
   ```

2. In ChatGPT, turn on developer mode and create a connector with the MCP server URL `https://planning.example.com/mcp`. Choose **OAuth** as the authentication. ChatGPT discovers the rest and registers itself, so there are no client IDs or secrets to copy.
3. When ChatGPT asks you to connect, a planner page opens. Sign in with your planner account (password, or single sign-on in SSO mode) and allow access. ChatGPT then acts as you, with your roles.

Access tokens last `accessTokenMinutes` and are renewed with refresh tokens, valid for `refreshTokenDays`. Tokens are kept in memory: after a server restart, connect the connector again. Approvals still happen only in the planner UI.

## Upgrading

1. Back up the data (see [Backups](#backups)).
2. Get the new version, then run `npm install` and `npm run build`.
3. Restart the server. SQL migrations run at startup; data stored by older versions is read and upgraded as it is used.

## Deploying from Windows over SSH

`scripts/deploy.ps1` builds the planner on a Windows machine and uploads it to a Linux server with the Windows OpenSSH client, signing in with a password.

1. Copy [`deploy.server.example.json`](../deploy.server.example.json) to `deploy.server.json` in the repository root and edit it.
2. Put the SSH password, on one line, in `deploy.password` in the repository root. If the file is missing, the script asks for the password.
3. Run `.\scripts\deploy.ps1` (add `-SkipBuild` to upload the existing build, or `-ServerFile` / `-PasswordFile` to use other files).

Both files are listed in `.gitignore`. Never commit them.

| Setting                 | Default      | Meaning                                                                                                                                      |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`, `user`  | port 22      | SSH server and account                                                                                                                       |
| `mode`                  | `app`        | `app`: server and client, then `npm ci --omit=dev` on the server. `client`: only `index.html` and `client-config.js`, for a plain web server |
| `remotePath`            | —            | Install directory (`app`) or web root (`client`)                                                                                             |
| `apiUrl`                | —            | If set, written into the uploaded `client-config.js`                                                                                         |
| `npmCommand`            | `npm`        | npm on the server, e.g. a full path when Node.js is not on the SSH session's `PATH`                                                          |
| `restartCommand`        | —            | Run on the server after installing, e.g. `pm2 restart planner`. `sudo` only works with a no-password rule                                    |
| `strictHostKeyChecking` | `accept-new` | OpenSSH host key check: `accept-new` trusts a server on first contact, `yes` requires it in `known_hosts`                                    |
| `remoteTempDir`         | `/tmp`       | Where the package is uploaded before it is unpacked                                                                                          |

In `app` mode the script replaces `shared/dist`, `server/dist` and `client/dist` and the package files. `config.json` and the data directory on the server are left as they are; create `config.json` there before the first start.

An SSH command runs without the interactive part of `~/.bashrc`, where nvm and similar installers put Node.js on the `PATH`. The script therefore runs a login shell and also looks for nvm, Volta, fnm, `/usr/local/bin` and `/opt/node*/bin`. If `npm` is installed somewhere else, run `command -v npm` in an SSH session and put that full path in `npmCommand`.

## Limits to plan for

- **One process:** sessions and live updates are kept in the server's memory. Run a single server process; a restart signs everyone out.
- **No rate limiting** on password sign-in yet: protect the server with your reverse proxy or network rules if it is reachable from the internet.
- **UTC calendars:** working calendars are evaluated in UTC; per-project time zones are not supported yet.
- **Text-only PDFs:** PDF reports are text only.
