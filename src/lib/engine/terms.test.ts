import { describe, expect, it } from 'vitest';
import { nextTerm, sortSemesters, termOrdinal } from './validate';
import type { Semester, Term } from '$lib/types';

const sem = (term: Term, year: number): Semester => ({
	id: `${term}-${year}`,
	term,
	year,
	courses: []
});

/**
 * The rule behind the add tab on a term's edge: a tab appears exactly when the term that
 * follows is missing from the plan. Extracted here so it can be checked without a component.
 */
function needsAddTab(semesters: Semester[], sem: Semester, includeSummers: boolean): string | null {
	const next = nextTerm(sem.term, sem.year, includeSummers);
	const id = `${next.term}-${next.year}`;
	return semesters.some((s) => s.id === id) ? null : id;
}

/** Which slot a term occupies: its academic year runs Fall Y → Summer Y+1. */
const academicYear = (s: { term: Term; year: number }) => (s.term === 'fall' ? s.year : s.year - 1);

describe('term arithmetic', () => {
	it('runs fall to spring of the next calendar year', () => {
		expect(nextTerm('fall', 2026, false)).toEqual({ term: 'spring', year: 2027 });
	});

	it('skips summer unless the plan includes it', () => {
		expect(nextTerm('spring', 2027, false)).toEqual({ term: 'fall', year: 2027 });
		expect(nextTerm('spring', 2027, true)).toEqual({ term: 'summer', year: 2027 });
	});

	it('runs summer back to the autumn of the same calendar year', () => {
		expect(nextTerm('summer', 2027, true)).toEqual({ term: 'fall', year: 2027 });
	});

	it('orders spring before summer before fall within a year', () => {
		const o = (t: Term, y: number) => termOrdinal({ term: t, year: y });
		expect(o('spring', 2027)).toBeLessThan(o('summer', 2027));
		expect(o('summer', 2027)).toBeLessThan(o('fall', 2027));
		expect(o('fall', 2026)).toBeLessThan(o('spring', 2027));
	});
});

describe('the add tab appears at every seam', () => {
	it('offers the missing middle term, not just the end', () => {
		// Fall 2026 and Fall 2027 with no Spring 2027 between them.
		const plan = [sem('fall', 2026), sem('fall', 2027)];
		expect(needsAddTab(plan, plan[0], false)).toBe('spring-2027');
	});

	it('offers nothing when the next term is already there', () => {
		const plan = [sem('fall', 2026), sem('spring', 2027)];
		expect(needsAddTab(plan, plan[0], false)).toBeNull();
	});

	it('always offers something on the last term, so a plan can grow', () => {
		const plan = [sem('fall', 2026), sem('spring', 2027)];
		expect(needsAddTab(plan, plan[1], false)).toBe('fall-2027');
	});

	it('never offers a summer while summers are off', () => {
		const plan = [sem('fall', 2026), sem('spring', 2027), sem('fall', 2027)];
		for (const s of plan) {
			const next = needsAddTab(plan, s, false);
			if (next) expect(next).not.toContain('summer');
		}
	});

	it('offers the summer seam once summers are on', () => {
		const plan = [sem('fall', 2026), sem('spring', 2027), sem('fall', 2027)];
		expect(needsAddTab(plan, plan[1], true)).toBe('summer-2027');
	});

	it('marks every gap at once rather than one per click', () => {
		// Three autumns and no springs: all three tabs are live together.
		const plan = [sem('fall', 2026), sem('fall', 2027), sem('fall', 2028)];
		expect(plan.map((s) => needsAddTab(plan, s, false))).toEqual([
			'spring-2027',
			'spring-2028',
			'spring-2029'
		]);
	});
});

describe('terms sit in their own column', () => {
	it('groups an academic year from autumn through the following summer', () => {
		expect(academicYear(sem('fall', 2026))).toBe(2026);
		expect(academicYear(sem('spring', 2027))).toBe(2026);
		expect(academicYear(sem('summer', 2027))).toBe(2026);
		expect(academicYear(sem('fall', 2027))).toBe(2027);
	});

	it('keeps chronological order within a year for the layout to read', () => {
		const plan = sortSemesters([
			sem('summer', 2027),
			sem('fall', 2026),
			sem('spring', 2027)
		]);
		expect(plan.map((s) => s.id)).toEqual(['fall-2026', 'spring-2027', 'summer-2027']);
	});
});
