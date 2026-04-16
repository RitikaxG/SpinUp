import "dotenv/config";
import { runE2EPreflight } from "../lib/preflight/runEC2Preflight";

const ICON = {
  PASS: "✅",
  FAIL: "❌",
} as const;

async function main() {
  const report = await runE2EPreflight();

  console.log("");
  console.log("=== SpinUp E2E Preflight ===");
  console.log(`Started : ${report.startedAt}`);
  console.log(`Finished: ${report.finishedAt}`);
  console.log("");

  for (const result of report.results) {
    console.log(`${ICON[result.status]} ${result.name} — ${result.summary}`);

    if (Object.keys(result.details).length > 0) {
      console.log(JSON.stringify(result.details, null, 2));
    }

    console.log("");
  }

  if (!report.ok) {
    console.error("Preflight failed. Do not run end-to-end tests yet.");
    process.exit(1);
  }

  console.log("Preflight passed. Environment is ready for end-to-end testing.");
}

main().catch((err) => {
  console.error("Preflight script crashed.");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});