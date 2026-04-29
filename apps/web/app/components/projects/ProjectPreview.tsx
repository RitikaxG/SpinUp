import type { Project } from "../../types/project";
import { getPreviewUrl } from "../../lib/projectUrls";

export function ProjectPreview({ project }: { project: Project }) {
  if (project.status !== "READY") {
    return null;
  }

  if (project.type === "REACT_NATIVE") {
    return (
      <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
        <h2 className="text-2xl font-semibold text-white">App preview</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Browser preview is not supported for React Native projects.
        </p>
      </section>
    );
  }

  const previewUrl = getPreviewUrl(project);

  if (!previewUrl) {
    return (
      <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
        <h2 className="text-2xl font-semibold text-white">App preview</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Preview URL is unavailable because the project does not have a public
          IP yet.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-cyan-300">
            Live app
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-white">
            Preview app
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            This iframe is best for local HTTP demos. If the hosted control
            plane blocks it, open the preview in a new tab.
          </p>
        </div>

        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
        >
          Open preview in new tab
        </a>
      </div>

      <iframe
        src={previewUrl}
        title={`${project.name} app preview`}
        className="mt-5 h-[720px] w-full rounded-xl border border-white/10 bg-white"
      />
    </section>
  );
}