// Codex's current model-id list was not verified against live docs at the time this was written
// (unlike Claude/Grok/OpenCode, which have a confirmed format). Rather than invent a shape we
// haven't checked, this accepts any non-empty, whitespace-free value and lets Codex itself be the
// real check — the same "don't guess" discipline this codebase applies elsewhere. Tighten this
// once Codex's actual model-id format is verified against its docs.
const codexModelPattern = /^\S+$/;

export function isKnownCodexModel(value: string): boolean {
  return codexModelPattern.test(value);
}
