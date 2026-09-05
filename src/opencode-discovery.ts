// Backward-compatible re-export shim. The canonical discovery module is `src/model-discovery.ts`;
// this file exists only to preserve the stable `src/opencode-discovery.js` import path used by
// `src/cli.ts` and the tests. The runner abstraction, shared caps, `discoverOpenCodeModels`, and the
// platform dispatcher now live in `src/model-discovery.ts`.
export { defaultRunner, discoverOpenCodeModels, MODEL_DISCOVERY_TIMEOUT_MS, MODEL_DISCOVERY_MAX_STDOUT_BYTES, MODEL_DISCOVERY_MAX_MODELS } from './model-discovery.js';
export type { ModelDiscoveryRunner } from './model-discovery.js';
