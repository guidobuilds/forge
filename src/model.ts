export type Platform = 'opencode' | 'claude' | 'codex';
export type PlatformArg = Platform | 'all';
export type Scope = 'user' | 'project';
export type SourceKind = 'agent' | 'skill';
export type Severity = 'error' | 'warning' | 'info';
export type FileStatus = 'new' | 'managed-unmodified' | 'managed-modified' | 'foreign';

export type ProductConfig = {
  permissions?: unknown;
  model?: string;
  kind?: SourceKind;
};

export type OpenCodeMode = 'primary' | 'subagent' | 'all';

export type OpenCodeConfig = ProductConfig & {
  mode?: OpenCodeMode;
};

export type CanonicalArtifact = {
  name: string;
  description: string;
  kind: SourceKind;
  body: string;
  sourcePath: string;
  claude?: ProductConfig;
  opencode?: OpenCodeConfig;
  codex?: ProductConfig;
};

export type Diagnostic = {
  severity: Severity;
  code: string;
  message: string;
  sourcePath?: string;
  platform?: Platform;
};

export type OutputFile = {
  platform: Platform;
  scope: Scope;
  kind: SourceKind;
  name: string;
  path: string;
  sourcePath: string;
  content: string;
  status?: FileStatus;
  backupPath?: string;
};

export type PendingDecisions = {
  modifiedOverwrites: OutputFile[];
  foreignOverwrites: OutputFile[];
};

export type WritePlan = {
  files: OutputFile[];
  diagnostics: Diagnostic[];
  pending: PendingDecisions;
};

export type SourceItem = {
  sourcePath: string;
  expectedName: string;
  data: Record<string, unknown>;
  body: string;
  supportFiles?: string[];
};

export const platforms: Platform[] = ['opencode', 'claude', 'codex'];

export function isPlatform(value: string): value is Platform {
  return platforms.includes(value as Platform);
}

export function hasPendingDecisions(pending: PendingDecisions): boolean {
  return pending.modifiedOverwrites.length > 0 || pending.foreignOverwrites.length > 0;
}
