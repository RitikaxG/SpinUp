"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { BootProgress } from "../../components/projects/BootProgress";
import { ProjectActions } from "../../components/projects/ProjectActions";
import { ProjectPreview } from "../../components/projects/ProjectPreview";
import { ProjectStatusBadge } from "../../components/projects/ProjectStatusBadge";
import { createOrResumeProject } from "../../lib/projectApi";
import { getIdeUrl, getPreviewUrl } from "../../lib/projectUrls";
import useProjectStore from "../../store/projectStore";
import { useProjectPolling } from "../../hooks/useProjectPolling";

function RuntimeField({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/40 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 break-all text-sm text-zinc-200">{value || "—"}</p>
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return null;

  return new Date(value).toLocaleString();
}

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams();

  const rawProjectId = params?.projectId;
  const projectId = useMemo(() => {
    if (Array.isArray(rawProjectId)) return rawProjectId[0] ?? null;
    return rawProjectId ?? null;
  }, [rawProjectId]);

  const upsertProject = useProjectStore((state) => state.upsertProject);

  const { project, isLoading, error, refetch } = useProjectPolling(projectId);
  const [isStarting, setIsStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleStart = async () => {
    if (!project) return;

    try {
      setIsStarting(true);
      setActionError(null);

      const result = await createOrResumeProject({
        name: project.name,
        type: project.type,
      });

      if (result.project) {
        upsertProject(result.project);
      }

      await refetch();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start workspace";
      setActionError(message);
    } finally {
      setIsStarting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-black px-6 py-10 text-white">
        <section className="mx-auto max-w-6xl">
          <p className="text-zinc-400">Loading project...</p>
        </section>
      </main>
    );
  }

  if (error || !project) {
    return (
      <main className="min-h-screen bg-black px-6 py-10 text-white">
        <section className="mx-auto max-w-6xl">
          <button
            type="button"
            onClick={() => router.push("/projects")}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
          >
            ← Back to projects
          </button>

          <div className="mt-6 rounded-2xl border border-red-500/30 bg-red-500/10 p-6">
            <h1 className="text-2xl font-semibold">Project unavailable</h1>
            <p className="mt-2 text-sm text-red-200">
              {error || "Project not found"}
            </p>
          </div>
        </section>
      </main>
    );
  }

  const ideUrl = getIdeUrl(project);
  const previewUrl = getPreviewUrl(project);

  return (
    <main className="min-h-screen bg-black px-6 py-10 text-white">
      <section className="mx-auto grid max-w-6xl gap-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <button
              type="button"
              onClick={() => router.push("/projects")}
              className="mb-5 rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
            >
              ← Back to projects
            </button>

            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-4xl font-semibold">{project.name}</h1>
              <ProjectStatusBadge status={project.status} />
            </div>

            <p className="mt-3 text-zinc-400">
              {project.type} workspace controlled by SpinUp runtime
              orchestration.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"
          >
            Refresh
          </button>
        </div>

        {actionError ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            {actionError}
          </div>
        ) : null}

        <ProjectActions
          project={project}
          isStarting={isStarting}
          onStart={handleStart}
        />

        <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
          <BootProgress project={project} />

          <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
            <p className="text-sm uppercase tracking-[0.3em] text-cyan-300">
              Runtime details
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-white">
              Workspace runtime
            </h2>

            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <RuntimeField
                label="Instance ID"
                value={project.assignedInstanceId}
              />
              <RuntimeField label="Public IP" value={project.publicIp} />
              <RuntimeField label="Container" value={project.containerName} />
              <RuntimeField
                label="Last heartbeat"
                value={formatDate(project.lastHeartbeatAt)}
              />
              <RuntimeField
                label="Boot started"
                value={formatDate(project.bootStartedAt)}
              />
              <RuntimeField
                label="Boot completed"
                value={formatDate(project.bootCompletedAt)}
              />
              <RuntimeField label="IDE URL" value={ideUrl} />
              <RuntimeField label="Preview URL" value={previewUrl} />
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
                  {formatDate(project.lastEventAt)}
                </p>
              ) : null}
            </div>
          </section>
        </div>

        <ProjectPreview project={project} />
      </section>
    </main>
  );
}