import type { Project, ProjectType } from "../types/project";

const CODE_DIR_BY_TYPE: Record<ProjectType, string> = {
  NEXTJS: "code-nextjs",
  REACT: "code-react",
  REACT_NATIVE: "code-react_native",
};

export function getWorkspaceFolderPath(project: Project) {
  const codeDir = CODE_DIR_BY_TYPE[project.type];

  return `/app/projects/${project.name}_${project.id}/${codeDir}`;
}

export function getIdeUrl(project: Project) {
  if (!project.publicIp) return null;

  const folderPath = getWorkspaceFolderPath(project);

  return `http://${project.publicIp}:8080/?folder=${encodeURI(folderPath)}`;
}

// For V1 demo, preview means code-server workspace preview,
// not app dev-server preview on port 3000.
export function getPreviewUrl(project: Project) {
  return getIdeUrl(project);
}