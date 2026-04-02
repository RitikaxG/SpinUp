import { z } from "zod";
import { ProjectType } from "db/client";

export const ProjectSchema = z.object({
    name: z.string().trim()
    .min(3,"Project must be atleast 3 characters long")
    .max(50,"Project must be atmost 50 characters long")
    .regex(/^[a-zA-Z0-9\s]+$/, "Project name can only contain alphanumeric characters and spaces"),

    type: z.nativeEnum(ProjectType, {
        errorMap: () => ({
            message: "Project type must be one of NEXTJS, REACT or REACT_NATIVE"
        })
    })
})

export type CreateProjectInput = z.infer<typeof ProjectSchema>
export const DeleteProjectSchema = z.object({
    projectId : z.string()
})