export interface RawConfig {
  scanRoots?: string[];
  overdue?: { graceMinutes?: number };
  // tokens are read from env only; config holds env var names if needed
}

export interface ResolvedConfig { scanRoots: string[]; graceMinutes: number; }

function expandHome(p: string, home: string): string {
  return p.startsWith('~') ? home + p.slice(1) : p;
}

export function resolveConfig(raw: RawConfig, ctx: { homeDir: string; env: Record<string, string | undefined> }): ResolvedConfig {
  const roots = (raw.scanRoots && raw.scanRoots.length ? raw.scanRoots : ['~/dev']).map(r => expandHome(r, ctx.homeDir));
  return { scanRoots: roots, graceMinutes: raw.overdue?.graceMinutes ?? 60 };
}
