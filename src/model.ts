export type Platform = 'opencode' | 'claude' | 'codex';
export type PlatformArg = Platform | 'all';
export type Scope = 'user' | 'project';
export type SourceKind = 'agent' | 'skill';
export type Severity = 'error' | 'warning' | 'info';

export type ProductConfig = {
  permissions?: unknown;
  model?: string;
};

export type OpenCodeMode = 'primary' | 'subagent' | 'all';

export type OpenCodeConfig = ProductConfig & {
  mode?: OpenCodeMode;
};

export type CanonicalAgent = {
  name: string;
  description: string;
  definition: string;
  claude?: ProductConfig;
  opencode?: OpenCodeConfig;
  codex?: ProductConfig;
};

export type CanonicalSkill = {
  name: string;
  description: string;
  instructions: string;
  claude?: ProductConfig;
  opencode?: ProductConfig;
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
  content: string;
};

export type WritePlan = {
  files: OutputFile[];
  diagnostics: Diagnostic[];
};

export type SourceItem = {
  kind: SourceKind;
  sourcePath: string;
  expectedName: string;
  data: Record<string, unknown>;
  body: string;
};

export const platforms: Platform[] = ['opencode', 'claude', 'codex'];

export function isPlatform(value: string): value is Platform {
  return platforms.includes(value as Platform);
}
