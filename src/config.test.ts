import { describe, it, expect } from 'vitest';
import { resolveConfig } from './config.js';

describe('resolveConfig', () => {
  it('defaults scanRoots to ~/dev and grace to 60', () => {
    const c = resolveConfig({}, { homeDir: '/home/u', env: {} });
    expect(c.scanRoots).toEqual(['/home/u/dev']);
    expect(c.graceMinutes).toBe(60);
  });
  it('expands ~ in scanRoots and reads overdue grace', () => {
    const c = resolveConfig({ scanRoots: ['~/work'], overdue: { graceMinutes: 30 } }, { homeDir: '/home/u', env: {} });
    expect(c.scanRoots).toEqual(['/home/u/work']);
    expect(c.graceMinutes).toBe(30);
  });
});
