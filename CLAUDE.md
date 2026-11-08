# CLAUDE.md — Multi-user Project Planning System

This file gives Claude (and developers) context for working in this repository. Read all of it before making changes.

## 1. Purpose

A web-based, multi-user project planning system in which a project can have a **user-defined number of plans** (e.g. contract/external plan, internal plans, internal reporting plans, etc.). Plans contain **tasks**, can be **baselined**  multiple times, support **branching** of historical and future versions, and have an **approval workflow** for moving **tasks** from estimated → current → agreed.

The user interface is an HTML page with Gantt charts, timelines and a calendar views. Data is stored through one of two backends: **files** or an **SQL database**, selected in a configuration file.

## 2. Architecture

```
┌──────────────────────────────┐
│  Client (HTML + JS/TS)       │  Gantt, timelines, calendars, reports
└──────────────┬───────────────┘
               │ REST/JSON (+ WebSocket for live updates)
┌──────────────▼───────────────┐
│  Application server           │  Business logic, approvals, access control
│  └─ StorageAdapter (interface)│
│      ├─ FileAdapter           │  JSON files on disk
│      └─ SqlAdapter            │  PostgreSQL / SQLite / SQL Server
└──────────────────────────────┘
```

- **All business logic lives in the server**, not in the client and not in the adapters. Adapters only store and retrieve.
- **The server is written in Node.js with TypeScript** (strict mode). Shared types in `/shared` are TypeScript and used by both client and server.
- **The client is written in React with TypeScript** (strict mode, function components and hooks). Third-party UI components that manage their own DOM (e.g. the Gantt) are wrapped in a React component that owns the instance and syncs it with React state.
- **Client libraries**:
  - **Dockview** — multi-panel workspace (dockable, resizable, tabbed panels). The panel layout is serialised and stored as a Workspace. Since v8 the React binding is the `dockview-react` package (`dockview` itself is framework-agnostic).
  - **FullCalendar (MIT core only)** — calendar view, v6.1 with the standard `daygrid`, `timegrid` and `multimonth` plugins. Do not use FullCalendar Premium plugins.
  - **dnd-kit** — dragging tasks/milestones from plans into timelines and other plans, including between Dockview panels.
  - **DHTMLX Gantt Community Edition** — Gantt view (see §7).
  - **ar-timeline-view** — timeline view (see §7), used through its React wrapper in events-only mode (no `api_url`), so every change is saved through our REST API.
- A browser cannot safely write shared files for multiple users at once; a thin server is therefore used for the file backend as well.
- The client must never know which backend is in use.

### MCP interface

The backend exposes a **Model Context Protocol (MCP) server** alongside the REST API, so AI assistants and agents can read and work with plans.

- Implemented with the official TypeScript SDK (`@modelcontextprotocol/sdk`) in `/server/mcp`, served over Streamable HTTP at `mcp.path` on the same Node server. Enabled/disabled in `config.json`.
- **MCP is a thin layer over `/server/services`**, exactly like the REST API. No business logic, storage access or access-control decisions in `/server/mcp`.
- **Every MCP call runs as an authenticated user** using the configured auth mode (local, SSO, LDAP), with the same roles and permissions as the UI. Calls are written to the AuditLog and marked as coming from MCP.
- **MCP OAuth** (`mcp.oauth`, off by default): the server is also an OAuth 2.1 authorization server for MCP clients such as the ChatGPT app. Implementation: `/server/auth/oauth`.
  - **SDK router:** the MCP SDK's `mcpAuthRouter` serves discovery metadata (RFC 8414, RFC 9728), dynamic client registration (RFC 7591), `/authorize`, `/token` (PKCE S256) and `/revoke`. It is mounted before our CORS and origin checks.
  - **Our provider:** `PlannerOAuthProvider` renders a standalone sign-in and consent page and signs the user in with the configured auth mode. Local and LDAP use a password form; SSO goes through the identity provider, which carries a context through the redirect.
  - **Tokens:** access tokens are bound to the MCP endpoint (RFC 8707 `resource`), short-lived, and paired with refresh tokens that rotate on every use.
  - **Storage:** codes and tokens are kept in memory, like UI sessions. Registered clients are stored (entity `oauthClient`).
  - **401 responses** from `/mcp` carry `WWW-Authenticate` with the resource metadata URL, so clients can discover how to sign in.
  - **Session tokens** from `/api/auth/login` keep working at `/mcp`, for API clients that send a fixed bearer token.
- **Tools** (initial set): list projects and plans; get plan items, dependencies and links; create/update/move/reorder/indent/outdent tasks; set predecessors; propose changes to external tasks on AGREEMENT references; create and compare baselines; create ChangeRequests; list pending approvals; run a ReportDefinition.
- **Resources**: read-only views of projects, plans, baselines and report definitions, addressed by URI (e.g. `planning://project/{id}/plan/{id}`).
- Tool inputs and outputs are typed with the shared types in `/shared` and validated with schemas (zod).
- Changes made through MCP go through the same acceptance workflow as the UI: an agent can propose and create ChangeRequests, but locked baselines stay immutable.
- **Approvals are UI only.** Approving, rejecting or accepting a ChangeRequest (including moves to Current or Agreed) cannot be done through MCP. Do not add MCP tools for this; the service layer must also reject approval calls that originate from MCP.
- MCP tools are covered by the same tests as the services they call, plus contract tests for tool schemas.

### Client deployment modes

The built client must work in two ways **from the same build output**:

1. **Hosted** — served by the Node server or any web server (`https://…/index.html`).
2. **Opened from the file system** — the user opens `index.html` directly (`file://…/index.html`).

In both modes the client talks to the application server over HTTP; opening from file only removes the need to host the client, not the server.

Rules that make `file://` work:

- **Single-file build**: Vite with `vite-plugin-singlefile` inlines all JS and CSS into `index.html`. Use `base: "./"`. **No code splitting or dynamic `import()`**, no web workers loaded from separate files — browsers block these on `file://`.
- **Assets** (icons, fonts) are inlined or embedded; no runtime fetches of files next to `index.html`.
- **Client configuration** lives in `client-config.js` next to `index.html`, loaded with a classic `<script src="client-config.js">` (works on `file://`, unlike `fetch`). It sets:
  ```js
  window.PLANNING_CLIENT_CONFIG = {
    apiUrl: "https://planning.example.com"   // empty/omitted when hosted by the server = same origin
  };
  ```
  The client reads this once at startup; never hard-code the server URL.
- **Routing**: use hash-based routing (`HashRouter`), since there is no server to rewrite paths on `file://`.
- **Auth in file mode**: cookies are not usable from `file://`, so the client uses bearer tokens (`Authorization` header) in both modes. Tokens are kept in memory; `localStorage` on `file://` is shared by all local files and must not hold tokens.
- **CORS**: the server allows the configured hosted origins. Requests from `file://` arrive with `Origin: null`; allowing them is controlled by `server.allowFileClient` in `config.json` (off by default) and requires bearer-token auth.
- **SSO** uses browser redirects, which cannot return to a `file://` page. In file mode, use local or LDAP login; SSO is supported in hosted mode.
- E2E tests (Playwright) run the main flows in **both** modes.

### Configuration file (`config.json`)

```json
{
  "backend": "file",            // "file" | "sql"
  "file": {
    "path": "./data"
  },
  "sql": {
    "dialect": "postgres",       // "postgres" | "sqlite" | "mssql"
    "connectionString": "postgres://user:pass@host:5432/planning"
  },
  "server": {
    "port": 8080,
    "allowedOrigins": ["https://planning.example.com"],
    "allowFileClient": false,    // allow clients opened from file:// (Origin: null)
    "trustProxy": false          // true behind a reverse proxy (e.g. for HTTPS)
  },
  "mcp": {
    "enabled": true,
    "path": "/mcp",              // Streamable HTTP endpoint on the same server
    "oauth": {
      "enabled": false,          // OAuth 2.1 for MCP clients (e.g. the ChatGPT app)
      "issuerUrl": "https://planning.example.com",  // public HTTPS URL of this server
      "accessTokenMinutes": 60,
      "refreshTokenDays": 30
    }
  },
  "auth": {
    "mode": "local",             // "local" | "sso" | "ldap"
    "local": {
      "passwordMinLength": 12,
      "sessionTimeoutMinutes": 480
    },
    "sso": {
      "protocol": "oidc",        // "oidc" | "saml"
      "issuer": "https://login.example.com",
      "clientId": "planning",
      "clientSecret": "${SSO_CLIENT_SECRET}",
      "redirectUri": "https://planning.example.com/auth/callback",
      "groupClaim": "groups"     // used for mapping to roles
    },
    "ldap": {
      "url": "ldaps://ldap.example.com:636",
      "bindDn": "cn=svc-planning,ou=services,dc=example,dc=com",
      "bindPassword": "${LDAP_BIND_PASSWORD}",
      "userSearchBase": "ou=users,dc=example,dc=com",
      "userFilter": "(uid={username})",
      "groupSearchBase": "ou=groups,dc=example,dc=com"
    },
    "roleMapping": {             // optional: external group → project role
      "planning-admins": "ADMIN"
    }
  }
}
```

- The server reads `config.json` at startup. The path can be overridden with the environment variable `PLANNING_CONFIG`.
- Secrets (passwords in the connection string, SSO client secret, LDAP bind password) must be loadable from environment variables (`${VAR}` syntax) and never committed.
- Authentication is selected with `auth.mode`; only the section for the selected mode is required. Each mode is implemented as an `AuthProvider` behind a common interface in `/server/auth`, so the rest of the server is independent of the mode.
- For SSO and LDAP, users are created in the system on first login. `roleMapping` can assign roles from external groups; roles can also be managed in the system.

## 3. Folder structure

```
/client
  index.html, vite.config.ts, public/client-config.js
  /src
    /views         gantt/ (GanttAdapter = all DHTMLX code), timeline/ (layout.ts = conversion to ar-timeline-view), calendar/, reports/,
                   approvals/ (inbox, baselines & change requests), project/ (plans and subprojects, members)
    /components    shared UI components and status badges
    /workspace     Dockview workspace, panel registry, project data + live updates
    /api           REST client (bearer token in memory) and WebSocket client
    /auth, /pages  login (local/LDAP/SSO), projects list
  /vendor-patches  (empty — library patches only if unavoidable)
/server
  /src
    /domain        business rules (pure logic, no I/O) + errors
    /services      one service per area; workflow.ts holds steps shared by items and approvals
    /api           REST endpoints (Express 5)
    /mcp           MCP server (tools and resources over the same services)
    /auth          AuthProvider interface + local, OIDC (sso), LDAP providers; sessions
    /realtime      WebSocket live updates
    /storage       StorageAdapter.ts, contract.test.ts, /file FileAdapter, /sql SqlAdapter + migrations
    /config        config.json loading and validation
    /testing       test backends and fixtures (not shipped)
  /scripts         migrate, migrate:make
/shared/src        types, zod schemas, API shapes, /time, /domain (getItemKind)
/tests/e2e         Playwright (hosted + file:// projects)
/docs              getting started, user guide, server administration (keep in step with features)
config.example.json, config.dev.json
```

Unit and integration tests live next to the code as `*.test.ts`.

## 4. Domain model

### Core entities

| Entity | Description |
|---|---|
| **Project** | Top level. Has many plans, users and roles. Has a name, a free-text project type, a description and an active flag. Projects form a hierarchy through `parentProjectId` (null = top level). |
| **Plan** | User-defined type (contract, internal, reporting, …). Belongs to one project. May have an owning/responsible party. |
| **Task** | The single item entity in a plan. Has a per-plan task ID (`taskNumber`) and a position among its siblings (`sortOrder`). Its kind (task, milestone, activity) is derived, not stored — see "Task kinds" below. |
| **Ownership** | A Task is either **internal** (lives only in one plan) or **external** (owned by one plan, can be used in several). |
| **TaskReference** | Use of an external item in another plan. Points to the owner item; holds no copy of its name or dates. Has its own place in the recipient plan's hierarchy (`parentId`, `sortOrder`). |
| **PlanLink** | The link type of one reference (an external task used in another plan): **MONITOR** or **AGREEMENT**, plus optional extra approving parties. A reference without a link is MONITOR. |
| **Dependency** | Dependency between items (FS, SS, FF, SF + lag in `lagUnit`; negative lag = lead). Belongs to one plan (`planId`) in which both tasks are shown: own tasks or external tasks used there, also from other projects of the tree. |
| **Baseline** | Snapshot of a plan. Has a type, a parent (for branching) and settings. |
| **BaselineDefinition** | Configuration of a baseline type (see §6). |
| **ChangeRequest** | Proposed change/acceptance that requires approval. |
| **Approval** | One party's approval/rejection of a ChangeRequest. |
| **Timeline** | User-defined timeline that items are dragged into. |
| **Workspace/View** | The user's layout of open panels (plans, timelines, calendars), per user and project, plus `viewState` (UI state outside the panel layout, e.g. which projects are expanded in the Project panel's structure tree). |
| **ReportDefinition** | Saved report setup that can be run repeatedly. |
| **User / Role / Party** | Users, roles per project/plan, and parties (organisations/teams) that approve. A user has `preferences` (own UI settings kept across sign-ins, e.g. the projects page's expanded projects). |
| **AuditLog** | Immutable log of all changes and approvals. |

### Task kinds

There is one item entity, the **Task**. Its kind follows from its data:

| Kind | Rule |
|---|---|
| **Milestone** | A task with zero duration. |
| **Activity** | A task with one or more subtasks. Its start, end and duration span its subtasks. |
| **Task** | A task with non-zero duration and no subtasks. |

- The kind is computed (e.g. `getItemKind(task)` in `/server/domain`, shared with the client), never stored as a separate field, so it cannot get out of sync.
- Setting a task's duration to zero makes it a milestone; adding a subtask makes it an activity. A milestone cannot have subtasks.
- Activity dates are rolled up from subtasks and are not edited directly.

### Project hierarchy

- A project's parent can be changed, but never to itself or one of its own subprojects (`assertValidProjectParent`).
- Creating a subproject, or moving a project under another one, requires `project.admin` on the child **and** on the new parent.
- The projects page shows the hierarchy as an expandable tree, collapsed by default. The expanded projects are stored in the user's profile (`User.preferences.expandedProjectIds`, `PUT /api/users/me/preferences`; UI state, not audited), so they are the same after signing in again. Creating a subproject or moving a project expands the tree down to it.
- **Inactive** projects keep all their data and stay fully usable; the projects page hides them, together with all their subprojects (active or not), unless "Show inactive projects" is checked. Deactivating a project does not change its subprojects' own active flag.
- Projects stored before these fields existed read as top-level, untyped and active (`normalizeProject`).

### Task IDs, order and predecessors

- **Task ID** (`taskNumber`): assigned per plan when a task is created (highest + 1). An external task used in a plan gets a **local** ID there (`PlanItemReference.taskNumber`) from the same sequence, so it can be used in predecessor notation. It never changes when tasks are moved and is never reused after a delete, so predecessor references stay valid. Tasks stored before IDs existed are numbered after the highest ID in creation order (`missingTaskNumbers`), in the plan view and persistently on the next task creation in that plan.
- **Order**: tasks are moved one place up or down among their siblings (`ItemService.reorder`). Order is not part of the schedule: reordering does not supersede ChangeRequests or reset agreement states.
- **Indent / outdent** (`ItemService.changeLevel`, `changeReferenceLevel`; rule in `changeLevel` in `/server/domain/items`): indent makes a task or reference the last subtask of the sibling above it, which must be an own task and not a milestone; outdent moves it one level up, right after its old parent. It is a move in the hierarchy (activity dates roll up, open ChangeRequests on the task are superseded), and it is refused when the task would end up under a task it is linked to.
- **Predecessor notation** (`/shared/domain/predecessors`): entries separated by `;` or `,`, each `<task ID>[FS|SS|FF|SF][±<lag><unit>]`, e.g. `4FS+3d; 2SS-1w; 7`. The type defaults to FS; units are `h`, `d`, `w`, `mo`, `y`; without a unit the lag is in the successor's granularity. A negative lag is a lead.
- `ItemService.setPredecessors` replaces a task's predecessors **in one plan** (default: the task's own plan; for an external task, pass the plan using it) in one transaction. Only that plan's own dependencies are replaced; links of other plans (e.g. the owner's) are shown but kept.
- A dependency **belongs to a plan** (`planId`): both tasks must be shown there, it is stored in that plan's project, and that plan's editors manage it. Links between a plan's own tasks and external tasks therefore work across projects of the tree. Plan views show every link between their shown tasks, also the owners' own. Removing an external task from a plan removes that plan's links to it. Dependencies stored before `planId` existed belong to the successor's plan (`normalizeDependency`).
- **Dependency checks** (`checkDependency`, reported in `PlanView.dependencyIssues`): a successor that starts (FS, SS) or finishes (FF, SF) before the predecessor's end/start plus lag is flagged. Its link is drawn red and it gets a ⚠ DEP badge with the explanation; later starts (slack) are fine. Lag is **working time** on the project's calendar (`addWorkingLag` in `/shared/time`): hours and days skip non-working hours, weekends and holidays, a week is the calendar's working days per week, months and years are calendar units. After a task ending on a Friday, FS+2d allows a start on Wednesday and FS−2d on Thursday. Nothing is moved automatically (see §13). The Project panel's structure tree shows the number of problems per plan (tooltip: the list) and per project including its subprojects (`PlanService.dependencyIssues`, `GET /api/projects/:id/dependency-issues`).
- Dependencies may not form a loop, and a task cannot be linked to its own activity or subtasks (`/server/domain/dependencies`). Both apply to links drawn in the Gantt as well.
- Dependencies stored before `lagUnit` existed read with the successor's granularity (`normalizeDependency`).

### Editing and deleting plans

- A plan's name, type and description are edited from the Project panel's structure tree (Edit → plan dialog); open panels of the plan are retitled.
- **Deleting a plan** (`PlanService.delete`, after confirmation, plan owners and admins) is permanent and refused while (`assertPlanDeletable`):
  - its tasks are used in other plans;
  - change requests involving it are open;
  - it has locked baselines, because accepted history is never removed.
- Otherwise the plan's own data goes with it: tasks and their dependencies, its references to other plans' tasks (with their links), unlocked baselines, its resolved change requests with their approvals, and plan-specific role assignments. Timelines and report definitions drop the plan; the AuditLog keeps a `delete` entry. Open panels of the plan are closed.

### Internal vs. external items

- **Internal**: visible and editable only within its own plan.
- **External**: has one **owner plan** and one or more **recipient plans** via `TaskReference`.
  - Changes are always made in the owner plan.
  - Recipient plans always see the owner's current values (live), but can compare against their own agreed baseline.
  - In the recipient plan a reference is placed among the local tasks: under a local task (`parentId`) or at the top level, ordered together with the tasks (`sortOrder` is shared). A local task with references under it is an activity and rolls up their dates; when the owner changes the task, recipient plans that placed it under an activity are rolled up too (`rollUpPlan`). A milestone cannot hold references.
  - Name, start, duration and unit always come from the owner's task. In the recipient plan it is shown as "Name (from Owner plan)" (`ResolvedReference.ownerPlanName`). On a **MONITOR** reference they cannot be changed in the recipient plan. On an **AGREEMENT** reference a local change (dialog or dragging the bar) creates a ChangeRequest of kind `PROPOSE_TASK_CHANGE` with one Approval for the owner plan (approvers of the Estimated definition). Approval applies the values to the owner's task; rejection changes nothing. A newer proposal from the same plan, or any change to the task by its owner, supersedes it.

### Link types (per PlanLink)

| Type | Behaviour |
|---|---|
| **MONITOR** | Recipient sees changes and receives notifications/variance markers. No approval required. |
| **AGREEMENT** | Changes affecting agreed values require approval from **all** parties to the link before they become *agreed*. Until then the change is shown as *proposed*. |

The link type is set per reference (each use of an external task in another plan), not per plan. The same external task can be MONITOR towards one plan and AGREEMENT towards another, and two tasks shared between the same plans can have different types.

**Upgrading MONITOR → AGREEMENT** does not require a new approval round. The upgrade takes effect immediately, and the items' current agreed values carry over as the starting point of the agreement. Only changes made *after* the upgrade go through the AGREEMENT approval workflow. The upgrade is recorded in the AuditLog.

Implementation notes:

- A reference's type comes from its own link; with no link it is MONITOR (`effectiveLinkType`). Plan-level links (one type for every reference between two plans) were removed: stored ones are converted once at startup into links per reference (`LinkService.convertPlanLevelLinks`), so no reference changes type.
- "Carry over" on upgrade copies the owner plan's Agreed-track values into the recipient's Agreed track for referenced items that have no agreed value there yet.
- Using an external item in another plan requires edit rights on the recipient plan and membership of the owner's project — not read access to the owner plan. Choosing AGREEMENT for a reference, or changing its type, needs the manage right on the owner plan **or** the receiving plan (`AccessService.requireLinkManager`): the link binds both sides.
- **Across the project tree**: an external task can be used in plans of any project in the same tree (its parents and subprojects; `assertSameProjectTree`). `ItemService.referenceTargets` lists the plans a user may add it to.
  - A TaskReference, and a link for that one task, are stored with the **recipient plan's project**.
  - An Approval is stored with the **deciding plan's project**, so its members see it in their inbox and their roles are checked there. Look approvals up by `changeRequestId`, track baselines by `planId` (`findTrackBaseline`), and references to a task by `itemId` (`referencesOf`), never scoped to one project.
  - Change events are emitted once per project involved (`perProject`), so every workspace showing an affected plan updates live. A task change reaches every plan using the task **or one of its activities**, since activity dates roll up (`taskChangeAudience`). An external task that is an activity in its owner plan is shown and locked as an activity in plans using it (`ResolvedReference.itemKind`).
- **Reference type**: when a task is added to another plan, MONITOR or AGREEMENT can be chosen. The choice is stored as the reference's link (`setReferenceLinkType`); the default is MONITOR. In the owner's task dialog a MONITOR reference can be upgraded to AGREEMENT and an AGREEMENT reference downgraded to MONITOR; the receiving plan's external-task dialog offers the upgrade too. Extra approving parties can be set through the API (`partyIds`).

### Tracks and agreement state (as implemented)

- **Estimated** is the live plan: the `Task` rows themselves. **Current** and **Agreed** are one `Baseline` each per plan with `kind: "TRACK"`, created with the plan and changed only by accepted ChangeRequests. Named snapshots are `kind: "SNAPSHOT"`, what-if branches `kind: "BRANCH"`.
- `agreementState` (`NONE | PROPOSED | AGREED | REJECTED`) is stored on the `Task` (owner side) and on each `PlanItemReference` (recipient side).
- One `Approval` row is created per required plan (tagged with the plan's `ownerPartyId`) and per extra party on an AGREEMENT link. A user may decide it with one of its `roles` on that plan, or by representing its party.

## 5. Time granularity

Every task is planned in one unit: **hours, days, weeks, months or years**.

- Always store start/end as a **UTC timestamp** + a `granularity` field + `duration` in the chosen unit.
- Display is rounded/snapped to the granularity.
- Working calendar (holidays, working hours) per project; used when calculating hour/day durations.
- Conversion between units happens in a single helper module (`/shared/time`). Do not duplicate date logic.
- Default display time zone: the user's; storage: UTC.

## 6. Baselines, branching and acceptance

### Baseline types

Every plan has at least these three "tracks":

| Track | Meaning |
|---|---|
| **Estimated** | Working draft / forecast. Freely editable by the plan's owners. |
| **Current** | The current internally committed plan. |
| **Agreed** | Agreed with other parties (contract/agreement). |

In addition, users can create **any number of named baselines** (snapshots) over time.

### Branching

- A baseline has a `parentBaselineId` → forms a tree.
- Historical baselines are **immutable** once locked.
- Future "what-if" branches can be created from any baseline and edited independently.
- A branch can be promoted to Estimated/Current through the acceptance workflow.

### BaselineDefinition (settings)

Configures how a baseline type behaves:

```json
{
  "name": "Agreed",
  "acceptFrom": "Current",            // which track items are accepted from
  "requiresApproval": true,
  "approvers": ["PLAN_OWNER"],        // roles/parties
  "externalItemRule": "OWNER_AND_RECIPIENTS", // external: owner + all recipients must approve
  "granularityOfAcceptance": "ITEM",  // ITEM | BATCH | WHOLE_PLAN
  "lockOnAccept": true,
  "allowBranching": true
}
```

Each project starts with three definitions (Estimated, Current, Agreed); see `defaultDefinitions()` in `ProjectService`. The Estimated definition governs promoting a branch to the live plan. `lockOnAccept` means: after each accepted ChangeRequest, a locked SNAPSHOT of the updated track is stored as a child of the track, giving an immutable history.

### Acceptance workflow

1. **Estimated → Current**: per item or in batch. Requires approval according to the definition (typically the plan owner).
2. **Current → Agreed**:
   - Internal items: approval from the plan's approvers.
   - **External items: the owner and all recipients must approve** before the item becomes agreed.
   - Items on AGREEMENT links: all parties to the link must approve.
3. Approval is handled through `ChangeRequest` → `Approval[]`. Status: `PENDING`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `SUPERSEDED`.
4. Acceptance is **atomic**: either the whole ChangeRequest is accepted, or nothing is.
5. A new change to an item with an open ChangeRequest marks the old one as `SUPERSEDED`.
6. **Rejected approval on an external item that is already current in a recipient plan**: the item stays in Current in the recipient plan, but gets the agreement state `REJECTED`. It is not rolled back. The rejected state is shown in the UI and kept until a new ChangeRequest is approved or the item changes.
7. **Proposed task changes** (`PROPOSE_TASK_CHANGE`, see §4): raised in a recipient plan, decided by the owner plan, applied to the owner's live task when approved.

## 7. User interface

- **Workspace with any number of panels**: users can open any number of plans, timelines and calendars side by side. The layout is saved as a Workspace.
- **Project structure** (Project panel): a tree starting at the current project; under each project its plans first, then its subprojects (inactive ones hidden with their subtrees). Subprojects expand on demand and the expanded set is saved in the workspace's `viewState`. A subproject's plans open in the current workspace (its Gantt panel is titled with the subproject's name); the workspace subscribes to live changes of all its subprojects. Timelines belong to a project but can show tasks from any project.
- **Gantt**: hierarchy (WBS) with task IDs and a Predecessors column, dependency arrows, drag to move/resize, move up/down among siblings, indent/outdent (→ / ←), a today line, and a timeline scale (hours, days, weeks, months, quarters, years) with zoom −/+, Ctrl + wheel, Fit and Today. The scale logic is library-neutral in `views/gantt/scale.ts`.
- **Baseline overlay**: select one or more baselines and show them as shadow/outline bars behind the active plan. Variances are colour-coded (earlier/later). Default: Agreed, Current, Estimated.
- **Timelines**: user-configurable (name, time span, scale, rows/swimlanes). Tasks are **dragged in** from a plan; the timeline shows references, not copies.
  - Drawn by **ar-timeline-view**. `views/timeline/layout.ts` converts a Timeline to the library's data (one view; each row is one of its timelines, with the same span) and back. The library's model is display state: after each change it reports, the view's rows and entries are saved through the server, then reloaded. Drawing replaces the view's DOM, so it waits for a running drag or save.
  - Rows have an editable name and can be moved up and down. A row has three areas: **callouts above** the timeline, the **timeline** itself (bars in lines) and **callouts below**. Each entry stores its `placement` (`above` | `on` | `below`). Bars have a `line` (no gaps). Callouts have a free position, `calloutX` and `calloutY`, in px from the attachment point on the bar's edge (the middle of a task, a milestone's date).
  - Entries are dragged between lines, areas and rows by the library. Plan tasks are dragged in with dnd-kit: the panel is one drop target, and the library finds the spot under the pointer (`targetAt`, `addEntry`).
  - **Pending requests and proposals**: the timeline reads `pendingItemIds` and `proposedChanges` from the plan views of its tasks. A task with a pending request gets a PEND badge on its bar, milestone or callout. Each `PROPOSE_TASK_CHANGE` is drawn as a dashed outline at the proposed dates, a rectangle or (zero duration) a diamond, through the library's task and callout layers, until the owner decides.
  - Status text is built as DOM nodes, not HTML strings, in the library's templates, because task names are user input.
  - A timeline can show tasks of **any project**; adding a task needs read access to its plan, and the workspace subscribes to live changes of those projects. Deleting a plan removes its tasks from every timeline. Timelines are listed after the plans in the Project panel's structure tree.
  - Entries stored before placement existed read as bars spread over three lines, and callouts stored with a numbered line read at that line's position (`normalizeTimelineEntries`). SQL migrations `0003_timeline_entry_layout` and `0004_timeline_callout_offset` add the columns.
- **Using tasks in other plans**: tasks are dragged from a plan's Task List onto another plan's Gantt or Task List panel. This adds a MONITOR reference in that plan, also for plans of subprojects opened in the workspace. Dropping an internal task asks to make it external first. The task dialog's "Use in another plan" lists the plans using the task with their MON/AGR type, offers the upgrade to AGREEMENT, and adds the task to another plan of the project tree with a chosen type.
- **Calendar view**: day/week/month/year; tasks shown as events, milestones as markers.
- **Status indicators**: internal/external, MONITOR/AGREEMENT, pending approval, rejected, variance against agreed. Plans show MON/AGR on references, and owner plans on their external tasks: one badge per type in use, its tooltip listing the plans.
- **Proposed task changes** (`PROPOSE_TASK_CHANGE`) are drawn in the Gantt as a dashed outline at the proposed dates, in the proposing plan and the owner plan (`PlanView.proposedChanges`), until the owner decides.
- **Approval inbox**: list of ChangeRequests the user needs to act on, in the workspace's project and its subprojects. The task dialogs (own and external tasks) also list the open requests covering that task (`ChangeRequestService.pendingForItem`), with Approve/Reject where the user may decide. Both use the same decision endpoint (UI only).
- Live updates via WebSocket when other users change data.

### Gantt library: DHTMLX Gantt Community Edition (MIT)

- Package: `dhtmlx-gantt` v10+ (MIT, shipped as TypeScript/JS source). Do **not** use PRO-only APIs; `dhtmlxgantt.d.ts` also lists PRO methods that do not exist in this edition.
- Framework-agnostic; wrap it in our own component. PRO framework wrappers are not available.
- Features **not** in the Community Edition that this system needs, and which we build ourselves:
  - **Baseline overlay** (multiple baselines per bar) — rendered as our own layer positioned with the Gantt's date-to-pixel API and kept in sync on scroll/zoom.
  - **Working-time calendars** — calculated in `/shared/time` and on the server, not by the Gantt.
  - **Today line** — implemented in the overlay layer with `posFromDate()`; the chart's date range always includes today.
  - **Markers**, **undo/redo**, **multi-select and horizontal drag** — implement in our own UI layer if needed.
- Auto-scheduling, critical path and resources are out of scope for the Gantt component; any scheduling logic lives in `/server/services`.
- Keep all DHTMLX-specific code behind an adapter in `/client/views/gantt` so the library can be replaced (or upgraded to PRO) without touching the rest of the client.
- **Panel resizes**: Dockview resizes panels and moves them between groups without a window resize. DHTMLX's own size watcher (a hidden iframe) stops working once the panel is moved, so the adapter re-renders from a `ResizeObserver` on its container; the calendar view does the same with FullCalendar's `updateSize()`. Any other view that measures its container needs the same (ar-timeline-view does this itself). Guard against re-layout loops: ignore size changes under 1px (fractional display scaling), never derive a size from a `scrollHeight` the element itself contributes to, and keep the workspace page from scrolling (`body:has(.pp-workspace)`), since a page scrollbar's width shifts every panel.
- Do not modify the library source in place. If a patch is unavoidable, keep it in `/client/vendor-patches` with a note explaining why.

## 8. Reports

- The user selects content: one or more plans, timelines, calendar views, baselines to overlay, time span, filters and granularity.
- The setup is saved as a **ReportDefinition** and can be rerun at any time (against current data or a specific baseline/date).
- Export formats: PDF and HTML first; Excel/CSV for tabular data.
- Report generation must be deterministic: same definition + same data snapshot = same result.

## 9. Storage

### StorageAdapter (contract)

Both adapters implement the same interface. Write tests against the interface and run them for both.

```ts
interface StorageAdapter {
  // CRUD for all entities
  get<T>(type: EntityType, id: string): Promise<T | null>;
  query<T>(type: EntityType, filter: Filter): Promise<T[]>;
  save<T extends Versioned>(type: EntityType, entity: T): Promise<T>; // optimistic locking
  delete(type: EntityType, id: string, version: number): Promise<void>;
  // Transaction for atomic acceptance
  transaction<R>(fn: (tx: StorageAdapter) => Promise<R>): Promise<R>;
}
```

- All entities have `id` (UUID), `version` (integer), `createdAt/By`, `updatedAt/By`.
- **Optimistic locking**: `save` fails with `ConflictError` if `version` does not match. `version: 0` means create; the stored version is then 1.
- `query` accepts equality filters only on the fields listed in `QUERYABLE_FIELDS` (both adapters enforce the same list). Results are ordered by id.
- Inside `transaction(fn)`, use only the `tx` adapter passed to `fn`. SQLite has a single connection, so calling the outer adapter inside a transaction deadlocks.
- The audit log is append-only at the storage level: updating or deleting entries fails. Entry ids are time-ordered (UUIDv7 with a counter, `timeOrderedId`), so entries written in the same millisecond keep their order.

### FileAdapter

```
data/
  .lock                             (held while a transaction commits)
  users/<userId>.json, parties/<partyId>.json, oauth-clients/<clientId>.json
  audit/<yyyy-mm>.jsonl             (entries without a project)
  projects/<projectId>/
    project.json
    plans/<planId>.json
    items/<itemId>.json
    references/<referenceId>.json
    baselines/<baselineId>.json     (tracks, snapshots, branches; locked ones are never modified)
    baselineDefinitions/<id>.json
    links.json, dependencies.json, roles.json
    changeRequests/<id>.json, approvals/<id>.json
    timelines/, reports/, workspaces/
    audit/<yyyy-mm>.jsonl           (append-only)
```

- Write atomically: every write goes through a transaction that buffers changes, writes all temp files, then renames them into place.
- One lock for the whole data directory (an in-process mutex plus an exclusive `.lock` file for other processes), instead of one lock per project: a transaction does not know in advance which projects it will touch.
- Suitable for small teams / simple installations.

### SqlAdapter

- Migrations versioned in `/server/storage/sql/migrations`. Never modify a migration that has been run.
- Core tables: `project, plan, plan_item, plan_item_reference, plan_link, dependency, baseline, baseline_item, baseline_definition, change_request, approval, timeline, timeline_entry, workspace, report_definition, app_user, party, oauth_client, role_assignment, audit_log`.
- `baseline_item` stores a snapshot of dates/duration per item per baseline.
- Table layout (`storage/sql/tables.ts`): every entity table has `id`, `version`, `created_at`, `updated_at`, a `data` column holding the entity as JSON, and real indexed columns for each queryable field. `baseline_item` and `timeline_entry` are fully relational child tables. Adding a field that is not queryable (e.g. the project's `parentProjectId`, `projectType`, `active`) needs no migration: it lives in `data`.
- Migrations are registered statically in `migrations/index.ts` (no file scanning) and import from `kysely/migration`. The server runs pending migrations at startup; `npm run migrate` does the same on demand.
- SQL Server connection strings use the URL form `mssql://user:pass@host:1433/db?encrypt=true&trustServerCertificate=false`.
- Use parameterised queries; no string concatenation of SQL.

## 10. Access control and multi-user

- Roles per project/plan: `ADMIN`, `PLAN_OWNER`, `EDITOR`, `APPROVER`, `VIEWER`.
- Parties represent organisations/teams in approvals; a user can represent a party.
- All access control is enforced in the server.
- All changes and approvals are written to the AuditLog.

## 11. Conventions for Claude

- Business rules (acceptance, approval, link types) belong in `/server/domain` and `/server/services`, with unit tests. No rules in adapters or the UI.
- When changing the data model: update shared types, both adapters, the SQL migration and this file.
- Every new feature that touches storage must be tested against **both** backends.
- Dates/times: use only the helper module in `/shared/time`.
- Locked baselines must never be modifiable — add a test if you touch baseline code.
- All project language is English: UI text, code, identifiers, comments and documentation.
- Do not introduce new dependencies without justifying them in the PR description.

## 12. Tooling and commands

### Tools

| Area | Tool |
|---|---|
| Monorepo | npm workspaces: `client`, `server`, `shared` |
| Client build/dev | Vite (React + TypeScript) + `vite-plugin-singlefile` (one `index.html` that runs hosted or from `file://`); dev server proxies `/api` and WebSocket to the server |
| Server dev | tsx (watch mode) |
| Server build | tsc |
| SQL / migrations | Kysely (PostgreSQL, SQLite, SQL Server) |
| Unit/integration tests | Vitest (client, server, shared) |
| Backend tests | Testcontainers for PostgreSQL and SQL Server; SQLite and FileAdapter in-process |
| End-to-end tests | Playwright |
| Lint/format | ESLint (typescript-eslint, react-hooks) + Prettier |
| Type check | `tsc --noEmit` across all packages (Vite and tsx do not type-check) |

- The `StorageAdapter` contract test suite is parameterised and runs against every backend: file, SQLite, PostgreSQL, SQL Server. Service and MCP tests run against file and SQLite (`server/src/testing/backends.ts`).
- Testcontainers requires Docker. Backend tests that need Docker can be skipped locally with `SKIP_CONTAINER_TESTS=1`, but always run in CI.
- TypeScript is pinned to 6.0: TypeScript 7 (native) is not yet supported by typescript-eslint.
- `@planning/shared` is consumed from source during development through the `source` export condition (tsx `--conditions=source`, Vite/Vitest `resolve.conditions`, `customConditions` in tsconfig). The server production build uses `shared/dist`, so `npm run build` builds shared first.
- `npm run dev` uses `config.dev.json` (file backend in `./data`, local auth) via `server/.env.development`.
- The config file may contain `//` comments.

### Commands

```
npm install                 # install all workspaces
npm run dev                 # server (tsx watch) + client (Vite) together
npm run build               # build shared, server and client
npm run typecheck           # tsc --noEmit for all packages
npm run lint                # ESLint
npm run format              # Prettier (write)
npm test                    # Vitest, all packages, all backends
npm run test:e2e            # Playwright
npm run migrate             # run Kysely migrations against the configured SQL database
npm run migrate:make <name> # create a new migration
```

Before considering a change done: `npm run typecheck`, `npm run lint` and `npm test` must pass.

## 13. Open decisions

- **SAML** is not implemented: `auth.sso.protocol: "saml"` fails at startup with a clear message. OIDC is implemented. Adding SAML needs a library (e.g. `@node-saml/node-saml`) and a test IdP.
- **Sessions** are kept in server memory: a restart signs everyone out, and the server must run as a single process (also assumed by the in-process event bus for live updates). Multi-instance deployments need a shared session store and event bus.
- **MCP authentication**: OAuth 2.1 (`mcp.oauth`) or the UI's bearer session tokens. OAuth codes and tokens are kept in memory, so after a restart a connected client signs in again; its registration is stored and still valid. Long-lived agent tokens, Client ID Metadata Documents (only dynamic client registration is offered) and rate limiting of the password sign-in (also missing on `/api/auth/login`) are not implemented.
- **Working calendars** are evaluated in UTC (working hours and dates). Per-project time zones are not supported yet.
- **PDF export** is a dependency-free, text-only renderer. A richer layout (e.g. Gantt images) needs a decision on a rendering library.
- **Scheduling across dependencies**: dependencies are stored, drawn and checked (violations are flagged), but successors are not moved automatically (by design: auto-scheduling is out of scope for the Gantt; any future scheduling belongs in `/server/services`).
