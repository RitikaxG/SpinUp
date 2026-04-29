import type {
  CreateProjectInput,
  Project,
  ProjectApiResponse,
} from "../types/project";

type ProjectListResponse = {
  message: string;
  allProjects: Project[];
};

type ProjectResponse = {
  message: string;
  project: Project | null;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data
        ? String(data.message)
        : "Request failed";

    throw new Error(message);
  }

  return data as T;
};

export const fetchProjects = async (): Promise<Project[]> => {
  const response = await fetch("/api/project", {
    method: "GET",
    cache: "no-store",
  });

  const data = await parseJson<ProjectListResponse>(response);
  return data.allProjects ?? [];
};

export const fetchProjectById = async (
  projectId: string,
): Promise<Project> => {
  const response = await fetch(
    `/api/project/${encodeURIComponent(projectId)}`,
    {
      method: "GET",
      cache: "no-store",
    },
  );

  const data = await parseJson<ProjectResponse>(response);

  if (!data.project) {
    throw new Error("Project not found");
  }

  return data.project;
};

export const createOrResumeProject = async (
  input: CreateProjectInput,
): Promise<ProjectApiResponse> => {
  const response = await fetch("/api/project", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<ProjectApiResponse>(response);
};

export const deleteProjectById = async (
  projectId: string,
): Promise<ProjectApiResponse> => {
  const response = await fetch(
    `/api/project?id=${encodeURIComponent(projectId)}`,
    {
      method: "DELETE",
    },
  );

  return parseJson<ProjectApiResponse>(response);
};