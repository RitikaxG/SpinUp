import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { StateCreator } from "zustand";

interface Project {
    id : string,
    name : string,
    type : string
}

interface ProjectState {
    projects : Project[],
    addProject : (project : Project) => void,
    removeProject : (projectId : string) => void,
    setProjects : (projects : Project[]) => void,
    clearProjects : () => void
}
const projectStore : StateCreator<ProjectState> = (set) => ({
    projects : [],
    addProject : (project) => {
        set((state) => ({
            projects : [project, ...state.projects]
        }))
    },
    removeProject : (projectId : string) => {
        set((state) => ({
            projects : state.projects.filter((project) => project.id !== projectId)
        }))
    },
    setProjects : (projects : Project[]) => {
        set({ projects })
    },
    clearProjects : () => {
        set({ projects : [] })
    }
})

const useProjectStore = create(
    devtools(
       projectStore
    )
)

export default useProjectStore;