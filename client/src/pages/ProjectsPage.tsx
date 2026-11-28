import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Project, ProjectSummary } from "@planning/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge, Empty, ErrorText, Field, useAction } from "../components/ui";
import { ProjectProvider } from "../workspace/ProjectContext";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { ProjectDialog } from "./ProjectDialog";
import {
  type ProjectNode,
  ancestorIds,
  buildProjectTree,
  parentOptions,
  withoutInactiveSubtrees,
} from "./projectTree";

function ProjectTree({
  nodes,
  expanded,
  onToggle,
  onEdit,
}: {
  nodes: ProjectNode[];
  expanded: ReadonlySet<string>;
  onToggle(projectId: string, open: boolean): void;
  onEdit(project: ProjectSummary): void;
}) {
  return (
    <ul className="pp-cards pp-project-tree">
      {nodes.map(({ project: p, children }) => (
        <li key={p.id}>
          <div className={`pp-card${p.active ? "" : " pp-inactive"}`} data-testid="project-card">
            <header>
              {children.length > 0 ? (
                <button
                  type="button"
                  className="pp-tree-toggle"
                  aria-expanded={expanded.has(p.id)}
                  aria-label={`${expanded.has(p.id) ? "Collapse" : "Expand"} ${p.name}`}
                  title={`${children.length} subproject${children.length === 1 ? "" : "s"}`}
                  onClick={() => onToggle(p.id, !expanded.has(p.id))}
                >
                  {expanded.has(p.id) ? "▾" : "▸"}
                </button>
              ) : (
                <span className="pp-tree-toggle" aria-hidden />
              )}
              <Link to={`/projects/${p.id}`}>{p.name}</Link>
              {p.projectType && (
                <Badge className="pp-b-type" title="Project type">
                  {p.projectType}
                </Badge>
              )}
              {!p.active && (
                <Badge className="pp-b-inactive" title="This project is deactivated">
                  Inactive
                </Badge>
              )}
              <span className="pp-spacer" />
              {p.canEdit && (
                <button type="button" className="pp-link" onClick={() => onEdit(p)}>
                  Edit
                </button>
              )}
            </header>
            {p.description && <p className="pp-hint pp-description">{p.description}</p>}
          </div>
          {children.length > 0 && expanded.has(p.id) && (
            <ProjectTree nodes={children} expanded={expanded} onToggle={onToggle} onEdit={onEdit} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Projects the signed-in user has expanded in the tree, stored in their
 * profile so it is the same after signing in again. Collapsed by default.
 */
function useExpandedProjects(onError: (err: unknown) => void) {
  const { user, updateUser } = useAuth();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(user?.preferences?.expandedProjectIds ?? []),
  );
  // Saves run one after another, so the last change is the one that is kept.
  const saving = useRef(Promise.resolve());
  const save = useCallback(
    (next: ReadonlySet<string>) => {
      setExpanded(next);
      saving.current = saving.current
        .then(() => api.users.setPreferences({ expandedProjectIds: [...next] }))
        .then(updateUser, onError);
    },
    [updateUser, onError],
  );
  const toggle = useCallback(
    (projectId: string, open: boolean) => {
      const next = new Set(expanded);
      if (open) next.add(projectId);
      else next.delete(projectId);
      save(next);
    },
    [expanded, save],
  );
  /** Expand the projects above a project, so a new or moved project is in view. */
  const reveal = useCallback(
    (projects: ProjectSummary[], projectId: string) => {
      const missing = ancestorIds(projects, projectId).filter((id) => !expanded.has(id));
      if (missing.length > 0) save(new Set([...expanded, ...missing]));
    },
    [expanded, save],
  );
  return { expanded, toggle, reveal };
}

export function ProjectsPage() {
  const { user, signOut } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [projectType, setProjectType] = useState("");
  const [parentProjectId, setParentProjectId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const { busy, error, run } = useAction();
  const [saveError, setSaveError] = useState<string | null>(null);
  const onSaveError = useCallback(
    (err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)),
    [],
  );
  const { expanded, toggle, reveal } = useExpandedProjects(onSaveError);

  const reload = useCallback(() => run(async () => setProjects(await api.projects.list())), [run]);
  useEffect(() => void reload(), [reload]);

  const all = projects ?? [];
  const shown = showInactive ? all : withoutInactiveSubtrees(all);
  const inactiveCount = all.length - all.filter((p) => p.active).length;

  return (
    <main className="pp-page">
      <header className="pp-page-header">
        <h1>Projects</h1>
        <span className="pp-spacer" />
        <span>{user?.displayName}</span>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <ErrorText error={error ?? saveError} />
      {inactiveCount > 0 && (
        <label className="pp-check">
          <input
            type="checkbox"
            id="show-inactive-projects"
            name="showInactive"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive projects ({inactiveCount})
        </label>
      )}
      {projects?.length === 0 && <Empty>No projects yet.</Empty>}
      <ProjectTree
        nodes={buildProjectTree(shown)}
        expanded={expanded}
        onToggle={toggle}
        onEdit={setEditing}
      />
      <form
        className="pp-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const created = await api.projects.create({
              name,
              projectType,
              parentProjectId,
              description: "",
            });
            setName("");
            setProjectType("");
            const list = await api.projects.list();
            setProjects(list);
            reveal(list, created.id);
          });
        }}
      >
        <Field label="Name">
          <input
            id="new-project-name"
            name="projectName"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Project type">
          <input
            id="new-project-type"
            name="projectType"
            value={projectType}
            onChange={(e) => setProjectType(e.target.value)}
          />
        </Field>
        <Field label="Parent project">
          <select
            id="new-project-parent"
            name="parentProjectId"
            aria-label="Parent project"
            value={parentProjectId ?? ""}
            onChange={(e) => setParentProjectId(e.target.value || null)}
          >
            <option value="">(none — top level)</option>
            {parentOptions(all).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" className="pp-primary" disabled={!name || busy}>
          Create project
        </button>
      </form>
      {editing && (
        <ProjectDialog
          project={editing}
          projects={all}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void run(async () => {
              const list = await api.projects.list();
              setProjects(list);
              reveal(list, editing.id);
            });
          }}
        />
      )}
    </main>
  );
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.projects
      .get(projectId)
      .then(setProject, (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [projectId]);
  if (!project)
    return (
      <main className="pp-center">{error ? <ErrorText error={error} /> : <p>Loading…</p>}</main>
    );
  return (
    <ProjectProvider key={project.id} project={project}>
      <ProjectWorkspace />
    </ProjectProvider>
  );
}
