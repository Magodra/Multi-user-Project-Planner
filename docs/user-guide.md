# User guide

This guide is for people who plan and approve work in the planner. If the planner is not installed yet, start with [Getting started](getting-started.md).

## Concepts

- **Project**: the top level. Projects can have subprojects, so a programme can hold several projects. A project has a name, a free-text type, a description and an active flag.
- **Plan**: a project has any number of plans, for example a contract plan agreed with a customer, an internal plan and a reporting plan.
- **Task**: the single item type in a plan. Its kind follows from its data:
  - a **milestone** has zero duration;
  - an **activity** has subtasks, and its dates span them;
  - a **task** is everything else.
- **Tracks**: every plan has three versions of its schedule:
  - **Estimated** is the live working plan and can be edited freely;
  - **Current** is what the team has committed to internally;
  - **Agreed** is what has been agreed with other parties.

  Tasks move from Estimated to Current to Agreed through approvals.

- **Baselines**: named snapshots of a plan, and what-if branches you can edit separately.
- **Internal and external tasks**: an internal task lives in one plan only. An external task is owned by one plan and can be used, live, in other plans, also in other projects of the same project tree.

## Signing in and the Projects page

Sign in with the account your administrator gave you. Depending on the setup, this is a local password, your directory (LDAP) password, or single sign-on.

The Projects page lists your projects as a tree:

- **Expand and collapse** a project with ▸ / ▾ to show or hide its subprojects. The tree remembers what you expanded, also after you sign in again. Projects start collapsed.
- **Create a project** with the form below the tree. Choose a parent project to create a subproject.
- **Edit** a project to change its name, type, description, parent or active flag.
- **Inactive projects** are hidden, together with their subprojects, unless **Show inactive projects** is checked. Deactivating a project changes nothing else: its data stays and it can still be used.

Click a project's name to open its workspace.

## The workspace

The workspace shows any number of panels side by side. Drag a panel's tab to dock it next to, above or below another one, or into another group of tabs. The layout is saved automatically for you and this project.

The top bar opens panels:

| Menu      | Opens                                                                |
| --------- | -------------------------------------------------------------------- |
| Plans     | The Gantt chart of a plan                                            |
| Timelines | An existing timeline, or **+ New timeline**                          |
| Calendar  | A calendar of the plans' tasks                                       |
| Approvals | Your approval inbox; the number shows how many requests wait for you |
| Reports   | Saved report definitions                                             |
| Project   | The project structure, plans and members                             |

**Planner** in the top bar goes back to the Projects page.

## The Project panel

The structure tree starts at the current project. Under each project you see its plans, then its timelines, then its subprojects. Expand a subproject to see its plans.

- Click a plan or timeline to open it, also when it belongs to a subproject. A subproject's panels are titled with the subproject's name.
- Click a subproject's name to switch to that project's own workspace.
- **⚠ n** next to a plan or project means it has dependency problems (see [Dependencies](#dependencies)). Hover it to see the list.
- **Add plan** creates a plan in the current project.
- **Edit** next to a plan changes its name, type and description, or deletes it. Deleting is permanent and asks for confirmation. It is refused while:
  - the plan's tasks are used in other plans;
  - change requests involving the plan are open;
  - the plan has locked baselines.
- **Members** lists who has which role. Project administrators can give users a role for the whole project or for one plan.

## Gantt chart

The Gantt chart shows a plan's tasks with their hierarchy, task IDs and predecessors.

**Tasks**

- **+ Task** adds a task. Double-click a bar or row to open the task dialog.
- Drag a bar to move it; drag its end to change the duration.
- Select a task and use ↑ / ↓ to move it among its siblings. The task's ID does not change.
- Select a task and use → (indent) to make it a subtask of the task above it, or ← (outdent) to move it up one level, right after its current parent. This works for external tasks used in the plan too. A task cannot be indented under a milestone, under an external task, or under a task it is linked to by a dependency.
- Select a task and use the delete button to remove it, after confirmation.

The task dialog sets the task's:

- name;
- start, duration and unit (hours, days, weeks, months, years);
- parent;
- ownership (internal or external);
- predecessors;
- notes.

Activity dates come from their subtasks and cannot be edited directly.

**Viewing**

- Zoom with **−** / **+** or Ctrl + mouse wheel. The scale goes from hours to years.
- **Fit** shows the whole plan; **Today** scrolls to today's date. The red line is today.
- **Baselines** draws one or more baselines (Agreed, Current, Estimated or a snapshot) as outlines behind the bars. Earlier or later dates are colour-coded.
- **Task List** opens the plan's tasks as a list. **Baselines & approvals** opens the plan's baselines and change requests.

### Dependencies

Every task has an ID, shown in the first column. A task's predecessors are written in the **Predecessors** field as a list of entries separated by `;` or `,`:

| Entry    | Meaning                                                       |
| -------- | ------------------------------------------------------------- |
| `4`      | Starts when task 4 finishes (finish-to-start)                 |
| `4FS+3d` | Starts 3 working days after task 4 finishes                   |
| `2SS-1w` | Starts 1 week before task 2 starts (a negative lag is a lead) |
| `7FF`    | Finishes when task 7 finishes                                 |
| `5SF`    | Finishes when task 5 starts                                   |

- **Units:** `h`, `d`, `w`, `mo` and `y`. Without a unit, the lag is in the task's own unit.
- **Working time:** hours and days count working time on the project's calendar, skipping weekends and holidays.
- **Drawing links:** you can also draw a link between two bars in the chart.
- **Not allowed:** dependencies cannot form a loop, and a task cannot depend on its own activity or subtasks.

The planner does not move tasks for you. A successor that starts or finishes too early is flagged instead: its link is drawn red and the task gets a **⚠ DEP** badge, whose tooltip explains the problem. Starting later than needed (slack) is fine.

## External tasks

Make a task **external** (Ownership in the task dialog) to use it in other plans. The owner plan stays in charge of it. Other plans see its current values live and can compare them with their own agreed baseline.

**Using a task in another plan**

- Drag a task from a plan's **Task List** onto another plan's Gantt or Task List. This adds it there as a MONITOR reference. Dropping an internal task asks whether to make it external first.
- Or open the task dialog and use **Use in another plan**. It lists the plans that already use the task, and adds it to another plan of the project tree with a chosen type.

**How a reference shows up**

- In the receiving plan, the reference is placed among the local tasks: at the top level or under a local task. It gets a local ID there, so local tasks can depend on it.
- It is shown as "Name (from _Owner plan_)". The **EXT** badge's tooltip lists the plans that use the task.
- An external activity is shown as an activity, with its full length.

**Reference types**

| Type      | In the receiving plan                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| MONITOR   | The task follows the owner and cannot be changed. You see changes and variance markers.                                         |
| AGREEMENT | Changing the task's dates or name sends a proposal to the owner plan. Until the owner decides, it is drawn as a dashed outline. |

The type is set per reference. The task dialog in the owner plan, and the external-task dialog in the receiving plan, can upgrade a MONITOR reference to AGREEMENT. The task's current agreed values carry over, so no new approval round is needed. The owner's dialog can also downgrade an AGREEMENT reference back to MONITOR.

## Baselines and approvals

Open **Baselines & approvals** from a plan's Gantt toolbar.

- **Acceptance:** **Request whole plan: Estimated → Current** asks to accept the whole plan into Current. To accept a single task, use the task dialog: **Request: Estimated → Current** or **Request: Current → Agreed**.
- **Snapshots:** **Snapshot (locked)** saves the current state as a named, read-only baseline.
- **What-if branches:** a branch is an editable copy of the plan for trying alternatives. A branch can be promoted to the live plan through an approval, or deleted.
- **Compare:** compare the live plan with any baseline.
- **Change requests:** the plan's requests and their status.

Every request is a **change request** that needs approval from the parties involved:

- **Estimated → Current:** approval by the plan's owners.
- **Current → Agreed:**
  - for internal tasks, approval by the plan's approvers;
  - for an external task, by the owner and every plan using it;
  - for a task on an AGREEMENT reference, by all parties to the link.

A request is accepted completely or not at all. A new change to a task with an open request supersedes the old request.

**Deciding**

- Requests waiting for you are listed in the **Approvals** panel, for this project and its subprojects. Choose **Approve** or **Reject**.
- The task dialog also lists the open requests for that task, with the same buttons.
- Approving and rejecting are only possible in the planner itself, never through an AI assistant.

If a recipient rejects an external task that is already in Current, the task stays in Current but is marked **rejected** until a new request is approved or the task changes.

## Timelines

A timeline is a picture of selected tasks over time, for example for a roadmap or a status report. It shows the tasks themselves, not copies, so it always reflects the plans.

- **Create one** with **Timelines → + New timeline**. Set its name, start, end and scale.
- **Add tasks** by dragging them from a plan's **Task List** onto a row. A timeline can show tasks from any project you can read.
- **Rows** have an editable name and can be moved up and down.
- **Areas:** each row has three. Callouts above the timeline, bars on the timeline, and callouts below.
- **Rearranging:** drag an entry to another line, area or row. Each area has an empty line at its edge for starting a new line.
- **Milestones** are drawn as ◆ followed by their name.
- **Removing:** hover an entry and choose × to remove it from the timeline. The task itself is not affected.

## Calendar

The calendar shows tasks as events and milestones as markers, by day, week, month or year.

## Reports

Choose **+ Report** in the Reports panel to save a report definition. It sets:

- the plans to include;
- the time span;
- the granularity;
- a name filter.

Run a saved report at any time as **HTML**, **PDF** or **CSV**. The same definition and the same data always give the same result.

## Roles

What you can do depends on your role in the project or plan:

| Role       | Can                                                                 |
| ---------- | ------------------------------------------------------------------- |
| VIEWER     | Read the project and its plans                                      |
| APPROVER   | Read, and decide approvals assigned to the role                     |
| EDITOR     | Also edit plans, create baselines and change requests               |
| PLAN_OWNER | Also manage plans (link types, deleting plans); approves by default |
| ADMIN      | Everything in the project, including members and subprojects        |

A role can be given for the whole project or for one plan. Your administrator can also give roles through your directory groups.
