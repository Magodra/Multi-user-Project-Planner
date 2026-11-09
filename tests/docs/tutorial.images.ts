/**
 * Plays the story of docs/tutorial.md and saves its pictures to docs/images/tutorial.
 * Bulk data is seeded through the REST API; the steps a picture shows go through the UI.
 */
import path from "node:path";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { TUTORIAL_NOW } from "./now.js";

const API = "http://localhost:8182/api";
const PASSWORD = "tutorial-password";
const OUT = path.resolve("docs/images/tutorial");

type Entity = { id: string; version: number; token?: string };
type Client = {
  get<T = Entity>(url: string): Promise<T>;
  post(url: string, body?: unknown): Promise<Entity>;
  put(url: string, body: unknown): Promise<Entity>;
  patch(url: string, body: unknown): Promise<Entity>;
};

function client(request: APIRequestContext, token: string): Client {
  const call = async <T>(method: "get" | "post" | "put" | "patch", url: string, data?: unknown) => {
    const res = await request[method](`${API}${url}`, {
      headers: { Authorization: `Bearer ${token}` },
      ...(method === "get" ? {} : { data: data ?? {} }),
    });
    if (!res.ok()) throw new Error(`${method} ${url}: ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return {
    get: (url) => call("get", url),
    post: (url, body) => call("post", url, body),
    put: (url, body) => call("put", url, body),
    patch: (url, body) => call("patch", url, body),
  };
}

const date = (day: string) => `${day}T00:00:00.000Z`;

test("tutorial pictures", async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(15_000);
  await page.clock.setFixedTime(new Date(TUTORIAL_NOW));

  // ---- The company: people and parties ----
  const setup = await request.post(`${API}/auth/setup`, {
    data: {
      username: "sam",
      displayName: "Sam Okafor",
      email: "sam@kestrel.example",
      password: PASSWORD,
    },
  });
  const sam = client(request, ((await setup.json()) as { token: string }).token);
  const parties: Record<string, Entity> = {};
  for (const name of ["Kestrel Marine Systems", "Port of Eastmere"])
    parties[name] = await sam.post("/parties", { name });
  const users: Record<string, Entity & { client: Client }> = {};
  for (const [username, displayName, party] of [
    ["priya", "Priya Nair", "Kestrel Marine Systems"],
    ["tomas", "Tomas Lindgren", "Kestrel Marine Systems"],
    ["ada", "Ada Chen", "Kestrel Marine Systems"],
    ["marta", "Marta Silva", "Port of Eastmere"],
  ] as const) {
    const user = await sam.post("/users", {
      username,
      displayName,
      email: `${username}@example.test`,
      password: PASSWORD,
      partyIds: [parties[party]!.id],
    });
    const login = await request.post(`${API}/auth/login`, {
      data: { username, password: PASSWORD },
    });
    const { token } = (await login.json()) as { token: string };
    users[username] = { ...user, client: client(request, token) };
  }
  const priya = users.priya!.client;
  const tomas = users.tomas!.client;
  const ada = users.ada!.client;
  const marta = users.marta!.client;

  // ---- Projects (Control Software is created in the UI below) ----
  const programme = await priya.post("/projects", {
    name: "Eastmere Crane Automation",
    projectType: "Customer programme",
    description: "Automating the four container cranes at the Port of Eastmere",
  });
  const retrofit = await priya.post("/projects", {
    name: "Crane Retrofit",
    projectType: "Engineering",
    description: "Mechanical and electrical work on the cranes",
    parentProjectId: programme.id,
  });
  await priya.post("/projects", {
    name: "Workshop Renewal",
    projectType: "Internal",
    description: "New test bay in the Kestrel workshop",
  });

  // ---- Helpers for the browser ----
  const shot = async (name: string, target?: Locator) => {
    await page.waitForTimeout(500); // let bars, overlays and fonts settle
    const file = path.join(OUT, `${name}.png`);
    if (target) await target.screenshot({ path: file });
    else await page.screenshot({ path: file });
  };
  const signIn = async (username: string) => {
    await page.goto("");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  };
  const openProject = async (name: string) => {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page.locator(".pp-project-name")).toHaveText(name);
  };
  const menu = (name: string | RegExp) =>
    page.locator(".pp-topbar").getByRole("button", { name }).click();
  const tree = page.getByRole("tree", { name: "Project structure" });
  const openPlanFromTree = async (name: string) => {
    await menu("Project");
    await tree.getByRole("button", { name, exact: true }).click();
  };
  const row = (name: string) => page.locator(".gantt_row:visible", { hasText: name });
  const dialog = page.getByRole("dialog");
  const fit = () => page.getByRole("button", { name: "Fit", exact: true }).click();
  const closeDialog = async () => {
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  const dockLeft = (tab: string) =>
    page
      .getByRole("tab", { name: tab })
      .dragTo(page.locator(".dv-groupview").first(), { targetPosition: { x: 5, y: 200 } });
  /** Press, travel to the target and stay there; the caller takes a picture, then releases. */
  const dragAndHold = async (from: Locator, to: Locator) => {
    const a = (await from.boundingBox())!;
    const b = (await to.boundingBox())!;
    const x = a.x + 4;
    await page.mouse.move(x, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(x + 20, a.y + a.height / 2, { steps: 5 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  };

  // ---- Part 1: Priya sets up the programme ----
  await signIn("priya");
  await page.getByPlaceholder("New project name").fill("Control Software");
  await page
    .getByLabel("Parent project", { exact: true })
    .selectOption({ label: "Eastmere Crane Automation" });
  await shot("01-new-subproject");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("link", { name: "Control Software" })).toBeVisible();
  await shot("02-project-tree");

  const projects = await priya.get<(Entity & { name: string })[]>("/projects");
  const software = projects.find((p) => p.name === "Control Software")!;

  // Plans
  const plan = (project: Entity, name: string, planType: string) =>
    priya.post(`/projects/${project.id}/plans`, { name, planType });
  const contract = await plan(programme, "Customer contract", "contract");
  const master = await plan(programme, "Programme master", "internal");
  const retrofitPlan = await plan(retrofit, "Retrofit plan", "internal");
  const softwarePlan = await plan(software, "Software plan", "internal");

  // Roles: everyone can see the whole programme; each lead owns one plan.
  const everywhere = [programme, retrofit, software];
  for (const project of everywhere)
    for (const who of ["tomas", "ada"])
      await priya.post(`/projects/${project.id}/members`, {
        userId: users[who]!.id,
        planId: null,
        role: "VIEWER",
      });
  await priya.post(`/projects/${retrofit.id}/members`, {
    userId: users.tomas!.id,
    planId: retrofitPlan.id,
    role: "PLAN_OWNER",
  });
  await priya.post(`/projects/${software.id}/members`, {
    userId: users.ada!.id,
    planId: softwarePlan.id,
    role: "PLAN_OWNER",
  });
  const expanded = { expandedProjectIds: [programme.id] };
  for (const who of [priya, tomas, ada, marta]) await who.put("/users/me/preferences", expanded);

  // Marta, the customer's representative, owns the contract plan: added in the UI.
  await signIn("priya");
  await openProject("Eastmere Crane Automation");
  await menu("Project");
  await page.getByLabel("User", { exact: true }).selectOption({ label: "Marta Silva" });
  await page.getByLabel("Plan", { exact: true }).selectOption({ label: "Customer contract" });
  await page.getByLabel("Role", { exact: true }).selectOption("PLAN_OWNER");
  await tree.getByRole("button", { name: "Expand Crane Retrofit" }).click();
  await tree.getByRole("button", { name: "Expand Control Software" }).click();
  await shot("03-project-panel");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.locator("td", { hasText: "Marta Silva" }).first()).toBeVisible();

  // Seed the plans.
  const add = (
    planId: Entity,
    who: Client,
    name: string,
    start: string,
    duration: number,
    extra: { parentId?: string; ownership?: "EXTERNAL" } = {},
  ) =>
    who.post("/items", {
      planId: planId.id,
      name,
      start: date(start),
      duration,
      granularity: "days",
      ...extra,
    });
  const R = (name: string, start: string, days: number, extra = {}) =>
    add(retrofitPlan, tomas, name, start, days, extra);
  const engineering = await R("Engineering", "2026-08-03", 10);
  await R("Mechanical design", "2026-08-03", 15, { parentId: engineering.id });
  const elec = await R("Electrical design", "2026-08-10", 15, { parentId: engineering.id });
  const review = await R("Design review", "2026-08-31", 0, { parentId: engineering.id });
  const procurement = await R("Procurement", "2026-09-01", 10);
  const order = await R("Order drives and sensors", "2026-09-01", 10, {
    parentId: procurement.id,
  });
  const delivery = await R("Factory delivery", "2026-09-21", 8, { parentId: procurement.id });
  await R("Installation", "2026-10-05", 10);
  const predecessors = (who: Client, item: Entity, value: string) =>
    who.put(`/items/${item.id}/predecessors`, { predecessors: value });
  await predecessors(tomas, elec, "2SS+5d");
  await predecessors(tomas, review, "3");
  await predecessors(tomas, order, "4");
  await predecessors(tomas, delivery, "6");

  const S = (name: string, start: string, days: number) =>
    add(softwarePlan, ada, name, start, days);
  await S("Control architecture", "2026-08-17", 10);
  await S("PLC programming", "2026-09-01", 25);
  await S("HMI screens", "2026-09-14", 20);
  const integration = await S("Sensor integration", "2026-10-26", 8);
  await S("Software release", "2026-11-06", 0);

  const C = (name: string, start: string, days: number, extra = {}) =>
    add(contract, priya, name, start, days, extra);
  await C("Design approved by customer", "2026-09-16", 0);
  await C("Site survey", "2026-09-21", 4);
  const fat = await C("Factory acceptance test", "2026-11-16", 5, { ownership: "EXTERNAL" });
  await C("Site acceptance test", "2026-12-07", 5);
  await C("Handover", "2026-12-18", 0, { ownership: "EXTERNAL" });

  const M = (name: string, start: string, days: number) => add(master, priya, name, start, days);
  await M("Programme management", "2026-08-03", 90);
  await M("Steering committee 3", "2026-09-25", 0);
  await M("Steering committee 4", "2026-10-23", 0);
  await priya.post("/references", { itemId: fat.id, planId: master.id, linkType: "MONITOR" });

  // ---- Part 2: Tomas builds the retrofit plan ----
  await signIn("tomas");
  await openProject("Crane Retrofit");
  await openPlanFromTree("Retrofit plan");
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Sensor installation");
  await dialog.getByLabel("Start", { exact: true }).fill("2026-10-05");
  await dialog.getByLabel("Duration", { exact: true }).fill("10");
  await dialog.getByLabel("Parent", { exact: true }).selectOption({ label: "Installation" });
  await dialog.getByLabel("Ownership").selectOption("EXTERNAL");
  await dialog.getByLabel("Predecessors").fill("7");
  await shot("04-task-dialog");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row("Sensor installation")).toBeVisible();

  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Drive installation");
  await dialog.getByLabel("Start", { exact: true }).fill("2026-09-28");
  await dialog.getByLabel("Duration", { exact: true }).fill("10");
  await dialog.getByLabel("Parent", { exact: true }).selectOption({ label: "Installation" });
  await dialog.getByLabel("Predecessors").fill("7");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row("Drive installation")).toContainText("⚠ DEP");
  await fit();
  await shot("06-dependency-warning");

  await row("Drive installation").dblclick();
  await dialog.getByLabel("Start", { exact: true }).fill("2026-10-12");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row("Drive installation")).not.toContainText("⚠ DEP");
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Mechanical complete");
  await dialog.getByLabel("Start", { exact: true }).fill("2026-10-30");
  await dialog.getByLabel("Duration", { exact: true }).fill("0");
  await dialog.getByLabel("Parent", { exact: true }).selectOption({ label: "Installation" });
  await dialog.getByLabel("Ownership").selectOption("EXTERNAL");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row("Mechanical complete")).toBeVisible();
  await fit();
  await shot("05-gantt-plan");

  // ---- Part 3: Priya connects the plans ----
  await signIn("priya");
  await openProject("Eastmere Crane Automation");
  await openPlanFromTree("Retrofit plan");
  await page.getByRole("button", { name: "Task List", exact: true }).click();
  await openPlanFromTree("Software plan");
  await dockLeft("Tasks: Retrofit plan");
  const softwareGantt = page.locator(".pp-gantt-panel:visible");
  await expect(softwareGantt).toBeVisible();
  await expect(softwareGantt.locator(".gantt_row", { hasText: "HMI" })).toBeVisible();
  await dragAndHold(
    page.locator(".pp-outline-row", { hasText: "Sensor installation" }),
    softwareGantt,
  );
  await shot("07-drag-to-plan");
  await page.mouse.up();
  await expect(row("Sensor installation")).toContainText("MON");
  await row("Sensor installation").dblclick();
  page.once("dialog", (d) => void d.accept());
  await dialog.getByRole("button", { name: "Upgrade to AGREEMENT", exact: true }).click();
  await expect(dialog).toContainText("AGREEMENT: changes are proposed");
  await shot("08-upgrade-agreement");
  await closeDialog();
  await expect(row("Sensor installation")).toContainText("AGR");

  // More uses of the shared tasks, and the local link to the external task.
  const view = (planId: Entity) =>
    priya.get<{ items: (Entity & { name: string })[] }>(`/plans/${planId.id}/view`);
  const retrofitItems = async () => (await view(retrofitPlan)).items;
  const byName = async (name: string) => (await retrofitItems()).find((i) => i.name === name)!;
  const sensors = await byName("Sensor installation");
  const complete = await byName("Mechanical complete");
  await priya.post("/references", {
    itemId: complete.id,
    planId: master.id,
    linkType: "MONITOR",
  });
  await priya.post("/references", {
    itemId: sensors.id,
    planId: master.id,
    linkType: "MONITOR",
  });
  await ada.post("/dependencies", {
    fromItemId: sensors.id,
    toItemId: integration.id,
    planId: softwarePlan.id,
    type: "FS",
  });

  // ---- Part 4: Tomas commits and approves ----
  await signIn("tomas");
  await openProject("Crane Retrofit");
  await expect(row("Electrical design")).toBeVisible();
  await fit();
  await shot("09-owner-badges");
  await row("Electrical design").dblclick();
  await dialog.getByRole("button", { name: "Request: Estimated → Current", exact: true }).click();
  await menu(/Approvals/);
  const card = page.getByTestId("approval-card").filter({ hasText: "Electrical design" });
  await expect(card).toBeVisible();
  await card.getByLabel("Comment").fill("Reviewed with the electrical team.");
  await shot("10-approval-inbox");
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card).toHaveCount(0);

  // ---- Part 5: negotiating a change ----
  await signIn("ada");
  await openProject("Control Software");
  await openPlanFromTree("Software plan");
  await row("Sensor installation").dblclick();
  await dialog.getByLabel("Duration").fill("14");
  await dialog
    .getByLabel("Reason for the change")
    .fill("We need the extra days to calibrate the sensors with the PLC.");
  await shot("11-propose-change");
  await dialog.getByRole("button", { name: "Propose change", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await fit();
  await expect(page.locator(".pp-proposal-bar:visible")).toHaveCount(1);
  await shot("12-proposal-outline");

  await signIn("tomas");
  await openProject("Crane Retrofit");
  await expect(row("Sensor installation")).toBeVisible();
  await row("Sensor installation").dblclick();
  const pending = dialog.getByTestId("task-approvals");
  await expect(pending).toContainText("Sensor installation");
  await pending.getByLabel("Comment").fill("Agreed, the crew can stay on site.");
  await shot("13-decide-in-dialog");
  await pending.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(pending).toHaveCount(0);
  await closeDialog();

  // The owner's own schedule change now needs Ada's approval.
  await row("Sensor installation").dblclick();
  await dialog.getByLabel("Start", { exact: true }).fill("2026-10-12");
  await dialog.getByLabel("Reason for the change").fill("The drives arrive a week late.");
  await shot("14-owner-proposal");
  await dialog.getByRole("button", { name: "Propose change", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await signIn("ada");
  await openProject("Control Software");
  await menu(/Approvals/);
  const adaCard = page.getByTestId("approval-card").filter({ hasText: "Sensor installation" });
  await adaCard.getByLabel("Comment").fill("Fine, integration starts after it anyway.");
  await adaCard.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(adaCard).toHaveCount(0);

  await signIn("tomas");
  await openProject("Crane Retrofit");
  await page.getByRole("tab", { name: "Retrofit plan" }).click();
  await row("Sensor installation").dblclick();
  await dialog.getByRole("tab", { name: "Audit log", exact: true }).click();
  await expect(dialog.getByTestId("task-audit-log")).toContainText("Approved for");
  await shot("15-audit-log");
  await closeDialog();

  // ---- Part 6: baselines ----
  const whole = await tomas.post("/change-requests", {
    planId: retrofitPlan.id,
    targetTrack: "CURRENT",
    itemIds: [],
    title: "Commit the retrofit plan",
  });
  const decideAll = async (who: string, created: Entity) => {
    const decider = users[who]!.client;
    const { changeRequest } = created as unknown as { changeRequest: Entity };
    const cr = await decider.get<{ approvals: (Entity & { status: string })[] }>(
      `/change-requests/${changeRequest.id}`,
    );
    for (const a of cr.approvals.filter((x) => x.status === "PENDING"))
      await decider.post(`/approvals/${a.id}/decision`, { decision: "APPROVE" });
  };
  await decideAll("tomas", whole);

  await page.getByRole("button", { name: "Baselines & approvals", exact: true }).click();
  await page.getByPlaceholder("Snapshot name").fill("Design freeze");
  await page.getByRole("button", { name: /Snapshot \(locked\)/ }).click();
  await expect(page.locator(".pp-tree-row", { hasText: "Design freeze" })).toBeVisible();
  await shot("16-baselines-panel");

  // Real progress: procurement slips, Sensor-free tasks move at once.
  await page.getByRole("tab", { name: "Retrofit plan", exact: true }).click();
  await row("Factory delivery").dblclick();
  await dialog.getByLabel("Start", { exact: true }).fill("2026-09-28");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await row("Drive installation").dblclick();
  await dialog.getByLabel("Start", { exact: true }).fill("2026-10-19");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator(".pp-menu summary", { hasText: "Baselines" }).click();
  await page.locator(".pp-menu-body label", { hasText: "Design freeze" }).locator("input").check();
  await page.locator(".pp-menu summary", { hasText: "Baselines" }).click();
  await fit();
  await shot("17-baseline-overlay");

  // ---- Part 7: agreeing with the customer ----
  const toCurrent = await priya.post("/change-requests", {
    planId: contract.id,
    targetTrack: "CURRENT",
    itemIds: [fat.id],
    title: "Commit the factory acceptance test",
  });
  await decideAll("marta", toCurrent);
  await signIn("priya");
  await openProject("Eastmere Crane Automation");
  await openPlanFromTree("Customer contract");
  await row("Factory acceptance test").dblclick();
  await dialog.getByRole("button", { name: "Request: Current → Agreed", exact: true }).click();
  await closeDialog().catch(() => undefined);

  await signIn("marta");
  await openProject("Eastmere Crane Automation");
  await menu(/Approvals/);
  const agreed = page.getByTestId("approval-card").filter({ hasText: "Factory acceptance" });
  await expect(agreed.first()).toBeVisible();
  await agreed.first().getByLabel("Comment").fill("Dates match the contract annex.");
  await shot("18-customer-approval");

  // ---- Part 8: timeline, calendar and report ----
  // An open proposal, so the roadmap has something pending.
  const softwareView = await ada.get<{ references: { id: string }[] }>(
    `/plans/${softwarePlan.id}/view`,
  );
  await ada.post(`/references/${softwareView.references[0]!.id}/propose`, {
    start: date("2026-10-19"),
    duration: 12,
    granularity: "days",
    description: "Earlier start to protect the release",
  });

  const rows = [
    { id: "mech", name: "Mechanical" },
    { id: "soft", name: "Software" },
    { id: "cust", name: "Customer" },
  ];
  const created = await priya.post(`/projects/${programme.id}/timelines`, {
    name: "Programme roadmap",
    start: date("2026-08-01"),
    end: date("2027-01-01"),
    scale: "months",
    rows,
  });
  const items = await retrofitItems();
  const id = (name: string) => items.find((i) => i.name === name)!.id;
  const entry = (
    entryId: string,
    rowId: string,
    itemId: string,
    planId: Entity,
    placement: "above" | "on" | "below",
    line: number,
  ) => ({ id: entryId, rowId, itemId, planId: planId.id, placement, line });
  await priya.patch(`/timelines/${created.id}`, {
    version: created.version,
    entries: [
      entry("e1", "mech", id("Engineering"), retrofitPlan, "on", 0),
      entry("e2", "mech", id("Installation"), retrofitPlan, "on", 0),
      entry("e3", "mech", id("Sensor installation"), retrofitPlan, "on", 1),
      {
        ...entry("e4", "mech", id("Design review"), retrofitPlan, "above", 0),
        calloutX: 30,
        calloutY: -30,
      },
      entry("e5", "soft", integration.id, softwarePlan, "on", 0),
    ],
  });

  await signIn("priya");
  await openProject("Eastmere Crane Automation");
  await page.getByRole("tab", { name: "Tasks: Retrofit plan" }).click();
  await page.getByRole("button", { name: "Close Tasks: Retrofit plan" }).click();
  await menu("Project");
  await tree.getByRole("button", { name: "Programme roadmap", exact: true }).click();
  await expect(page.locator(".tlv-task", { hasText: "Engineering" })).toBeVisible();
  await openPlanFromTree("Customer contract");
  await page.getByRole("button", { name: "Task List", exact: true }).click();
  await page.getByRole("tab", { name: "Programme roadmap" }).click();
  await dockLeft("Tasks: Customer contract");
  const customerRow = page.locator(".tlv-timeline").nth(2);
  await expect(customerRow).toBeVisible();
  await dragAndHold(
    page.locator(".pp-outline-row", { hasText: "Handover" }),
    customerRow.locator('.tlv-line:not(.tlv-line--new)[data-placement="on"][data-line="0"]'),
  );
  await shot("19-timeline-drag");
  await page.mouse.up();
  await expect(page.locator(".tlv-milestone", { hasText: "Handover" })).toBeVisible();
  await page.getByRole("button", { name: "Close Tasks: Customer contract" }).click();
  await expect(page.locator(".tlv-milestone", { hasText: "Handover" })).toBeVisible();
  await shot("20-timeline");

  await menu("Calendar");
  await expect(page.locator(".fc-event").first()).toBeVisible();
  await shot("21-calendar");

  await menu("Reports");
  await page.getByRole("button", { name: "+ Report", exact: true }).click();
  await page.getByLabel("Report name").fill("Programme status");
  await page.locator("fieldset label", { hasText: "Customer contract" }).locator("input").check();
  await page.locator("fieldset label", { hasText: "Programme master" }).locator("input").check();
  await shot("22-report-form");
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).first().click();
  await expect(page.getByTitle("Report preview")).toBeVisible();
  await shot("23-report");
});
