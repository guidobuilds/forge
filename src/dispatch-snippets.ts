import type { Platform } from './model.js';

// A snippet's class records WHAT kind of thing varies across platforms, so divergence is
// reviewable instead of accidental:
//   vocabulary — same behavior, different tool name only (freely varies per platform)
//   mechanism  — same policy, different implementation (varies per platform, with the difference
//                traceable to a real capability gap, e.g. PLATFORM_CAPABILITIES.supportsAgentSpawn)
//   policy     — the invariant itself; must NOT vary across platforms without a recorded waiver
//                (see tests/forge-cli.test.ts: "no policy-class dispatch snippet diverges")
export type SnippetClass = 'vocabulary' | 'mechanism' | 'policy';

export type DispatchSnippet = {
  class: SnippetClass;
  text: Partial<Record<Platform, string>> & { default?: string };
};

// Every instance of per-harness dispatch vocabulary in artifacts/*/*.md, found by mechanically
// grepping for Codex|Claude|OpenCode|Grok|spawn|task|Agent|DELEGATION_REQUESTS and classifying
// each hit (see .forge/harness-agnostic-adapters/design.md §5.5 / feature-list.json f4-t1). All
// five are `mechanism`-class: the difference is real (Codex's CLI agents have no spawn tool), not
// arbitrary wording. There are currently zero `policy`-class snippets — no instance of the
// invariant itself ("never do worker work inline", "leaves never spawn") varies by platform.
export const DISPATCH_SNIPPETS: Record<string, DispatchSnippet> = {
  'worker-spawn-leaf-instruction': {
    class: 'mechanism',
    text: {
      claude: 'Spawn `forge-worker-leaf` via `Agent`, passing `DISPATCH_DEPTH: 2`, `WORKER_ROLE: leaf`, `TASK_ID`, subgoal, constraints, and `files_hint`. Omit `DELEGATION_REQUESTS`.',
      grok: 'Spawn `forge-worker-leaf` via `task`, passing `DISPATCH_DEPTH: 2`, `WORKER_ROLE: leaf`, `TASK_ID`, subgoal, constraints, and `files_hint`. Omit `DELEGATION_REQUESTS`.',
      opencode: 'Spawn `forge-worker-leaf` via `task`, passing `DISPATCH_DEPTH: 2`, `WORKER_ROLE: leaf`, `TASK_ID`, subgoal, constraints, and `files_hint`. Omit `DELEGATION_REQUESTS`.',
      codex: 'Return `DELEGATION_REQUESTS` for the orchestrator to fan out `forge-worker-leaf` dispatches, including `DISPATCH_DEPTH: 2`, `WORKER_ROLE: leaf`, `TASK_ID`, subgoal, constraints, and `files_hint`.'
    }
  },
  'who-spawns-leaf': {
    class: 'mechanism',
    text: {
      claude: 'coordinators spawn it directly',
      grok: 'coordinators spawn it directly',
      opencode: 'coordinators spawn it directly',
      codex: 'you fan out leaves yourself when a coordinator returns `DELEGATION_REQUESTS`, since coordinators cannot self-spawn there'
    }
  },
  'orchestrator-delegation-requests-handling': {
    class: 'mechanism',
    text: {
      codex: 'On `DELEGATION_REQUESTS`, fan out `forge-worker-leaf` dispatches yourself.',
      default: '`forge-worker` self-spawns `forge-worker-leaf` directly, so `DELEGATION_REQUESTS` should not normally appear here; fan out `forge-worker-leaf` dispatches yourself if it does.'
    }
  },
  'worker-must-spawn-or-delegate': {
    class: 'mechanism',
    text: {
      codex: 'return `DELEGATION_REQUESTS`',
      default: 'spawn leaves'
    }
  },
  'codex-orchestrator-dispatch-hint': {
    class: 'mechanism',
    text: {
      codex: '- Codex: parse `DELEGATION_REQUESTS` and fan out `forge-worker-leaf` yourself',
      default: ''
    }
  }
};

export function resolveSnippet(id: string, platform: Platform): string {
  const snippet = DISPATCH_SNIPPETS[id];
  if (!snippet) throw new Error(`Unknown dispatch snippet "${id}" referenced in a canonical artifact body`);
  const text = snippet.text[platform] ?? snippet.text.default;
  if (text === undefined) throw new Error(`Dispatch snippet "${id}" has no text for platform "${platform}" and no default`);
  return text;
}
