import type { Connector, Ctx, Job, Snapshot, Availability } from './types.js';

export async function runScan(connectors: Connector[], ctx: Ctx, bootAt: string | undefined): Promise<Snapshot> {
  const jobs: Job[] = [];
  const connState: Snapshot['connectors'] = {};
  for (const c of connectors) {
    let avail: Availability;
    try { avail = await c.availability(ctx); }
    catch (e) { avail = { state: 'unavailable', reason: String((e as Error).message) }; }
    connState[c.id] = avail;
    if (avail.state !== 'available') continue;
    try { jobs.push(...await c.discover(ctx)); }
    catch (e) { connState[c.id] = { state: 'unavailable', reason: String((e as Error).message) }; }
  }
  return {
    schemaVersion: 1, generatedAt: ctx.now().toISOString(),
    host: { bootAt }, connectors: connState, jobs,
  };
}
