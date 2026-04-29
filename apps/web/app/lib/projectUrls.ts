import type { Project } from "../types/project";

export function getIdeUrl(project: Project) {
  if (!project.publicIp) return null;

  return `http://${project.publicIp}:8080`;
}

export function getPreviewUrl(project: Project) {
  if (!project.publicIp) return null;

  if (project.type === "REACT_NATIVE") {
    return null;
  }

  return `http://${project.publicIp}:8080/absproxy/3000`;
}