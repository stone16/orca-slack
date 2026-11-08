import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('SF3 public documentation excludes local verification run records', () => {
  expect(existsSync(new URL('../docs/verification/2026-11-08-lead-routing.md', import.meta.url))).toBe(false);
  expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).not.toContain('docs/verification/');
});
