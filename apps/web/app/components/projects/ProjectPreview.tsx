import type { Project } from "../../types/project";
import { getPreviewUrl } from "../../lib/projectUrls";

export function ProjectPreview({ project }: { project: Project }) {
  if (project.status !== "READY") {
    return null;
  }

  const previewUrl = getPreviewUrl(project);

  if (!previewUrl) {
    return (
      <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
        <h2 className="text-2xl font-semibold text-white">
          Workspace preview
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          Workspace URL is unavailable because the project does not have a
          public IP yet.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
      <div>
        <p className="text-sm uppercase tracking-[0.3em] text-cyan-300">
          Code-server workspace
        </p>

        <h2 className="mt-2 text-2xl font-semibold text-white">
          Workspace preview
        </h2>

        <p className="mt-2 text-sm text-zinc-400">
          This preview shows the code-server workspace running on the assigned
          VM.
        </p>
      </div>

      <iframe
        src={previewUrl}
        title={`${project.name} code-server workspace`}
        className="mt-5 h-[720px] w-full rounded-xl border border-white/10 bg-black"
      />
    </section>
  );
}