import { describe, expect, it } from 'vitest';
import { kstDateString } from '$lib/server/kst.ts';

describe('KST calendar date', () => {
	it('treats 14:59 UTC on Aug 23 as KST Aug 23', () => {
		expect(kstDateString(() => new Date('2026-08-23T14:59:00Z'))).toBe('2026-08-23');
	});
	it('rolls over at KST midnight (15:00 UTC)', () => {
		expect(kstDateString(() => new Date('2026-08-23T15:00:00Z'))).toBe('2026-08-24');
	});
});
