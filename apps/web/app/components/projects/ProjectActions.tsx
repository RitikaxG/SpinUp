"use client";

import type { Project } from "../../types/project";
import { getIdeUrl } from "../../lib/projectUrls";

type ProjectActionsProps = {
  project: Project;
  isStarting?: boolean;
  onStart: () => void;
};

export function ProjectActions({
  project,
  isStarting = false,
  onStart,
}: ProjectActionsProps) {
  const ideUrl = getIdeUrl(project);
  

  if (project.status === "READY") {
    return (
      <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
        <h2 className="text-2xl font-semibold text-white">Workspace ready</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Your runtime is live. Open the IDE or preview the running app.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          {ideUrl ? (
            <a
              href={ideUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"
            >
              Open IDE
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black opacity-40"
            >
              Open IDE
            </button>
          )}

        
        </div>
      </section>
    );
  }

  if (project.status === "ALLOCATING_VM") {
    return (
      <section className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5">
        <h2 className="text-2xl font-semibold text-white">
          Allocating warm VM...
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          SpinUp is finding an idle instance or scaling the Auto Scaling Group.
        </p>
      </section>
    );
  }

  if (project.status === "BOOTING_CONTAINER") {
    return (
      <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-5">
        <h2 className="text-2xl font-semibold text-white">
          VM assigned. Starting project container...
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          The workspace container is being started on the assigned VM.
        </p>
      </section>
    );
  }

  if (project.status === "FAILED") {
    return (
      <section className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
        <h2 className="text-2xl font-semibold text-white">Runtime failed</h2>
        <p className="mt-2 text-sm text-red-200">
          {project.statusReason ||
            project.lastEventMessage ||
            "The runtime failed to start."}
        </p>

        <button
          type="button"
          disabled={isStarting}
          onClick={onStart}
          className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isStarting ? "Retrying..." : "Retry"}
        </button>
      </section>
    );
  }

  if (project.status === "CREATED" || project.status === "STOPPED") {
    return (
      <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
        <h2 className="text-2xl font-semibold text-white">
          This project is not running.
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          Start the workspace to allocate a VM and boot the project container.
        </p>

        <button
          type="button"
          disabled={isStarting}
          onClick={onStart}
          className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isStarting ? "Starting..." : "Start workspace"}
        </button>
      </section>
    );
  }

  if (project.status === "DELETING") {
    return (
      <section className="rounded-2xl border border-orange-500/20 bg-orange-500/5 p-5">
        <h2 className="text-2xl font-semibold text-white">
          Deleting project...
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          Runtime and project artifacts are being cleaned up.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
      <h2 className="text-2xl font-semibold text-white">
        Project unavailable
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        This project is no longer active.
      </p>
    </section>
  );
}