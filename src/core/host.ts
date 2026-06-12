import type { Ctx } from '../types.js';

export async function bootAt(ctx: Ctx): Promise<string | undefined> {
  let stat: string;
  try { stat = await ctx.readFile('/proc/stat'); } catch { return undefined; }
  const m = stat.match(/^btime\s+(\d+)/m);
  if (!m) return undefined;
  return new Date(Number(m[1]) * 1000).toISOString();
}
