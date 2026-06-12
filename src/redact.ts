// Masks obvious secrets so they never reach the snapshot, web UI, or Slack.
const PATTERNS: Array<[RegExp, string]> = [
  // key=value where key hints a secret
  [/((?:token|secret|key|pass(?:word)?|api[_-]?key|webhook)\s*[=:]\s*)\S+/gi, '$1***'],
  // credentials embedded in URLs: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, '$1***$2'],
  // Bearer tokens
  [/(Bearer\s+)\S+/gi, '$1***'],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
