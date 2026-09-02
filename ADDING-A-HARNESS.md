# Adding a Harness

Forge defines an operating model (an orchestrator that delegates, a coordinator/leaf worker split, an adversarial verify gate) and translates it per ecosystem via `src/adapters/*.ts`. This is the ordered set of questions a new harness (a 5th platform, beyond Claude Code/OpenCode/Codex/Grok Build) needs answered before it's wired in — derived from the real questions this codebase got wrong at least twice (guessed Grok's capabilities from `forge-worker`'s frontmatter instead of `forge`'s; inherited a Claude Code limitation two releases after it stopped being true) before a dedicated research pass caught it. Answer these with citations from the harness's own docs, not by analogy to an existing platform — two of Forge's four platforms turned out to need opposite answers to the same question (Claude and Codex each have this problem: their *primary CLI channel* and any *plugin/marketplace channel* can have different capabilities for the same nominal platform).

Do not add a row to `Platform` (`src/model.ts`) until every question below has a cited answer or an explicit "unenforceable, documented" fallback.

## 1. Shape

- What is the orchestrator's (`forge`'s) correct install shape here — a skill-equivalent (loaded prompt, no tool restriction), a real agent/subagent definition, or something else the harness calls neither?
- Can the harness's agent-equivalent be selected as the thing the user directly, continuously converses with (turn by turn) — or is "agent" here always a bounded, non-interactive sub-task dispatch that runs to completion and returns a result? These are not the same capability. Getting this backwards is exactly the mistake this project almost made with Claude Code: `AskUserQuestion` (needed for `forge-grill`'s interactive stress-testing) turned out to be stripped from bounded sub-task dispatches but *not* from an agent configured as the session's main driver — a distinction the docs state once, easy to miss, and load-bearing for whether Forge's approval/grill workflow works at all on this harness.
- If the harness's agent-equivalent can be configured as the default/primary driver of a session (Claude Code: `"agent"` in `settings.json` or `--agent`; OpenCode: `mode: primary`), does converting `forge` to that shape gain a real capability, or does it lose the harness's native default entry point (e.g. a `/forge`-style slash command) with no equivalent replacement? If the harness has no such config, converting is likely a regression, not an upgrade — leave `forge` as whatever the harness's model-invoked, always-loaded mechanism is, and record why.

## 2. Enforcement

- Does the harness support a **structural** tool allowlist/denylist on an agent definition (the harness actually refuses the call), or only **advisory** prompt text the model can be told to follow but isn't mechanically stopped from ignoring? Name the actual frontmatter/config field.
- If structural: what's the exact set of tool identifiers `forge` needs to keep (dispatch to `forge-worker`/`forge-adversary`, track a todo list, load a background skill-equivalent if the harness has one, ask the user a question) versus deny (direct read/write/edit/execute)? Verify these tool names against the harness's own current docs before writing them into `artifacts/*/*.md` — do not assume they match another platform's names.
- If only advisory: say so explicitly in this harness's own installed prose and record it as a known, accepted limitation (matching `forge`'s current Grok row) — do not silently ship an unenforced claim of "structural."
- Does the harness support a per-artifact sandbox/execution-mode declaration (Codex: `sandbox_mode`)? If so, `forge` gets the most restrictive safe setting (read-only/no-write), and `forge-worker`/`forge-worker-leaf`/`forge-adversary` get whatever setting permits their actual file/exec needs, declared explicitly rather than left to an implicit default.
- Does the harness have any concept of "this skill/prompt is background-only, not directly user-invocable" (Claude Code: `user-invocable: false`)? If not, `using-forge` and `forge-grill` will be directly reachable by the user on this harness — emit an install-time diagnostic saying so (see `GROK_SKILL_DISCOVERABLE_UNENFORCED` / `OPENCODE_SKILL_DISCOVERABLE_UNENFORCED` in `src/adapters/grok.ts` / `opencode.ts` for the existing pattern), rather than leaving it silent.

## 3. Dispatch vocabulary

- What is the literal tool/mechanism name for "spawn another named agent" on this harness? This is the value that varies per platform in `forge-worker`'s and `using-forge`'s canonical prose today (`Agent` on Claude, `task` on Grok/OpenCode). If the harness has no such capability at all (like Codex's plugin channel used to, before it was removed — see `.forge/harness-agnostic-adapters/design.md` §2.4 for the fallback pattern that existed for it), the coordinator needs an explicit non-spawning fallback path, not a silent gap.
- Can this harness's agent definition restrict *which* named agents it's allowed to spawn (Claude Code's `Agent(name1, name2)` allowlist syntax), or only whether it can spawn at all? If the former, use it on `forge` (allowlist exactly `forge-worker` and `forge-adversary`) and on `forge-worker` (allowlist exactly `forge-worker-leaf`) rather than an unrestricted grant — this is what makes the depth cap (§4 below) structural instead of advisory.

## 4. Model support

- Does an agent-kind artifact on this harness support declaring a model? Does a skill-equivalent? (Today, 3 of 4 platforms silently drop `model` on skill-kind artifacts — see `OPENCODE_SKILL_MODEL_IGNORED`/`CODEX_SKILL_MODEL_IGNORED`/`GROK_SKILL_MODEL_IGNORED` in the adapters.) Get this right per (platform × effective-kind), not per platform alone — `forge`'s effective kind already varies by platform today.
- What are this harness's actual current model identifiers? Look them up fresh; do not copy another platform's list. Add a `<platform>-known.ts` allow-list module (see `claude-known.ts`/`grok-known.ts`) so the installer's model prompt and the validator agree — a prompt that recommends a model its own validator then warns about is a defect, not a warning worth shipping.

## 5. Conformance

Before merging the new adapter, it must pass (or extend, if the property is genuinely inapplicable — with a recorded reason, not a deletion) the cross-harness conformance tests in `tests/forge-cli.test.ts` (search `conformance:`):

1. `forge` cannot execute directly wherever structural enforcement is claimed for it — verified against the *rendered output*, not the frontmatter source (a canonical `tools:` field means nothing if the target adapter silently drops it).
2. `forge-worker` can dispatch; `forge-worker-leaf` cannot, on every platform.
3. Every artifact name referenced in every rendered body resolves to an artifact actually installed on that platform — this is what catches a stale cross-reference left behind by a removed channel or a renamed artifact (it would have caught `forge-grill.md`'s old reference to a Codex-plugin-only path before that channel was removed).

## 6. Distribution

- Does this harness have its own plugin/marketplace mechanism the way Claude Code and Codex do? Forge's answer as of this writing (see `CHANGELOG.md` `[0.8.0]`) is: don't build a second channel for it. The npm CLI (`npx @guidobuilds/forge-ai install --platform <name>`) is the only supported distribution method across all platforms. Wire the new harness into `src/paths.ts` (output path/extension per kind) and `resolvePlatforms`/`Platform` (`src/model.ts`) — nothing else.

## Reference

`.forge/harness-agnostic-adapters/design.md` and `decisions.md` are the design record this file was distilled from — read them for the full reasoning and the mistakes that were caught (and the ones that weren't, until an adversarial pass caught them) while adding structural enforcement to the existing four harnesses.
