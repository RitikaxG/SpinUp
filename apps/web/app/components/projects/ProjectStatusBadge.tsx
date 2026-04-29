import type { ProjectStatus } from "../../types/project";

const STATUS_STYLES: Record<ProjectStatus, string> = {
  CREATED: "border-slate-500/40 bg-slate-500/10 text-slate-200",
  ALLOCATING_VM: "border-blue-500/40 bg-blue-500/10 text-blue-200",
  BOOTING_CONTAINER: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
  READY: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  STOPPED: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  FAILED: "border-red-500/40 bg-red-500/10 text-red-200",
  DELETING: "border-orange-500/40 bg-orange-500/10 text-orange-200",
  DELETED: "border-zinc-700/40 bg-zinc-800/40 text-zinc-500",
};

const STATUS_LABELS: Record<ProjectStatus, string> = {
  CREATED: "Created",
  ALLOCATING_VM: "Allocating VM",
  BOOTING_CONTAINER: "Booting container",
  READY: "Ready",
  STOPPED: "Stopped",
  FAILED: "Failed",
  DELETING: "Deleting",
  DELETED: "Deleted",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}