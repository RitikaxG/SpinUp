import { z } from "zod";

export const createProjectSchema = z.object({
    name: z.string().trim()
    .min(3,"Project must be atleast 3 characters long")
    .max(50,"Project must be atmost 50 characters long")
    .regex(/^[a-zA-Z0-9\s]+$/, "Project name can only contain alphanumeric characters and spaces"),

    type: z.enum(["NEXTJS","REACT","REACT_ NATIVE"],{
        errorMap : () => ({
            message : "Project type must be one of NEXTJS, REACT or REACT_NATIVE"
        })
    })
})

export type CreateProjectInput = z.infer<typeof createProjectSchema>