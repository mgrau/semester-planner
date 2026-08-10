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
 * The rule "+ Term" follows, extracted so it can be checked without a component: add the
 * earliest missing term, and only extend past the end once the sequence is unbroken.
 */
function nextToAdd(semesters: Semester[], includeSummers: boolean): string | null {
	const sorted = sortSemesters(semesters);
	if (!sorted.length) return null;
	const have = new Set(sorted.map((x) => x.id));
	const last = sorted[sorted.length - 1];
	let cur = { term: sorted[0].term, year: sorted[0].year };
	while (termOrdinal(cur) <= termOrdinal(last)) {
		if (!have.has(`${cur.term}-${cur.year}`)) return `${cur.term}-${cur.year}`;
		cur = nextTerm(cur.term, cur.year, includeSummers);
	}
	return have.has(`${cur.term}-${cur.year}`) ? null : `${cur.term}-${cur.year}`;
}

describe('term arithmetic', () => {
	it('runs fall to spring of the next calendar year', () => {
		expect(nextTerm('fall', 2026, false)).toEqual({ term: 'spring', year: 2027 });
	});

	it('skips summer unless the plan includes it', () => {
		expect(nextTerm('spring', 2027, false)).toEqual({ term: 'fall', year: 2027 });
		expect(nextTerm('spring', 2027, true)).toEqual({ term: 'summer', year: 2027 });
	});

	it('orders spring before summer before fall within a year', () => {
		const o = (t: Term, y: number) => termOrdinal({ term: t, year: y });
		expect(o('spring', 2027)).toBeLessThan(o('summer', 2027));
		expect(o('summer', 2027)).toBeLessThan(o('fall', 2027));
		expect(o('fall', 2026)).toBeLessThan(o('spring', 2027));
	});
});

describe('+ Term fills the earliest gap', () => {
	it('adds the missing middle term rather than extending the end', () => {
		// Fall 2026 and Fall 2027 with no Spring 2027 between them.
		expect(nextToAdd([sem('fall', 2026), sem('fall', 2027)], false)).toBe('spring-2027');
	});

	it('extends past the end when the sequence is unbroken', () => {
		expect(nextToAdd([sem('fall', 2026), sem('spring', 2027)], false)).toBe('fall-2027');
	});

	it('never offers a summer when summers are off', () => {
		const plan = [sem('fall', 2026), sem('fall', 2027)];
		for (let i = 0; i < 6; i++) {
			const next = nextToAdd(plan, false);
			if (!next) break;
			expect(next, 'summer offered with summers off').not.toContain('summer');
			const [term, year] = next.split('-');
			plan.push(sem(term as Term, Number(year)));
		}
	});

	it('offers the summer gap when summers are on', () => {
		expect(nextToAdd([sem('fall', 2026), sem('spring', 2027), sem('fall', 2027)], true)).toBe(
			'summer-2027'
		);
	});

	it('fills several gaps one call at a time, earliest first', () => {
		const plan = [sem('fall', 2026), sem('fall', 2027), sem('fall', 2028)];
		const added: string[] = [];
		for (let i = 0; i < 2; i++) {
			const next = nextToAdd(plan, false)!;
			added.push(next);
			const [term, year] = next.split('-');
			plan.push(sem(term as Term, Number(year)));
		}
		expect(added).toEqual(['spring-2027', 'spring-2028']);
	});
});
