"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

import { ProjectCard } from "../components/projects/ProjectCard";
import {
  createOrResumeProject,
  deleteProjectById,
  fetchProjects,
} from "../lib/projectApi";
import useProjectStore from "../store/projectStore";
import type { Project } from "../types/project";

export default function ProjectsPage() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();

  const projects = useProjectStore((state) => state.projects);
  const setProjects = useProjectStore((state) => state.setProjects);
  const upsertProject = useProjectStore((state) => state.upsertProject);
  const removeProject = useProjectStore((state) => state.removeProject);
  const clearProjects = useProjectStore((state) => state.clearProjects);

  const [isLoading, setIsLoading] = useState(true);
  const [actionProjectId, setActionProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    if (!isSignedIn) return;

    try {
      setIsLoading(true);
      setError(null);

      const nextProjects = await fetchProjects();
      setProjects(nextProjects);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch projects";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [isSignedIn, setProjects]);

  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn) {
      clearProjects();
      setIsLoading(false);
      return;
    }

    void loadProjects();
  }, [isLoaded, isSignedIn, clearProjects, loadProjects]);

  const handleOpen = (projectId: string) => {
    router.push(`/projects/${projectId}`);
  };

  const handleResume = async (project: Project) => {
    try {
      setActionProjectId(project.id);
      setError(null);

      const result = await createOrResumeProject({
        name: project.name,
        type: project.type,
      });

      if (result.project) {
        upsertProject(result.project);
        router.push(`/projects/${result.project.id}`);
        return;
      }

      router.push(`/projects/${project.id}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to resume project";
      setError(message);
    } finally {
      setActionProjectId(null);
    }
  };

  const handleDelete = async (projectId: string) => {
    const shouldDelete = window.confirm(
      "Delete this project and clean up its runtime?",
    );

    if (!shouldDelete) return;

    try {
      setActionProjectId(projectId);
      setError(null);

      const result = await deleteProjectById(projectId);

      if (result.inProgress && result.project) {
        upsertProject(result.project);
        return;
      }

      removeProject(projectId);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete project";
      setError(message);
    } finally {
      setActionProjectId(null);
    }
  };

  if (!isLoaded || isLoading) {
    return (
      <main className="min-h-screen bg-black px-6 py-10 text-white">
        <div className="mx-auto max-w-6xl">
          <p className="text-zinc-400">Loading projects...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black px-6 py-10 text-white">
      <section className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-cyan-300">
              SpinUp control plane
            </p>
            <h1 className="mt-3 text-4xl font-semibold">Projects</h1>
            <p className="mt-3 max-w-2xl text-zinc-400">
              Each card shows the lifecycle state of a real workspace runtime:
              VM allocation, container boot, public IP, and latest control-plane
              event.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
            >
              New project
            </button>

            <button
              type="button"
              onClick={() => void loadProjects()}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"
            >
              Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {projects.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-zinc-950/80 p-8 text-center">
            <h2 className="text-xl font-semibold">No projects yet</h2>
            <p className="mt-2 text-zinc-400">
              Create your first workspace from the landing page.
            </p>

            <button
              type="button"
              onClick={() => router.push("/")}
              className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"
            >
              Create project
            </button>
          </div>
        ) : (
          <div className="grid gap-5">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                isMutating={actionProjectId === project.id}
                onOpen={handleOpen}
                onResume={handleResume}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}