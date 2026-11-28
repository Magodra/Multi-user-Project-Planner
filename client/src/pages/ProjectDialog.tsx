/** Edit a project's name, type, description, parent and active state. */
import { useState } from "react";
import type { ProjectSummary } from "@planning/shared";
import { api } from "../api/client";
import { Dialog, ErrorText, Field, useAction } from "../components/ui";
import { parentOptions, projectPath, subtreeIds } from "./projectTree";

interface Props {
  project: ProjectSummary;
  /** All projects visible to the user, for the parent picker. */
  projects: ProjectSummary[];
  onClose(): void;
  onSaved(): void;
}

export function ProjectDialog({ project, projects, onClose, onSaved }: Props) {
  const [name, setName] = useState(project.name);
  const [projectType, setProjectType] = useState(project.projectType);
  const [description, setDescription] = useState(project.description);
  const [parentProjectId, setParentProjectId] = useState(project.parentProjectId);
  const [active, setActive] = useState(project.active);
  const { busy, error, run } = useAction();

  // A project cannot move under itself or its own subprojects.
  const options = parentOptions(projects, subtreeIds(projects, project.id));
  const currentParent = project.parentProjectId;
  if (currentParent && !options.some((o) => o.id === currentParent)) {
    // Keep showing a parent the user cannot edit, so the dialog does not silently change it.
    options.unshift({
      id: currentParent,
      label: projectPath(projects, currentParent) || "(not accessible)",
    });
  }

  const save = () =>
    run(async () => {
      await api.projects.update(project.id, {
        version: project.version,
        name,
        projectType,
        description,
        parentProjectId,
        active,
      });
      onSaved();
    });

  return (
    <Dialog
      title="Edit project"
      onClose={onClose}
      footer={
        <>
          <span className="pp-spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pp-primary"
            onClick={() => void save()}
            disabled={busy || !name}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          id="edit-project-name"
          name="projectName"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Project type">
        <input
          id="edit-project-type"
          name="projectType"
          value={projectType}
          onChange={(e) => setProjectType(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <textarea
          id="edit-project-description"
          name="description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Parent project">
        <select
          id="edit-project-parent"
          name="parentProjectId"
          aria-label="Parent project"
          value={parentProjectId ?? ""}
          onChange={(e) => setParentProjectId(e.target.value || null)}
        >
          <option value="">(none — top level)</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <label className="pp-check">
        <input
          type="checkbox"
          id="edit-project-active"
          name="active"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        Active
      </label>
      <ErrorText error={error} />
    </Dialog>
  );
}
