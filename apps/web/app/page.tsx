"use client"
import { motion } from "motion/react";
import useProjectStore from "./store/projectStore";
import axios from "axios";
import { useRef, Ref, useEffect } from "react";
import { useUser } from "@clerk/nextjs";

export default function LandingPage(){
  const projectTypeRef = useRef<HTMLSelectElement>(null);
  const projectNameRef = useRef<HTMLInputElement>(null);

  const projects = useProjectStore((state) => state.projects);
  const addProject = useProjectStore((state) => state.addProject);
  const removeProject = useProjectStore((state) => state.removeProject);

  const { user, isSignedIn } = useUser();
  const setProjects = useProjectStore((state) => state.setProjects);
  const clearProjects = useProjectStore((state) => state.clearProjects);

  useEffect(()=>{
    if(isSignedIn && user){
      clearProjects(); // clear existing data from projectStore

      const fetchProjects = async () => {
        const response = await axios.get(`/api/project`);
        setProjects(response.data.allProjects);
      }
      fetchProjects(); // fetchProjects from DB and sync it with projectStore when component loads
    }
    else{
      clearProjects() // If user is not logged in
    }
  },[isSignedIn, user]) // Re-fetches after login or page reload

  const createProject = async () => {

    const projectType = projectTypeRef.current?.value;
    const projectName = projectNameRef.current?.value;

    if(!projectType || !projectName) return;
    console.log(`${projectName}, ${projectType}`);
    try{

      const response = await axios.post(`/api/project`,{
        type : projectType,
        name : projectName
      })

      console.log(response.data.projectDetails);
      const projectDetails = response.data.projectDetails;

      addProject({
        id : projectDetails.projectId,
        name : projectDetails.projectName,
        type : projectDetails.projectType
      })
      console.log(`Zustand Project State Variable Returns : ${JSON.stringify(projects,null,2)}`);
    }
    catch(err){
      console.error(`Error creating new project ${err}`);
    }
  }

  const deleteProject = async (projectId : string) => {
    try{
      await axios.delete(`/api/project/?id=${projectId}`);
      removeProject(projectId);
    }
    catch(err : unknown){
      if(err instanceof Error){
        console.error(`Error deleting project ${err.message}`);
      }
    }
  }

  return <div className="relative bg-black max-w-screen h-screen overflow-y-hidden">
    <motion.div className="absolute top-[-200px] left-[400px] w-[800px] h-[800px] rounded-b-full"
      animate={{ scale : [1.25,1.5,1.25], opacity : [0.7, 1 , 0.7 ] }}
      transition={{
        ease : "easeInOut",
        duration : 3,
        repeat : Infinity
      }}
      style={{
        background : `radial-gradient(circle, rgba(0,212,255,0.2) 0%, rgba(0,0,0,0) 80%)`
      }}
    ></motion.div>
    <div className="flex flex-col items-center justify-center relative z-10 h-full gap-2">
        <h1 className="text-5xl font-semibold">What do you want to build?</h1>
        <p className="text-gray-400 text-lg">Create stunning apps and websites by chatting with AI.</p>
          <motion.div className="absolute -translate-x-62.5 translate-y-0.5 w-[100px] h-[2px] rounded-full bg-gradient-to-r from-blue-300 via-white to-blue-300"
      
          ></motion.div>
           <motion.div className="absolute -translate-x-75 translate-y-6.5 w-[3px] h-[50px] rounded-full bg-gradient-to-b from-blue-300 via-white to-blue-300"
          ></motion.div>
        <input className="border-1 border-gray-600 rounded-sm w-[600px] h-[100px] mt-4 px-4 text-start text-white placeholder-gray-400 bg-neutral-900 outline-none relative" placeholder="Type our idea and we'll bring it to life"/>


        <InputSelect reference1={projectNameRef} reference2={projectTypeRef} option1="nextjs" option2="react" option3="react-native" onClick={createProject}/>

        <div>{projects.map((project,i) => {
          return <div key={i} className="flex gap-5">

          <div>{project.id}</div>
          <div>{project.name}</div>
          <div>{project.type}</div>
          <button onClick={()=>{
            deleteProject(project.id)
          }}>Delete</button>
          </div>
        })}</div>
    </div>

    
  </div>
}


interface InputSelect {
  option1 : string,
  option2 : string,
  option3 : string,
  onClick : () => void,
  reference1 : Ref<HTMLInputElement>,
  reference2 : Ref<HTMLSelectElement>,
}

export const InputSelect = ({
  option1,
  option2,
  option3,
  onClick,
  reference1,
  reference2
} : InputSelect) => {
  return <div className="text-white">
    <div>
      <label>Choose a Framework</label>
      <input ref={reference1} type="text" placeholder="Enter project name"/>
      <select ref={reference2} id="frameworks">
          <option value={option1}>{option1}</option>
          <option value={option2}>{option2}</option>
          <option value={option3}>{option3}</option>
      </select>
    </div>
    
    <button onClick={onClick}>Submit</button>
  </div>
}