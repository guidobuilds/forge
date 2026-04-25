#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AGENT_FILES="forge.md forge-worker.md"
SKILL_DIRS="using-forge forge-worker forge-explore forge-design forge-plan forge-build forge-helper"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

copy_local_file() {
  local source_path="$1"
  local dest_path="$2"

  if [[ ! -f "$ROOT_DIR/$source_path" ]]; then
    printf 'Missing required local source: %s\n' "$ROOT_DIR/$source_path" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dest_path")"
  cp "$ROOT_DIR/$source_path" "$dest_path"
}

cleanup_dest() {
  local agents_dir="$1"
  local skills_dir="$2"

  mkdir -p "$agents_dir" "$skills_dir"

  rm -f "$agents_dir"/forge*.md
  rm -rf "$skills_dir"/forge* "$skills_dir/using-forge"
}

install_to() {
  local name="$1"
  local agents_dir="$2"
  local skills_dir="$3"

  cleanup_dest "$agents_dir" "$skills_dir"

  local agent
  for agent in $AGENT_FILES; do
    copy_local_file "agents/$agent" "$agents_dir/$agent"
  done

  local skill
  for skill in $SKILL_DIRS; do
    copy_local_file "skills/$skill/SKILL.md" "$skills_dir/$skill/SKILL.md"
  done

  printf 'Installed local Forge for %s:\n  %s\n  %s\n' "$name" "$agents_dir" "$skills_dir"
}

install_to "OpenCode" "$CONFIG_HOME/opencode/agents" "$CONFIG_HOME/opencode/skills"
install_to "Codex" "$CONFIG_HOME/codex/agents" "$CONFIG_HOME/codex/skills"
install_to "Claude Code" "$HOME/.claude/agents" "$HOME/.claude/skills"
