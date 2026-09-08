import type { Ctx } from '../types.js';

export interface GhRepoRef { owner: string; repo: string }

// Covers what git actually writes into remote.origin.url: https (with or
// without embedded credentials), scp-style ssh, and ssh://. The host may carry
// an ssh-config alias suffix (github.com-work). A trailing slash must not end
// up inside the repo name.
const REMOTE_RE = /^(?:https:\/\/(?:[^@/]+@)?github\.com(?:-[\w.-]+)?\/|git@github\.com(?:-[\w.-]+)?:|ssh:\/\/git@github\.com(?:-[\w.-]+)?\/)([^/]+)\/(.+?)(?:\.git)?\/?$/;

export function parseRemoteUrl(url: string): GhRepoRef | null {
  const m = url.trim().match(REMOTE_RE);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// `gh auth token` spawns a process; availability() and discover() both need the
// token, so memoize per Ctx rather than paying for it twice a scan.
const tokenCache = new WeakMap<Ctx, Promise<string | null>>();

export function resolveToken(ctx: Ctx): Promise<string | null> {
  let hit = tokenCache.get(ctx);
  if (!hit) {
    hit = (async () => {
      for (const name of ['CRONSCOPE_GH_TOKEN', 'GITHUB_TOKEN']) {
        const v = ctx.env[name];
        if (v && v.trim()) return v.trim();
      }
      const r = await ctx.run(['gh', 'auth', 'token']);
      const out = r.stdout.trim();
      return r.code === 0 && out ? out : null;
    })();
    tokenCache.set(ctx, hit);
  }
  return hit;
}

export async function resolveRepoRef(ctx: Ctx, repoDir: string): Promise<GhRepoRef | null> {
  const r = await ctx.run(['git', '-C', repoDir, 'remote', 'get-url', 'origin']);
  return r.code === 0 ? parseRemoteUrl(r.stdout) : null;
}
