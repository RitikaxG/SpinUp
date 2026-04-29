import type { Project, ProjectStatus } from "../../types/project";

type StepState = "done" | "active" | "pending" | "failed";

type BootStep = {
  title: string;
  description: string;
};

const steps: BootStep[] = [
  {
    title: "Project created",
    description: "Project row and workspace metadata were created.",
  },
  {
    title: "Allocating VM",
    description: "SpinUp is selecting or provisioning a warm EC2 instance.",
  },
  {
    title: "Booting container",
    description: "The VM is starting the code-server project container.",
  },
  {
    title: "Workspace ready",
    description: "IDE and app preview are available.",
  },
];

const getActiveIndex = (status: ProjectStatus) => {
  if (status === "CREATED" || status === "STOPPED") return 0;
  if (status === "ALLOCATING_VM") return 1;
  if (status === "BOOTING_CONTAINER") return 2;
  if (status === "READY") return 3;
  if (status === "FAILED") return 3;
  if (status === "DELETING" || status === "DELETED") return 3;

  return 0;
};

const getStepState = (
  status: ProjectStatus,
  stepIndex: number,
): StepState => {
  if (status === "FAILED" && stepIndex === 3) {
    return "failed";
  }

  if (status === "READY") {
    return "done";
  }

  const activeIndex = getActiveIndex(status);

  if (stepIndex < activeIndex) return "done";
  if (stepIndex === activeIndex) return "active";

  return "pending";
};

const getMarker = (state: StepState) => {
  if (state === "done") return "✓";
  if (state === "failed") return "!";
  if (state === "active") return "⏳";

  return "○";
};

const getMarkerClassName = (state: StepState) => {
  if (state === "done") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  }

  if (state === "failed") {
    return "border-red-500/40 bg-red-500/10 text-red-200";
  }

  if (state === "active") {
    return "border-cyan-500/40 bg-cyan-500/10 text-cyan-200";
  }

  return "border-white/10 bg-zinc-900 text-zinc-500";
};

export function BootProgress({ project }: { project: Project }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5">
      <div>
        <p className="text-sm uppercase tracking-[0.3em] text-cyan-300">
          Runtime lifecycle
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-white">
          Boot progress
        </h2>
      </div>

      <div className="mt-6 grid gap-4">
        {steps.map((step, index) => {
          const state = getStepState(project.status, index);

          return (
            <div key={step.title} className="flex gap-4">
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${getMarkerClassName(
                  state,
                )}`}
              >
                {getMarker(state)}
              </div>

              <div>
                <p className="font-medium text-white">{step.title}</p>
                <p className="mt-1 text-sm text-zinc-400">
                  {step.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}