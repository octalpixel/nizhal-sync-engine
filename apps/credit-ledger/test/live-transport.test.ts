import { describe, expect, it } from "vitest";
import { runLiveE2e } from "../examples/live-e2e.js";

describe("live over-the-wire transport", () => {
  it("passes HTTP sync, realtime WS ping, and listen-started job wiring on a real port", async () => {
    const output: string[] = [];
    const result = await runLiveE2e({ port: 0, log: (line) => output.push(line) });

    expect(result.passed).toBe(true);
    expect(result.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(output).toContain("✅ realtime ping received over WS");
    expect(output).toContain("✅ listen boots with jobs; sms-reminder row lands in _nizhal_jobs");
    expect(output).toContain("\nLIVE E2E PASSED ✅");
  });
});
