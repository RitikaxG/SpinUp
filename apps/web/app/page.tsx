"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

import useProjectStore from "./store/projectStore";
import { createOrResumeProject } from "./lib/projectApi";
import type { ProjectType } from "./types/project";

const PROJECT_TYPES: ProjectType[] = ["NEXTJS", "REACT", "REACT_NATIVE"];

const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  NEXTJS: "Next.js",
  REACT: "React",
  REACT_NATIVE: "React Native",
};

export default function LandingPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useUser();

  const upsertProject = useProjectStore((state) => state.upsertProject);

  const [projectName, setProjectName] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("NEXTJS");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createProject = async () => {
    const trimmedName = projectName.trim();

    if (!trimmedName) {
      setError("Enter a project name first.");
      return;
    }

    if (!isSignedIn) {
      setError("Sign in before creating a workspace.");
      return;
    }

    try {
      setIsCreating(true);
      setError(null);

      const result = await createOrResumeProject({
        name: trimmedName,
        type: projectType,
      });

      if (!result.project) {
        setError(result.message || "Project could not be created.");
        return;
      }

      upsertProject(result.project);
      router.push(`/projects/${result.project.id}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create project.";
      setError(message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <main className="relative min-h-[calc(100vh-4rem)] overflow-hidden bg-black text-white">
      <motion.div
        className="pointer-events-none absolute left-1/2 top-[-260px] h-[900px] w-[900px] -translate-x-1/2 rounded-full"
        animate={{
          scale: [1, 1.08, 1],
          opacity: [0.65, 0.9, 0.65],
        }}
        transition={{
          ease: "easeInOut",
          duration: 4,
          repeat: Infinity,
        }}
        style={{
          background:
            "radial-gradient(circle, rgba(0,212,255,0.18) 0%, rgba(0,0,0,0) 72%)",
        }}
      />

      <section className="relative z-10 mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col items-center justify-center px-6 py-16">
        <div className="text-center">
          <p className="mb-4 text-sm uppercase tracking-[0.35em] text-cyan-300">
            SpinUp control plane
          </p>

          <h1 className="text-5xl font-semibold tracking-tight md:text-6xl">
            What do you want to build?
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-400">
            Create a real cloud workspace backed by VM allocation, container
            boot, code-server, and runtime lifecycle tracking.
          </p>
        </div>

        <div className="mt-10 w-full max-w-3xl rounded-3xl border border-white/10 bg-zinc-950/80 p-5 shadow-2xl shadow-black/40 backdrop-blur">
          <label
            htmlFor="projectName"
            className="text-sm font-medium text-zinc-300"
          >
            Project name
          </label>

          <input
            id="projectName"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void createProject();
              }
            }}
            className="mt-3 h-14 w-full rounded-2xl border border-white/10 bg-black px-5 text-base text-white outline-none transition placeholder:text-zinc-600 focus:border-cyan-400/60"
            placeholder="insurance dashboard, ai agent workspace, portfolio app..."
          />

          <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <label
                htmlFor="projectType"
                className="text-sm font-medium text-zinc-300"
              >
                Framework
              </label>

              <select
                id="projectType"
                value={projectType}
                onChange={(event) =>
                  setProjectType(event.target.value as ProjectType)
                }
                className="mt-3 h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-white outline-none transition focus:border-cyan-400/60 md:w-60"
              >
                {PROJECT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {PROJECT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              disabled={!isLoaded || isCreating}
              onClick={() => void createProject()}
              className="h-12 rounded-xl bg-white px-6 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? "Creating..." : "Create workspace"}
            </button>
          </div>

          {error ? (
            <div className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-sm text-zinc-500">
          <span>Already created a workspace?</span>

          <button
            type="button"
            onClick={() => router.push("/projects")}
            className="text-cyan-300 transition hover:text-cyan-200"
          >
            View projects
          </button>
        </div>
      </section>
    </main>
  );
}