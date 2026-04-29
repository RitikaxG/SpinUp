import { useCallback, useEffect, useState } from "react";

import { fetchProjectById } from "../lib/projectApi";
import useProjectStore from "../store/projectStore";
import type { Project, ProjectStatus } from "../types/project";

const POLLING_STATUSES = new Set<ProjectStatus>([
  "ALLOCATING_VM",
  "BOOTING_CONTAINER",
  "DELETING",
]);

const POLL_INTERVAL_MS = 3000;

export function useProjectPolling(projectId: string | null) {
  const projectFromStore = useProjectStore((state) =>
    projectId
      ? state.projects.find((project) => project.id === projectId)
      : undefined,
  );

  const upsertProject = useProjectStore((state) => state.upsertProject);

  const [project, setProject] = useState<Project | null>(
    projectFromStore ?? null,
  );
  const [isLoading, setIsLoading] = useState(!projectFromStore);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!projectId) return null;

    const nextProject = await fetchProjectById(projectId);

    setProject(nextProject);
    upsertProject(nextProject);
    setError(null);

    return nextProject;
  }, [projectId, upsertProject]);

  useEffect(() => {
    if (projectFromStore) {
      setProject(projectFromStore);
    }
  }, [projectFromStore]);

  useEffect(() => {
    if (!projectId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const fetchInitialProject = async () => {
      try {
        setIsLoading(true);

        const nextProject = await fetchProjectById(projectId);

        if (cancelled) return;

        setProject(nextProject);
        upsertProject(nextProject);
        setError(null);
      } catch (err) {
        if (cancelled) return;

        const message =
          err instanceof Error ? err.message : "Failed to fetch project";
        setError(message);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void fetchInitialProject();

    return () => {
      cancelled = true;
    };
  }, [projectId, upsertProject]);

  useEffect(() => {
    if (!projectId || !project || !POLLING_STATUSES.has(project.status)) {
      return;
    }

    let cancelled = false;

    const intervalId = setInterval(() => {
      void (async () => {
        try {
          const nextProject = await fetchProjectById(projectId);

          if (cancelled) return;

          setProject(nextProject);
          upsertProject(nextProject);
          setError(null);
        } catch (err) {
          if (cancelled) return;

          const message =
            err instanceof Error ? err.message : "Failed to fetch project";
          setError(message);
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [projectId, project?.status, upsertProject]);

  return {
    project,
    isLoading,
    error,
    refetch,
  };
}