"use client";

import type { Project } from "../../types/project";
import { ProjectStatusBadge } from "./ProjectStatusBadge";

type ProjectCardProps = {
  project: Project;
  isMutating?: boolean;
  onOpen: (projectId: string) => void;
  onDelete: (projectId: string) => void;
  onResume: (project: Project) => void;
};

const getPrimaryActionLabel = (project: Project) => {
  if (project.status === "READY") return "Open";
  if (project.status === "FAILED") return "Retry";
  if (project.status === "CREATED" || project.status === "STOPPED") {
    return "Resume";
  }
  if (
    project.status === "ALLOCATING_VM" ||
    project.status === "BOOTING_CONTAINER"
  ) {
    return "View progress";
  }

  return "Open";
};

const canRunPrimaryAction = (project: Project) => {
  return project.status !== "DELETING" && project.status !== "DELETED";
};

const canDeleteProject = (project: Project) => {
  return project.status !== "DELETING" && project.status !== "DELETED";
};

const shouldResumeInsteadOfOpen = (project: Project) => {
  return (
    project.status === "CREATED" ||
    project.status === "STOPPED" ||
    project.status === "FAILED"
  );
};

const fallback = "—";

function RuntimeField({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </p>
      <p className="mt-1 break-all text-sm text-zinc-200">{value || fallback}</p>
    </div>
  );
}

export function ProjectCard({
  project,
  isMutating = false,
  onOpen,
  onDelete,
  onResume,
}: ProjectCardProps) {
  const primaryLabel = getPrimaryActionLabel(project);
  const primaryDisabled = isMutating || !canRunPrimaryAction(project);
  const deleteDisabled = isMutating || !canDeleteProject(project);

  const handlePrimaryAction = () => {
    if (shouldResumeInsteadOfOpen(project)) {
      onResume(project);
      return;
    }

    onOpen(project.id);
  };

  return (
    <article className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5 shadow-2xl shadow-black/30">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold text-white">{project.name}</h2>
            <ProjectStatusBadge status={project.status} />
          </div>

          <p className="mt-2 text-sm text-zinc-400">
            {project.type} workspace
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={primaryDisabled}
            onClick={handlePrimaryAction}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isMutating ? "Working..." : primaryLabel}
          </button>

          <button
            type="button"
            disabled={deleteDisabled}
            onClick={() => onDelete(project.id)}
            className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <RuntimeField label="Instance ID" value={project.assignedInstanceId} />
        <RuntimeField label="Public IP" value={project.publicIp} />
        <RuntimeField label="Container" value={project.containerName} />
      </div>

      <div className="mt-5 rounded-xl border border-white/10 bg-black/40 p-4">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
          Last event
        </p>

        <p className="mt-2 text-sm text-zinc-200">
          {project.lastEventMessage ||
            project.statusReason ||
            "No lifecycle event recorded yet."}
        </p>

        {project.lastEventAt ? (
          <p className="mt-2 text-xs text-zinc-500">
            {new Date(project.lastEventAt).toLocaleString()}
          </p>
        ) : null}
      </div>
    </article>
  );
}