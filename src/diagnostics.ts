import type { Diagnostic, Platform } from './model.js';

export function diagnostic(severity: Diagnostic['severity'], code: string, message: string, extras: Partial<Pick<Diagnostic, 'sourcePath' | 'platform'>> = {}): Diagnostic {
  return { severity, code, message, ...extras };
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.sourcePath ? ` ${diagnostic.sourcePath}` : '';
  const platform = diagnostic.platform ? ` [${diagnostic.platform}]` : '';
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${platform}${location}: ${diagnostic.message}`;
}

export function info(code: string, message: string, platform?: Platform): Diagnostic {
  return diagnostic('info', code, message, platform ? { platform } : {});
}
