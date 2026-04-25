#!/usr/bin/env bash
set -euo pipefail

FORGE_REPO="${FORGE_REPO:-guidobuilds/forge}"
FORGE_REF="${FORGE_REF:-main}"
RAW_BASE="https://raw.githubusercontent.com/${FORGE_REPO}/refs/heads/${FORGE_REF}"

AGENT_FILES="forge.md forge-worker.md"
SKILL_DIRS="using-forge forge-worker forge-explore forge-design forge-plan forge-build forge-helper"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

SCRIPT_DIR=""
if [[ "${BASH_SOURCE[0]}" != "bash" && -n "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

has_local_sources() {
  [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/agents" && -d "$SCRIPT_DIR/skills" ]]
}

fetch_or_copy() {
  local source_path="$1"
  local dest_path="$2"

  mkdir -p "$(dirname "$dest_path")"

  if has_local_sources && [[ -f "$SCRIPT_DIR/$source_path" ]]; then
    cp "$SCRIPT_DIR/$source_path" "$dest_path"
  else
    curl -fsSL "$RAW_BASE/$source_path" -o "$dest_path"
  fi
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
    fetch_or_copy "agents/$agent" "$agents_dir/$agent"
  done

  local skill
  for skill in $SKILL_DIRS; do
    fetch_or_copy "skills/$skill/SKILL.md" "$skills_dir/$skill/SKILL.md"
  done

  printf 'Installed Forge for %s:\n  %s\n  %s\n' "$name" "$agents_dir" "$skills_dir"
}

install_to "OpenCode" "$CONFIG_HOME/opencode/agents" "$CONFIG_HOME/opencode/skills"
install_to "Codex" "$HOME/.codex/agents" "$HOME/.codex/skills"
install_to "Claude Code" "$HOME/.claude/agents" "$HOME/.claude/skills"
