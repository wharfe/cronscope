import { createServer, type Server } from 'node:http';
import type { Snapshot } from '../types.js';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function renderHtml(snap: Snapshot): string {
  const conn = Object.entries(snap.connectors)
    .map(([k, v]) => `<span class="pill">${esc(k)}: ${esc(v!.state)}</span>`).join(' ');
  const rows = snap.jobs.map(j => `
    <tr>
      <td>${esc(j.source)}</td>
      <td>${esc(j.name)}</td>
      <td>${esc(j.schedule.raw)}</td>
      <td>${esc(j.schedule.nextRun ?? '-')}</td>
      <td class="s-${esc(j.lastRun?.status ?? 'unknown')}">${esc(j.lastRun?.status ?? 'unknown')}</td>
    </tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>cronscope</title>
    <style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse;width:100%}
    td,th{border-bottom:1px solid #ddd;padding:.4rem .6rem;text-align:left}
    .pill{background:#eef;padding:.1rem .5rem;border-radius:1rem;margin-right:.3rem}
    .s-failure{color:#c00;font-weight:600}.s-success{color:#080}.s-unknown{color:#888}</style>
    <h1>cronscope</h1><p>generated ${esc(snap.generatedAt)}</p><p>${conn}</p>
    <table><thead><tr><th>source</th><th>name</th><th>schedule</th><th>next</th><th>last</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function serveSnapshot(getSnapshot: () => Promise<Snapshot>, port: number): Server {
  const server = createServer(async (_req, res) => {
    const html = renderHtml(await getSnapshot());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  server.listen(port);
  return server;
}
