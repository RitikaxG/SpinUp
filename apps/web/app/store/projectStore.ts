import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { Project } from "../types/project";

interface ProjectState {
  projects: Project[];
  setProjects: (projects: Project[]) => void;
  upsertProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  clearProjects: () => void;
}

const useProjectStore = create<ProjectState>()(
  devtools(
    (set) => ({
      projects: [],

      setProjects: (projects) => {
        set({ projects });
      },

      upsertProject: (project) => {
        set((state) => {
          const exists = state.projects.some((item) => item.id === project.id);

          if (!exists) {
            return {
              projects: [project, ...state.projects],
            };
          }

          return {
            projects: state.projects.map((item) =>
              item.id === project.id ? { ...item, ...project } : item,
            ),
          };
        });
      },

      removeProject: (projectId) => {
        set((state) => ({
          projects: state.projects.filter((project) => project.id !== projectId),
        }));
      },

      clearProjects: () => {
        set({ projects: [] });
      },
    }),
    {
      name: "spinup-project-store",
    },
  ),
);

export default useProjectStore;