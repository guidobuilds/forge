// Codex's model-id set changes over time and is account/plan dependent, so `isKnownCodexModel`
// stays deliberately permissive: it accepts any non-empty, whitespace-free value and lets Codex
// itself be the real check — the same "don't guess" discipline this codebase applies elsewhere.
// This is a safety net against empty/whitespace values, NOT a validation gate on the model list.
//
// `knownCodexModels` is the OFFLINE FALLBACK presented only when live `codex debug models` discovery
// fails (absent binary / non-zero exit / non-JSON / over-cap / timeout, or always on Windows fail-
// closed). It is suggestions-only (the prompt also offers a `Custom…` free-text escape) and is NOT a
// validation gate. Its ids are the list-visible, user-selectable catalog observed from a real
// `codex debug models` run on the reference machine (explore.md §2 / verification.md):
//   gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4-mini
// If the fallback drifts to ids outside this observed set, a failed live discovery degrades to models
// the installed codex may not recognize — update it only from fresh live evidence, never by guessing.
export const knownCodexModels = new Set<string>([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4-mini'
]);

const codexModelPattern = /^\S+$/;

export function isKnownCodexModel(value: string): boolean {
  return codexModelPattern.test(value);
}
