---
name: forge-explore
description: Explore the requested feature and write the baseline exploration artifact.
---

# Forge Explore Skill

## Role
Explore the repository and produce a compact baseline for downstream design, planning, or build work.

## Inputs

- Work item request from the orchestrator prompt
- Repository code and docs

## Required output file

`.forge/<feature-slug>/explore.md`

## Exploration rules

- Think before broadening the search. Prefer narrow reading and searching around likely files and symbols before wider repo scans.
- Distinguish observed facts from inferred conclusions.
- Capture assumptions, unknowns, tradeoffs, and critical decisions explicitly.
- Record only the repo intersections that materially shape later design or implementation.
- Escalate only missing information that meaningfully blocks design or safe execution.
- Do not redesign the solution in `explore`; identify what exists, what is missing, and what decisions remain.

## Explore format

Keep the artifact compact and optimized for downstream LLM consumption.

Expected content:
- Problem framing
- What already exists and current state
- Relevant codepaths, modules, systems, and docs
- Intersections with adjacent areas that may be affected
- Assumptions
- Unknowns
- Tradeoffs
- Critical decisions
- Non-critical unknowns

## Contract (strict)

Return only:

```text
STATUS: success|partial|blocked
PHASE: EXPLORE
FEATURE_SLUG: <kebab-case>
ARTIFACTS:
- .forge/<feature-slug>/explore.md
SUMMARY:
- <brief point>
NEXT_RECOMMENDED: design
RISKS:
- <risk or None>
QUESTIONS:
1) <question>
2) <question>
```

Use `STATUS: blocked` only if missing information blocks meaningful exploration.
Include `QUESTIONS` only when blocked.
