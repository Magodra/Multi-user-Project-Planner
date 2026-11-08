/** Main flows, run in both hosted and file:// mode against the same server. */
import { expect, test, type Locator, type Page } from "@playwright/test";

const API = "http://localhost:8181";
const PASSWORD = "e2e-password";

/** The first run creates the administrator; later runs (other mode) log in. */
async function signIn(page: Page) {
  await page.goto("");
  const { setupRequired } = (await (await page.request.get(`${API}/api/auth/info`)).json()) as {
    setupRequired: boolean;
  };
  await page.getByLabel("Username").fill("admin");
  if (setupRequired) await page.getByLabel("Display name").fill("E2E Admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page
    .getByRole("button", { name: setupRequired ? "Create administrator" : "Sign in" })
    .click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
}

/** Drag with real pointer events, past dnd-kit's and the timeline's drag thresholds. */
async function dragWithMouse(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  const x = a.x + 4; // grab near the left edge (the remove button sits on the right)
  await page.mouse.move(x, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(x + 20, a.y + a.height / 2, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}

test("plan, accept and approve through the UI", async ({ page }, info) => {
  const projectName = `E2E ${info.project.name} ${Date.now()}`;
  await signIn(page);

  // Project + plan
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  await expect(page.locator(".pp-project-name")).toHaveText(projectName);
  await page.getByPlaceholder("Plan name").fill("Contract plan");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Contract plan", exact: true }).click();

  // Task in the Gantt
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name").fill("Design review");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".gantt_tree_content", { hasText: "Design review" })).toBeVisible();

  // Estimated → Current via change request, approved in the inbox
  await page.locator(".gantt_task_line").first().dblclick();
  await page.getByRole("button", { name: "Request: Estimated → Current", exact: true }).click();
  await page
    .locator(".pp-topbar")
    .getByRole("button", { name: /Approvals/ })
    .click();
  const card = page.getByTestId("approval-card").filter({ hasText: "Design review" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card).toHaveCount(0);

  // The baselines panel shows the accepted request
  await page.getByRole("tab", { name: "Contract plan" }).click();
  await page.getByRole("button", { name: "Baselines & approvals", exact: true }).click();
  await expect(page.locator(".pp-cr-approved").first()).toBeVisible();
});

test("drag a plan task into a timeline", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Timeline ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  await page.getByPlaceholder("Plan name").fill("Delivery");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Delivery", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name").fill("Kick-off");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Go-live");
  await page.getByRole("dialog").getByLabel("Duration", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.getByRole("button", { name: "Task List", exact: true }).click();
  page.once("dialog", (d) => void d.accept("Roadmap"));
  await page.locator(".pp-topbar summary", { hasText: "Timelines" }).click();
  await page.getByRole("button", { name: "+ New timeline", exact: true }).click();

  // Put the task list next to the timeline so both are visible for the drag.
  await page
    .getByRole("tab", { name: "Tasks: Delivery" })
    .dragTo(page.locator(".dv-groupview").first(), { targetPosition: { x: 5, y: 200 } });
  const source = page.locator(".pp-outline-row", { hasText: "Kick-off" });
  const drag = (from: Locator, to: Locator) => dragWithMouse(page, from, to);
  const firstRow = page.locator(".tlv-timeline").first();
  const area = (placement: string) => firstRow.locator(`.tlv-area[data-placement="${placement}"]`);
  const barLine = (n: number) =>
    firstRow.locator(`.tlv-line:not(.tlv-line--new)[data-placement="on"][data-line="${n}"]`);
  const bar = page.locator(".tlv-task", { hasText: "Kick-off" });
  const callout = page.locator(".tlv-callout", { hasText: "Kick-off" });
  await expect(source).toBeVisible();
  await drag(source, barLine(0));
  await expect(bar).toBeVisible();

  // Out of the timeline into a callout above, then below, then back onto the bar.
  await drag(bar, area("above"));
  await expect(callout).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(area("above").locator(".tlv-callout", { hasText: "Kick-off" })).toBeVisible();
  await drag(callout, area("below"));
  await expect(area("below").locator(".tlv-callout", { hasText: "Kick-off" })).toBeVisible();

  // A callout's free position survives a reload of the timeline.
  const position = () => callout.evaluate((el) => (el as HTMLElement).style.marginLeft);
  const placedAt = await position();
  await page.getByRole("tab", { name: "Roadmap" }).click();
  await expect(callout).toBeVisible();
  await expect.poll(position).toBe(placedAt);

  await drag(callout, barLine(0));
  await expect(bar).toBeVisible();
  await expect(callout).toHaveCount(0);

  // A milestone is a symbol followed by its name.
  await drag(page.locator(".pp-outline-row", { hasText: "Go-live" }), barLine(0));
  const milestone = page.locator(".tlv-milestone", { hasText: "Go-live" });
  await expect(milestone.locator(".tlv-symbol--diamond")).toBeVisible();

  // Rows can be renamed and reordered.
  await page.getByPlaceholder("New row").fill("Milestones");
  await page.getByRole("button", { name: "Add row", exact: true }).click();
  const names = page.locator(".tlv-name-text");
  await expect(names).toHaveCount(2);
  await names.first().fill("Delivery work");
  await names.first().press("Enter");
  await page.locator(".tlv-timeline").nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(names.first()).toHaveText("Milestones");
  await expect(names.nth(1)).toHaveText("Delivery work");

  // The Project tab lists the timeline next to the plans and opens it.
  await page.getByRole("tab", { name: "Project" }).click();
  const tree = page.getByRole("tree", { name: "Project structure" });
  await expect(tree.locator(".pp-tree-timeline")).toContainText("Roadmap");
  await tree.getByRole("button", { name: "Roadmap", exact: true }).click();
  await expect(page.getByLabel("Timeline title")).toHaveValue("Roadmap");
});

test("edit a project's details, parent and active state", async ({ page }, info) => {
  await signIn(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const parent = `Program ${stamp}`;
  const child = `Child ${stamp}`;
  for (const name of [parent, child]) {
    await page.getByPlaceholder("New project name").fill(name);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByRole("link", { name })).toBeVisible();
  }

  const card = page.getByTestId("project-card").filter({ hasText: child });
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(`${child} renamed`);
  await dialog.getByLabel("Project type", { exact: true }).fill("Contract");
  await dialog.getByLabel("Description", { exact: true }).fill("Delivery phase");
  await dialog.getByLabel("Parent project", { exact: true }).selectOption({ label: parent });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The child is now listed inside the parent's subtree, with its type.
  const parentItem = page.locator(".pp-project-tree > li").filter({
    has: page.getByRole("link", { name: parent, exact: true }),
  });
  const renamed = parentItem.getByTestId("project-card").filter({ hasText: `${child} renamed` });
  await expect(renamed).toContainText("Contract");
  await expect(renamed).toContainText("Delivery phase");

  // The tree is expandable; the expanded state is kept in the user's profile.
  const toggle = page.getByRole("button", { name: new RegExp(`(Expand|Collapse) ${parent}$`) });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const saved = () => page.waitForResponse((r) => r.url().endsWith("/api/users/me/preferences"));
  await Promise.all([saved(), toggle.click()]);
  await expect(page.getByRole("link", { name: `${child} renamed` })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page);
  await expect(page.getByRole("link", { name: parent, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `${child} renamed` })).toHaveCount(0);
  await Promise.all([saved(), toggle.click()]);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page);
  await expect(renamed).toBeVisible();

  // Deactivate: hidden by default, shown again with the toggle.
  await renamed.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Active", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("link", { name: `${child} renamed` })).toHaveCount(0);
  await page.getByLabel(/Show inactive projects/).check();
  await expect(
    page.getByTestId("project-card").filter({ hasText: `${child} renamed` }),
  ).toContainText("Inactive");
});

test("order tasks, link them with predecessors and scale the timeline", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Gantt ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  await page.getByPlaceholder("Plan name").fill("Schedule");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  for (const name of ["Alpha", "Beta"]) {
    await page.getByRole("button", { name: "+ Task", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".gantt_row", { hasText: name })).toBeVisible();
  }

  // Task IDs and a predecessor with lag, written in task-ID notation.
  const beta = page.locator(".gantt_row", { hasText: "Beta" });
  await expect(beta).toContainText("2");
  await beta.dblclick();
  await expect(page.getByRole("heading", { name: "Edit task 2" })).toBeVisible();
  await page.getByRole("dialog").getByLabel("Predecessors").fill("1XX");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("dialog").getByLabel("Predecessors").fill("1FS+2d");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(beta).toContainText("1FS+2d");
  await expect(page.locator(".gantt_task_link")).toHaveCount(1);

  // Move Beta above Alpha.
  await beta.click();
  await page.getByRole("button", { name: "Move task up", exact: true }).click();
  await expect(page.locator(".gantt_row").first()).toContainText("Beta");
  await expect(page.getByRole("button", { name: "Move task up", exact: true })).toBeDisabled();

  // Today line and timeline scaling.
  await expect(page.locator(".pp-today-line")).toHaveCount(1);
  await page.getByLabel("Scale").selectOption("weeks");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".pp-today-line")).toBeVisible();
});

test("browse plans and subprojects in the project structure", async ({ page }, info) => {
  await signIn(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const parent = `Parent ${stamp}`;
  const child = `Child ${stamp}`;
  await page.getByPlaceholder("New project name").fill(parent);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("link", { name: parent })).toBeVisible();
  await page.getByPlaceholder("New project name").fill(child);
  await page.getByLabel("Parent project", { exact: true }).selectOption({ label: parent });
  await page.getByRole("button", { name: "Create project", exact: true }).click();

  // A plan in the subproject.
  await page.getByRole("link", { name: child }).click();
  await page.getByPlaceholder("Plan name").fill("Child plan");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Child plan", exact: true })).toBeVisible();

  // In the parent: plans first, then subprojects, expanded on demand.
  await page.getByRole("link", { name: "Planner" }).click();
  await page.getByRole("link", { name: parent }).click();
  await page.getByPlaceholder("Plan name").fill("Parent plan");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Project structure" });
  await expect(tree.getByRole("button", { name: "Parent plan", exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: "Child plan", exact: true })).toHaveCount(0);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/workspaces") && r.request().method() !== "GET" && r.ok(),
  );
  await tree.getByRole("button", { name: `Expand ${child}` }).click();
  await expect(tree.getByRole("button", { name: "Child plan", exact: true })).toBeVisible();
  await saved;

  // The expansion is saved in the workspace (a reload signs out; tokens live in memory).
  await signIn(page);
  await page.getByRole("link", { name: parent }).click();
  await page.getByRole("tab", { name: "Project" }).click();
  await expect(tree.getByRole("button", { name: "Child plan", exact: true })).toBeVisible();

  // A subproject's plan opens in this project's workspace.
  await tree.getByRole("button", { name: "Child plan", exact: true }).click();
  await expect(page.locator(".pp-project-name")).toHaveText(parent);
  await expect(page.getByRole("tab", { name: `Child plan (${child})` })).toBeVisible();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Sub task");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".gantt_row", { hasText: "Sub task" })).toBeVisible();

  // The subproject's name still leads to its own workspace.
  await page.getByRole("tab", { name: "Project" }).click();
  await tree.getByRole("link", { name: child }).click();
  await expect(page.locator(".pp-project-name")).toHaveText(child);
});

test("the Gantt follows its panel's size after moving to a new group", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Resize ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  await page.getByPlaceholder("Plan name").fill("Wide plan");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Wide plan", exact: true }).click();
  const host = page.locator(".pp-gantt-host");
  const chart = host.locator(".gantt_layout_root");
  await expect(chart).toBeVisible();

  // Drag the plan's tab to the right edge: Dockview moves the panel into a new group.
  const group = page.locator(".dv-groupview").first();
  const box = (await group.boundingBox())!;
  await page
    .getByRole("tab", { name: "Wide plan" })
    .dragTo(group, { targetPosition: { x: box.width - 5, y: box.height / 2 } });
  await expect(page.locator(".dv-groupview")).toHaveCount(2);

  // The chart fills the new, narrower panel, both now and after the panel is resized again.
  const fits = async () => {
    const [h, c] = await Promise.all([host.boundingBox(), chart.boundingBox()]);
    return Math.abs(h!.width - c!.width) < 3 && Math.abs(h!.height - c!.height) < 3;
  };
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 1500, height: 800 });
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 1000, height: 650 });
  await expect.poll(fits).toBe(true);
});

test("the task list marks external tasks", async ({ page }, info) => {
  await signIn(page);
  const projectName = `External ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  await page.getByPlaceholder("Plan name").fill("Supplier");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Supplier", exact: true }).click();
  for (const [name, ownership] of [
    ["Shared delivery", "EXTERNAL"],
    ["Internal work", "INTERNAL"],
  ] as const) {
    await page.getByRole("button", { name: "+ Task", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Ownership").selectOption(ownership);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".gantt_row", { hasText: name })).toBeVisible();
  }
  await page.getByRole("button", { name: "Task List", exact: true }).click();
  const row = (name: string) => page.locator(".pp-outline-row", { hasText: name });
  await expect(row("Shared delivery").locator(".pp-badge", { hasText: "EXT" })).toBeVisible();
  await expect(row("Internal work").locator(".pp-badge")).toHaveCount(0);
});

test("drag tasks from the task list onto another plan to monitor them", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Monitor ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  for (const plan of ["Supplier", "Customer"]) {
    await page.getByPlaceholder("Plan name").fill(plan);
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByRole("button", { name: plan, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Supplier", exact: true }).click();
  for (const [name, ownership] of [
    ["Shared delivery", "EXTERNAL"],
    ["Internal work", "INTERNAL"],
  ] as const) {
    await page.getByRole("button", { name: "+ Task", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Ownership").selectOption(ownership);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".gantt_row", { hasText: name })).toBeVisible();
  }
  await page.getByRole("button", { name: "Task List", exact: true }).click();
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByRole("button", { name: "Customer", exact: true }).click();

  // Supplier's task list on the left, Customer's Gantt on the right.
  await page
    .getByRole("tab", { name: "Tasks: Supplier" })
    .dragTo(page.locator(".dv-groupview").first(), { targetPosition: { x: 5, y: 200 } });
  const customer = page.locator(".pp-gantt-panel");
  await expect(customer).toBeVisible();
  const dragOnto = async (name: string) => {
    const from = (await page.locator(".pp-outline-row", { hasText: name }).boundingBox())!;
    const to = (await customer.boundingBox())!;
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    await page.mouse.up();
  };

  await dragOnto("Shared delivery");
  const monitored = (name: string) => customer.locator(".gantt_row", { hasText: name });
  await expect(monitored("Shared delivery")).toContainText("MON");
  // External tasks are named with their owner plan.
  await expect(monitored("Shared delivery")).toContainText("Shared delivery (from Supplier)");
  // The owner's EXT badge lists the plans using the task.
  await expect(
    page
      .locator(".pp-outline-row", { hasText: "Shared delivery" })
      .locator(".pp-badge", { hasText: "EXT 1" }),
  ).toHaveAttribute("title", "External task used in 1 other plan(s):\n• Customer");
  // It also shows how that plan uses the task.
  await expect(
    page
      .locator(".pp-outline-row", { hasText: "Shared delivery" })
      .locator(".pp-badge", { hasText: "MON" }),
  ).toHaveAttribute("title", "MONITOR link: changes are notified\n• Customer");

  // An internal task is made external first, after confirmation.
  page.once("dialog", (d) => void d.accept());
  await dragOnto("Internal work");
  await expect(monitored("Internal work")).toContainText("MON");
  await expect(
    page.locator(".pp-outline-row", { hasText: "Internal work" }).locator(".pp-badge").first(),
  ).toContainText("EXT");

  // The receiving plan upgrades a monitored task to AGREEMENT from its dialog.
  await monitored("Shared delivery").dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("MONITOR");
  page.once("dialog", (d) => void d.accept());
  await dialog.getByRole("button", { name: "Upgrade to AGREEMENT", exact: true }).click();
  await expect(dialog).toContainText("AGREEMENT: changes are proposed");
  await expect(
    dialog.getByRole("button", { name: "Upgrade to AGREEMENT", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(monitored("Shared delivery")).toContainText("AGR");
});

test("place an external task among local tasks and propose a change under AGREEMENT", async ({
  page,
}, info) => {
  await signIn(page);
  const projectName = `Agreement ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  for (const plan of ["Supplier", "Customer"]) {
    await page.getByPlaceholder("Plan name").fill(plan);
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByRole("button", { name: plan, exact: true })).toBeVisible();
  }

  // Supplier owns an external task and shares it with Customer.
  await page.getByRole("button", { name: "Supplier", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shared delivery");
  await page.getByLabel("Ownership").selectOption("EXTERNAL");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const row = (name: string) => page.locator(".gantt_row:visible", { hasText: name });
  await row("Shared delivery").dblclick();
  await page.getByLabel("Plan to use the task in").selectOption({ label: "Customer" });
  await page.getByLabel("Reference type").selectOption("AGREEMENT");
  await page.getByRole("button", { name: "Add reference", exact: true }).click();
  await expect(page.locator(".pp-used-in li", { hasText: "Customer" })).toContainText("AGR");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

  // Customer places it under a local task and proposes a longer duration.
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByRole("button", { name: "Customer", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Integration");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await row("Shared delivery").dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "External task" })).toBeVisible();
  // The external task got local ID 1 when it was added, so Integration is 2.
  await dialog.getByLabel("Parent in this plan").selectOption({ label: "2 Integration" });
  await dialog.getByLabel("Duration").fill("8");
  await dialog.getByLabel("Reason for the change").fill("Integration needs more time");
  await dialog.getByRole("button", { name: "Propose change", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row("Integration").locator(".gantt_close")).toHaveCount(1); // now a parent
  await expect(row("Shared delivery")).toContainText("PEND");
  await expect(row("Shared delivery")).toContainText("5 days"); // unchanged until approved
  // The proposal is drawn as a dashed outline at the proposed dates.
  const outline = page.locator(".pp-proposal-bar:visible");
  await expect(outline).toHaveCount(1);
  const bar = (await page
    .locator(".gantt_task_line:visible", { hasText: "Shared delivery" })
    .boundingBox())!;
  expect((await outline.boundingBox())!.width).toBeGreaterThan(bar.width * 1.3);

  // The owner approves; the task changes everywhere.
  await page
    .locator(".pp-topbar")
    .getByRole("button", { name: /Approvals/ })
    .click();
  const card = page.getByTestId("approval-card").filter({ hasText: "Change: Shared delivery" });
  await expect(card).toContainText("task change");
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("tab", { name: "Customer" }).click();
  await expect(row("Shared delivery")).toContainText("8 days");
  await expect(outline).toHaveCount(0);
});

test("use tasks in subproject plans, choose the reference type and upgrade it", async ({
  page,
}, info) => {
  await signIn(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const parent = `Main ${stamp}`;
  const child = `Sub ${stamp}`;
  await page.getByPlaceholder("New project name").fill(parent);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("link", { name: parent })).toBeVisible();
  await page.getByPlaceholder("New project name").fill(child);
  await page.getByLabel("Parent project", { exact: true }).selectOption({ label: parent });
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: child }).click();
  await page.getByPlaceholder("Plan name").fill("Sub plan");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sub plan", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Planner" }).click();
  await page.getByRole("link", { name: parent }).click();
  for (const plan of ["Owner", "Other"]) {
    await page.getByPlaceholder("Plan name").fill(plan);
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByRole("button", { name: plan, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Owner", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shared");
  await page.getByLabel("Ownership").selectOption("EXTERNAL");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Task List", exact: true }).click();

  // Open the subproject's plan in this workspace and drag the task onto it.
  await page.getByRole("tab", { name: "Project" }).click();
  const tree = page.getByRole("tree", { name: "Project structure" });
  await tree.getByRole("button", { name: `Expand ${child}` }).click();
  await tree.getByRole("button", { name: "Sub plan", exact: true }).click();
  await page
    .getByRole("tab", { name: "Tasks: Owner" })
    .dragTo(page.locator(".dv-groupview").first(), { targetPosition: { x: 5, y: 200 } });
  const subGantt = page.locator(".pp-gantt-panel:visible");
  const from = (await page.locator(".pp-outline-row", { hasText: "Shared" }).boundingBox())!;
  const to = (await subGantt.boundingBox())!;
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(subGantt.locator(".gantt_row", { hasText: "Shared" })).toContainText("MON");

  // The owner's dialog lists the plans using the task, with their type.
  await page.getByRole("tab", { name: "Owner", exact: true }).click();
  await page.locator(".gantt_row:visible", { hasText: "Shared" }).dblclick();
  const usedIn = page.getByRole("dialog").locator(".pp-used-in li");
  const subEntry = usedIn.filter({ hasText: "Sub plan" });
  await expect(subEntry).toContainText(child);
  await expect(subEntry).toContainText("MON");
  await subEntry.getByRole("button", { name: "Upgrade to AGREEMENT", exact: true }).click();
  await expect(subEntry).toContainText("AGR");
  await expect(
    subEntry.getByRole("button", { name: "Downgrade to MONITOR", exact: true }),
  ).toBeVisible();

  // Add it to another plan as AGREEMENT; plans of the subproject are offered too.
  const picker = page.getByLabel("Plan to use the task in");
  await expect(picker.locator("option", { hasText: "Other" })).toHaveCount(1);
  await picker.selectOption({ label: "Other" });
  await page.getByLabel("Reference type").selectOption("AGREEMENT");
  await page.getByRole("button", { name: "Add reference", exact: true }).click();
  await expect(usedIn.filter({ hasText: "Other" })).toContainText("AGR");
});

test("delete the selected task from the plan view", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Delete ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  await page.getByPlaceholder("Plan name").fill("Cleanup");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Cleanup", exact: true }).click();
  for (const [name, parent] of [
    ["Phase", null],
    ["Step", "Phase"],
    ["Obsolete", null],
  ] as const) {
    await page.getByRole("button", { name: "+ Task", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    if (parent) await page.getByLabel("Parent", { exact: true }).selectOption({ label: parent });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".gantt_row", { hasText: name })).toBeVisible();
  }
  const deleteButton = page.getByRole("button", { name: "Delete", exact: true });
  await expect(deleteButton).toBeDisabled();

  await page.locator(".gantt_row", { hasText: "Obsolete" }).click();
  page.once("dialog", (d) => void d.accept());
  await deleteButton.click();
  await expect(page.locator(".gantt_row", { hasText: "Obsolete" })).toHaveCount(0);

  // A task with subtasks is kept, with an explanation.
  await page.locator(".gantt_row", { hasText: "Phase" }).click();
  page.once("dialog", (d) => void d.accept());
  await deleteButton.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Delete or move the subtasks first" }),
  ).toBeVisible();
  await expect(page.locator(".gantt_row", { hasText: "Phase" })).toBeVisible();
});

test("a timeline shows pending proposals as outlines and PEND badges", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Proposals ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  for (const plan of ["Supplier", "Customer"]) {
    await page.getByPlaceholder("Plan name").fill(plan);
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByRole("button", { name: plan, exact: true })).toBeVisible();
  }
  const row = (name: string) => page.locator(".gantt_row:visible", { hasText: name });
  await page.getByRole("button", { name: "Supplier", exact: true }).click();
  for (const name of ["Delivery", "Handover"]) {
    await page.getByRole("button", { name: "+ Task", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Ownership").selectOption("EXTERNAL");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await row(name).dblclick();
    await page.getByLabel("Plan to use the task in").selectOption({ label: "Customer" });
    await page.getByLabel("Reference type").selectOption("AGREEMENT");
    await page.getByRole("button", { name: "Add reference", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  }

  // Customer proposes a longer duration for one task and zero duration for the other.
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByRole("button", { name: "Customer", exact: true }).click();
  for (const [name, duration] of [
    ["Delivery", "8"],
    ["Handover", "0"],
  ] as const) {
    await row(name).dblclick();
    await page.getByRole("dialog").getByLabel("Duration").fill(duration);
    await page.getByRole("button", { name: "Propose change", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }

  // Add both to a timeline, from the owner plan's task list.
  await page.getByRole("tab", { name: "Supplier" }).click();
  await page.getByRole("button", { name: "Task List", exact: true }).click();
  page.once("dialog", (d) => void d.accept("Roadmap"));
  await page.locator(".pp-topbar summary", { hasText: "Timelines" }).click();
  await page.getByRole("button", { name: "+ New timeline", exact: true }).click();
  await page
    .getByRole("tab", { name: "Tasks: Supplier" })
    .dragTo(page.locator(".dv-groupview").first(), { targetPosition: { x: 5, y: 200 } });
  const firstRow = page.locator(".tlv-timeline").first();
  const barLine = (n: number) =>
    firstRow.locator(`.tlv-line:not(.tlv-line--new)[data-placement="on"][data-line="${n}"]`);
  await expect(page.locator(".pp-outline-row", { hasText: "Delivery" })).toBeVisible();
  await dragWithMouse(page, page.locator(".pp-outline-row", { hasText: "Delivery" }), barLine(0));
  const bar = page.locator(".tlv-task", { hasText: "Delivery" });
  await expect(bar.locator(".pp-badge")).toHaveText("PEND");
  // Both start on the same date, so the second gets its own line.
  const newLine = firstRow.locator('.tlv-line--new[data-placement="on"][data-line="1"]');
  await dragWithMouse(page, page.locator(".pp-outline-row", { hasText: "Handover" }), newLine);
  await expect(page.locator(".tlv-task", { hasText: "Handover" }).locator(".pp-badge")).toHaveText(
    "PEND",
  );

  // A rectangle for the longer duration, a diamond for zero duration.
  const track = firstRow.locator(".tlv-track");
  await expect(track.locator(".pp-tl-proposal:not(.pp-tl-proposal-diamond)")).toHaveCount(1);
  await expect(track.locator(".pp-tl-proposal-diamond")).toHaveCount(1);

  // As a callout, the task keeps its badge and its outline moves to the callout area.
  const above = firstRow.locator('.tlv-area[data-placement="above"]');
  await dragWithMouse(page, bar, above);
  const callout = page.locator(".tlv-callout", { hasText: "Delivery" });
  await expect(callout.locator(".pp-badge")).toHaveText("PEND");
  await expect(above.locator(".pp-tl-proposal")).toHaveCount(1);
  await expect(track.locator(".pp-tl-proposal:not(.pp-tl-proposal-diamond)")).toHaveCount(0);

  // Deciding the request clears both, live.
  await page.getByRole("tab", { name: "Roadmap" }).click();
  await page
    .locator(".pp-topbar")
    .getByRole("button", { name: /Approvals/ })
    .click();
  for (const name of ["Delivery", "Handover"]) {
    await page
      .getByTestId("approval-card")
      .filter({ hasText: `Change: ${name}` })
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await expect(
      page.getByTestId("approval-card").filter({ hasText: `Change: ${name}` }),
    ).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "Roadmap" }).click();
  await expect(page.locator(".pp-tl-proposal")).toHaveCount(0);
  await expect(page.locator(".tlv .pp-badge")).toHaveCount(0);
});

test("the task owner approves a proposed change from the task dialog", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Approve ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  for (const plan of ["Supplier", "Customer"]) {
    await page.getByPlaceholder("Plan name").fill(plan);
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByRole("button", { name: plan, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Supplier", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shared delivery");
  await page.getByLabel("Ownership").selectOption("EXTERNAL");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const row = (name: string) => page.locator(".gantt_row:visible", { hasText: name });
  await row("Shared delivery").dblclick();
  await page.getByLabel("Plan to use the task in").selectOption({ label: "Customer" });
  await page.getByLabel("Reference type").selectOption("AGREEMENT");
  await page.getByRole("button", { name: "Add reference", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row("Shared delivery").locator(".pp-badge", { hasText: "AGR" })).toBeVisible();

  // Customer proposes a longer duration.
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByRole("button", { name: "Customer", exact: true }).click();
  await row("Shared delivery").dblclick();
  await page.getByRole("dialog").getByLabel("Duration").fill("8");
  await page.getByRole("button", { name: "Propose change", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The owner sees it in the Approvals tab and in the task dialog, and approves there.
  await page
    .locator(".pp-topbar")
    .getByRole("button", { name: /Approvals/ })
    .click();
  await expect(
    page.getByTestId("approval-card").filter({ hasText: "Change: Shared delivery" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Supplier" }).click();
  await row("Shared delivery").dblclick();
  const pending = page.getByRole("dialog").getByTestId("task-approvals");
  await expect(pending).toContainText("Change: Shared delivery");
  await expect(pending).toContainText("8 days");
  await pending.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(pending).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row("Shared delivery")).toContainText("8 days");
  await page.getByRole("tab", { name: "Approvals" }).click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);

  // The owner's own schedule change now goes to the plan using the task.
  await page.getByRole("tab", { name: "Supplier" }).click();
  await row("Shared delivery").dblclick();
  await page.getByRole("dialog").getByLabel("Duration").fill("12");
  await page.getByLabel("Reason for the change").fill("Supplier delay");
  await page.getByRole("button", { name: "Propose change", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".pp-proposal-bar:visible")).toHaveCount(1);
  await expect(row("Shared delivery")).toContainText("8 days");
  await page.getByRole("tab", { name: "Approvals" }).click();
  await page
    .getByTestId("approval-card")
    .filter({ hasText: "Change: Shared delivery" })
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await page.getByRole("tab", { name: "Supplier" }).click();
  await expect(row("Shared delivery")).toContainText("12 days");

  // The task dialog's audit log shows the changes, requests and decisions, keeping edits.
  await row("Shared delivery").dblclick();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Notes").fill("Unsaved note");
  await dialog.getByRole("tab", { name: "Audit log", exact: true }).click();
  const log = dialog.getByTestId("task-audit-log");
  await expect(log.locator("li").first()).toContainText("Accepted: Change: Shared delivery");
  await expect(log).toContainText("Approved for Customer");
  await expect(log).toContainText("Approved for Supplier");
  await expect(log).toContainText("Supplier delay");
  await expect(log).toContainText("Used in Customer (AGREEMENT)");
  await expect(log).toContainText("Created");
  await dialog.getByRole("tab", { name: "Details", exact: true }).click();
  await expect(dialog.getByLabel("Notes")).toHaveValue("Unsaved note");
});

test("link a local task to an external task from another project by its local ID", async ({
  page,
}, info) => {
  await signIn(page);
  const stamp = `${info.project.name} ${Date.now()}`;
  const parent = `Program ${stamp}`;
  const child = `Site ${stamp}`;
  await page.getByPlaceholder("New project name").fill(parent);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("link", { name: parent })).toBeVisible();
  await page.getByPlaceholder("New project name").fill(child);
  await page.getByLabel("Parent project", { exact: true }).selectOption({ label: parent });
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: child }).click();
  await page.getByPlaceholder("Plan name").fill("Site plan");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Site plan", exact: true })).toBeVisible();

  // The parent's plan owns an external task and shares it with the subproject's plan.
  await page.getByRole("link", { name: "Planner" }).click();
  await page.getByRole("link", { name: parent }).click();
  await page.getByPlaceholder("Plan name").fill("Supply");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Supply", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Delivery");
  await page.getByLabel("Ownership").selectOption("EXTERNAL");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const row = (name: string) => page.locator(".gantt_row:visible", { hasText: name });
  await row("Delivery").dblclick();
  await page.getByLabel("Plan to use the task in").selectOption({ label: "Site plan" });
  await page.getByRole("button", { name: "Add reference", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

  // In the subproject's plan the external task has local ID 1; a local task follows it.
  await page.getByRole("tab", { name: "Project" }).click();
  const tree = page.getByRole("tree", { name: "Project structure" });
  await tree.getByRole("button", { name: `Expand ${child}` }).click();
  await tree.getByRole("button", { name: "Site plan", exact: true }).click();
  await expect(row("Delivery")).toContainText("1");
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Install");
  await page.getByRole("dialog").getByLabel("Predecessors").fill("1FS+1d");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row("Install")).toContainText("1FS+1d");
  await expect(page.locator(".pp-gantt-panel:visible .gantt_task_link")).toHaveCount(1);
  await row("Delivery").dblclick();
  await expect(page.getByRole("heading", { name: "External task 1" })).toBeVisible();
});

test("edit and delete plans from the project structure", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Plans ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  for (const plan of ["Draft", "Scratch"]) {
    await page.getByPlaceholder("Plan name").fill(plan);
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByRole("button", { name: plan, exact: true })).toBeVisible();
  }
  const tree = page.getByRole("tree", { name: "Project structure" });
  await tree.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Draft" })).toBeVisible();

  // Rename: the tree and the open Gantt tab follow.
  await page.getByRole("tab", { name: "Project" }).click();
  await tree.getByRole("button", { name: "Edit plan Draft", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Name", { exact: true })).toBeEnabled();
  await dialog.getByLabel("Name", { exact: true }).fill("Contract");
  await dialog.getByLabel("Plan type", { exact: true }).fill("contract");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tree.getByRole("button", { name: "Contract", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Contract" })).toBeVisible();

  // Delete after confirmation.
  await tree.getByRole("button", { name: "Edit plan Scratch", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Delete plan", exact: true })).toBeEnabled();
  page.once("dialog", (d) => void d.accept());
  await dialog.getByRole("button", { name: "Delete plan", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tree.getByRole("button", { name: "Scratch", exact: true })).toHaveCount(0);
});

test("an external activity follows its subtasks in the plans using it", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Activity ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  for (const plan of ["Supplier", "Customer"]) {
    await page.getByPlaceholder("Plan name").fill(plan);
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    await expect(page.getByRole("button", { name: plan, exact: true })).toBeVisible();
  }
  const row = (name: string) => page.locator(".gantt_row:visible", { hasText: name });
  await page.getByRole("button", { name: "Supplier", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Phase");
  await page.getByLabel("Ownership").selectOption("EXTERNAL");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "+ Task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Step");
  await page.getByLabel("Parent", { exact: true }).selectOption({ label: "Phase" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await row("Phase").dblclick();
  await page.getByLabel("Plan to use the task in").selectOption({ label: "Customer" });
  await page.getByRole("button", { name: "Add reference", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

  // Customer has the activity open.
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByRole("button", { name: "Customer", exact: true }).click();
  await expect(row("Phase (from Supplier)")).toBeVisible();

  // Supplier moves the subtask; Customer's open Gantt shows the activity's new dates.
  await page.getByRole("tab", { name: "Supplier" }).click();
  await row("Step").dblclick();
  await page.getByRole("dialog").getByLabel("Start", { exact: true }).fill("2026-11-23");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row("Step")).toContainText("2026-11-23");
  await page.getByRole("tab", { name: "Customer" }).click();
  await expect(row("Phase (from Supplier)")).toContainText("2026-11-23");
  // Its bar spans the activity's real length (5 days), not a single day.
  const bar = page.locator(".gantt_task_line:visible", { hasText: "Phase (from Supplier)" });
  const day = (await page
    .locator(".gantt_scale_line:visible")
    .last()
    .locator(".gantt_scale_cell")
    .first()
    .boundingBox())!;
  expect((await bar.boundingBox())!.width).toBeGreaterThan(day.width * 4);
});

test("marks a dependency whose successor starts too early", async ({ page }, info) => {
  await signIn(page);
  const projectName = `Check ${info.project.name} ${Date.now()}`;
  await page.getByPlaceholder("New project name").fill(projectName);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: projectName }).click();
  await page.getByPlaceholder("Plan name").fill("Build");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  const row = (name: string) => page.locator(".gantt_row:visible", { hasText: name });
  for (const name of ["Design", "Code"]) {
    await page.getByRole("button", { name: "+ Task", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    if (name === "Code") await page.getByRole("dialog").getByLabel("Predecessors").fill("1");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row(name)).toBeVisible();
  }

  // Both start today: Code starts before Design finishes.
  const link = page.locator(".pp-gantt-panel:visible .gantt_task_link");
  await expect(link).toHaveClass(/pp-link-violated/);
  const color = await link
    .locator(".gantt_line_wrapper div")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(color).toBe("rgb(180, 35, 24)");
  await expect(row("Code")).toContainText("⚠ DEP");

  // The Project tab shows where the problems are: on the plan and its project.
  await page.getByRole("tab", { name: "Project" }).click();
  const tree = page.getByRole("tree", { name: "Project structure" });
  const planIssues = tree.getByTestId("plan-dependency-issues");
  await expect(planIssues).toHaveText("⚠ 1");
  await expect(planIssues.locator(".pp-badge")).toHaveAttribute(
    "title",
    /Code: Starts .* for Design/,
  );
  await expect(tree.locator(".pp-tree-row").first()).toContainText("⚠ 1");
  await page.getByRole("tab", { name: "Build" }).click();

  // Moved after Design (with some slack), the dependency is fine.
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await row("Code").dblclick();
  await page.getByRole("dialog").getByLabel("Start", { exact: true }).fill(later);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(link).not.toHaveClass(/pp-link-violated/);
  await expect(row("Code")).not.toContainText("⚠ DEP");
  await page.getByRole("tab", { name: "Project" }).click();
  await expect(planIssues).toHaveCount(0);
});
