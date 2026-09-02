// OpenCode has no fixed model enum — models.dev's catalog, filtered to whatever providers the
// user has credentials for (env var, stored auth, or a config/plugin-declared provider). The
// `provider/model-id` format is verified (opencode.ai/v2/docs/models: "Provider and model IDs are
// case-sensitive"); the model id itself MAY contain further slashes (e.g.
// `openrouter/openai/gpt-5-chat` is provider `openrouter`, model `openai/gpt-5-chat`), so this
// pattern only requires a first segment before the first `/`, not exactly two segments.
// OpenCode itself does not validate `model` at load time — a bad value fails only when the agent
// first runs (ModelNotFoundError) — so this pattern check is a genuine safety net, not redundant.
// Prefer live discovery (`opencode models`, see src/opencode-discovery.ts) when available; this is
// the fallback for when that isn't possible (non-interactive install, opencode not on PATH, a v2
// install predating the `models` command, etc).
const openCodeModelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/.+$/;

export function isKnownOpenCodeModel(value: string): boolean {
  return openCodeModelPattern.test(value);
}
