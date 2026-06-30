export * from "./types.js";
export * from "./schema.js";
export * from "./mutator.js";
export * from "./sync-rules.js";
export * from "./contract.js";
export * from "./hlc.js";

// Re-export zod's `z` so mutator/schema validation has a single, version-matched
// source — `import { z } from "@nizhal/kernel"` (kernel owns the zod version).
export { z } from "zod";
