import type { Connector, Ctx, Job, Snapshot, Availability } from './types.js';

export async function runScan(connectors: Connector[], ctx: Ctx, bootAt: string | undefined): Promise<Snapshot> {
  const jobs: Job[] = [];
  const connState: Snapshot['connectors'] = {};
  for (const c of connectors) {
    let avail: Availability;
    // `thrownBy` marks a connector that fell over, which `check` notifies
    // (wharfe/cronscope#5). Only the two catches below may set it, so a
    // self-declared unavailable is rebuilt without it.
    try {
      const got = await c.availability(ctx);
      avail = got.state === 'unavailable' ? { state: 'unavailable', reason: got.reason } : got;
    }
    catch (e) { avail = { state: 'unavailable', reason: String((e as Error).message), thrownBy: 'availability' }; }
    connState[c.id] = avail;
    if (avail.state === 'unavailable' || avail.state === 'skipped') continue;
    try { jobs.push(...await c.discover(ctx)); }
    catch (e) { connState[c.id] = { state: 'unavailable', reason: String((e as Error).message), thrownBy: 'discover' }; }
  }
  return {
    schemaVersion: 1, generatedAt: ctx.now().toISOString(),
    host: { bootAt }, connectors: connState, jobs,
  };
}
