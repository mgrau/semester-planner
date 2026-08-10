import { describe, expect, it } from 'vitest';
import { isStale, MAX_AGE_MS } from './selfUpdate';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
/** Build stamps are Unix seconds, the form svelte.config.js writes. */
const hours = (n: number) => String(Math.floor((NOW - n * 3600_000) / 1000));

describe('isStale', () => {
	it('leaves a recent build alone', () => {
		expect(isStale(hours(1), NOW)).toBe(false);
		expect(isStale(hours(47), NOW)).toBe(false);
	});

	it('flags code older than the maximum age', () => {
		expect(isStale(hours(49), NOW)).toBe(true);
		expect(isStale(hours(24 * 30), NOW)).toBe(true);
	});

	it('treats an unstamped build as current rather than reloading forever', () => {
		expect(isStale('', NOW)).toBe(false);
		expect(isStale('unknown', NOW)).toBe(false);
		// A dev build has no stamp at all; it must never decide it is out of date.
		expect(isStale(undefined as unknown as string, NOW)).toBe(false);
	});

	it('holds at 48 hours', () => {
		expect(MAX_AGE_MS).toBe(48 * 3600_000);
		expect(isStale(String((NOW - MAX_AGE_MS) / 1000), NOW)).toBe(false);
		expect(isStale(String((NOW - MAX_AGE_MS) / 1000 - 1), NOW)).toBe(true);
	});
});
