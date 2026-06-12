import { describe, it, expect } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks key=value secrets', () => {
    expect(redact('run --token=abcd1234 --x')).toBe('run --token=*** --x');
  });
  it('masks credentials in URLs', () => {
    expect(redact('curl https://user:pass@example.com/x')).toBe('curl https://user:***@example.com/x');
  });
  it('masks bearer tokens', () => {
    expect(redact('Authorization: Bearer sk-abc.def')).toBe('Authorization: Bearer ***');
  });
  it('leaves plain text untouched', () => {
    expect(redact('uv run etl --last-n-days 4')).toBe('uv run etl --last-n-days 4');
  });
});
