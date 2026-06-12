import parser from 'cron-parser';

function build(expr: string, from: Date, tz: string) {
  return parser.parseExpression(expr, { currentDate: from, tz });
}

export function cronNext(expr: string, from: Date, tz = 'UTC'): string | null {
  try { return build(expr, from, tz).next().toDate().toISOString(); }
  catch { return null; }
}

export function cronPrev(expr: string, from: Date, tz = 'UTC'): string | null {
  try { return build(expr, from, tz).prev().toDate().toISOString(); }
  catch { return null; }
}
