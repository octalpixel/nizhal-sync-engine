import { creditScenarios } from "./credit/scenarios.js";
import { capturePersistenceLogErrors } from "./harness/persistence-log-guard.js";
import { posScenarios } from "./pos/scenarios.js";
import { syncScenarios } from "./sync/scenarios.js";

export interface ScenarioResult {
  id: string;
  status: "PASS" | "FAIL";
  error?: string;
  durationMs: number;
}

async function runScenario(scenario: {
  id: string;
  run: () => Promise<void>;
}): Promise<ScenarioResult> {
  const started = Date.now();
  try {
    await scenario.run();
    return { id: scenario.id, status: "PASS", durationMs: Date.now() - started };
  } catch (error) {
    return {
      id: scenario.id,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

async function main() {
  const persistenceLogGuard = capturePersistenceLogErrors();

  process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error && reason.message.includes("poisoned after")) {
      return;
    }
    throw reason;
  });

  const scenarios = [...posScenarios, ...creditScenarios, ...syncScenarios];
  const results: ScenarioResult[] = [];

  console.log(
    `\nNizhal chaos suite — ${scenarios.length} scenarios (pglite${process.env.NEON_URL ? " + NEON_URL" : ""})\n`,
  );

  for (const scenario of scenarios) {
    process.stdout.write(`${scenario.id} ... `);
    const result = await runScenario(scenario);
    results.push(result);
    console.log(result.status === "PASS" ? "PASS" : `FAIL — ${result.error}`);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  persistenceLogGuard.restore();
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (persistenceLogGuard.messages.length > 0) {
    console.error("\nLogged persistence errors:");
    for (const message of persistenceLogGuard.messages) {
      console.error(`  ${message}`);
    }
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error("\nFailed scenarios:");
    for (const result of failed) {
      console.error(`  ${result.id}: ${result.error}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
