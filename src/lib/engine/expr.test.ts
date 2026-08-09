import { describe as suite, expect, it } from 'vitest';
import { coursesIn, describe, evaluate, type CreditState } from './expr';
import type { Expr } from '$lib/types';

const state = (codes: string[], grades: Record<string, 'A' | 'B' | 'C' | 'D'> = {}): CreditState => ({
	completed: new Set(codes),
	grades: new Map(Object.entries(grades) as [string, 'A' | 'B' | 'C' | 'D'][])
});

suite('evaluate', () => {
	it('satisfies a bare course leaf', () => {
		expect(evaluate({ course: 'MATH 211' }, state(['MATH 211'])).satisfied).toBe(true);
		expect(evaluate({ course: 'MATH 211' }, state([])).satisfied).toBe(false);
	});

	it('enforces a minimum grade when one is recorded', () => {
		const e: Expr = { course: 'MATH 211', min_grade: 'C' };
		expect(evaluate(e, state(['MATH 211'], { 'MATH 211': 'B' })).satisfied).toBe(true);
		expect(evaluate(e, state(['MATH 211'], { 'MATH 211': 'D' })).satisfied).toBe(false);
	});

	it('treats an unrecorded grade as passing, since plans precede grades', () => {
		expect(evaluate({ course: 'MATH 211', min_grade: 'C' }, state(['MATH 211'])).satisfied).toBe(
			true
		);
	});

	it('handles PHYS 232N: (231N or 226N or 261N) and (MATH 211 and MATH 212)', () => {
		const e: Expr = {
			all_of: [
				{
					one_of: [
						{ course: 'PHYS 231N', min_grade: 'C' },
						{ course: 'PHYS 226N', min_grade: 'C' },
						{ course: 'PHYS 261N', min_grade: 'C' }
					]
				},
				{
					all_of: [
						{ course: 'MATH 211', min_grade: 'C' },
						{ course: 'MATH 212', min_grade: 'C' }
					]
				}
			]
		};
		expect(evaluate(e, state(['PHYS 231N', 'MATH 211', 'MATH 212'])).satisfied).toBe(true);
		expect(evaluate(e, state(['PHYS 261N', 'MATH 211', 'MATH 212'])).satisfied).toBe(true);
		// missing MATH 212
		expect(evaluate(e, state(['PHYS 231N', 'MATH 211'])).satisfied).toBe(false);
		// no intro physics
		expect(evaluate(e, state(['MATH 211', 'MATH 212'])).satisfied).toBe(false);
	});

	it('reports the alternatives that would close an unmet one_of', () => {
		const r = evaluate({ one_of: [{ course: 'MATH 312' }, { course: 'MATH 285' }] }, state([]));
		expect(r.satisfied).toBe(false);
		expect(r.missing).toEqual(['MATH 312', 'MATH 285']);
	});

	it('passes unresolvable clauses but surfaces them as notes', () => {
		const e: Expr = {
			all_of: [{ course: 'PHYS 297' }, { note: 'Permission of the instructor' }]
		};
		const r = evaluate(e, state(['PHYS 297']));
		expect(r.satisfied).toBe(true);
		expect(r.notes).toEqual(['Permission of the instructor']);
	});

	it('does not let a note rescue a genuinely unmet course requirement', () => {
		const e: Expr = {
			all_of: [{ course: 'PHYS 297' }, { note: 'Permission of the instructor' }]
		};
		expect(evaluate(e, state([])).satisfied).toBe(false);
	});

	it('handles n_of', () => {
		const e: Expr = {
			n_of: { n: 2, options: [{ course: 'A 100' }, { course: 'B 100' }, { course: 'C 100' }] }
		};
		expect(evaluate(e, state(['A 100', 'C 100'])).satisfied).toBe(true);
		expect(evaluate(e, state(['A 100'])).satisfied).toBe(false);
	});

	it('treats a null prereq as satisfied', () => {
		expect(evaluate(null, state([])).satisfied).toBe(true);
	});
});

suite('coursesIn', () => {
	it('collects every course mentioned, ignoring notes', () => {
		const e: Expr = {
			all_of: [
				{ one_of: [{ course: 'PHYS 231N' }, { course: 'PHYS 261N' }] },
				{ course: 'MATH 212' },
				{ note: 'permission' }
			]
		};
		expect(coursesIn(e).sort()).toEqual(['MATH 212', 'PHYS 231N', 'PHYS 261N']);
	});
});

suite('describe', () => {
	it('renders nested logic with parentheses', () => {
		const e: Expr = {
			all_of: [
				{ one_of: [{ course: 'PHYS 232N' }, { course: 'PHYS 262N' }] },
				{ course: 'MATH 212', min_grade: 'C' }
			]
		};
		expect(describe(e)).toBe('(PHYS 232N or PHYS 262N) and MATH 212 (C or better)');
	});
});
