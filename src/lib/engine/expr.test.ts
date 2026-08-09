import { describe as suite, expect, it } from 'vitest';
import { coursesIn, describe, evaluate, minimalAdditions, type CreditState } from './expr';
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

suite('instructor permission is not a free pass', () => {
	// PHYS 456: "PHYS 323 and PHYS 452 or permission of the instructor". Reading the permission
	// branch as satisfying the clause erases the requirement, and the planner scheduled PHYS 456
	// before PHYS 452.
	const phys456: Expr = {
		one_of: [
			{ all_of: [{ course: 'PHYS 323' }, { course: 'PHYS 452' }] },
			{ note: 'permission of the instructor' }
		]
	};

	it('still requires the courses when permission is the only alternative', () => {
		const r = evaluate(phys456, state([]));
		expect(r.satisfied).toBe(false);
		expect(r.missing.sort()).toEqual(['PHYS 323', 'PHYS 452']);
	});

	it('is satisfied once the courses are done', () => {
		expect(evaluate(phys456, state(['PHYS 323', 'PHYS 452'])).satisfied).toBe(true);
	});

	it('is not satisfied by half the conjunction', () => {
		expect(evaluate(phys456, state(['PHYS 323'])).satisfied).toBe(false);
	});

	it('still surfaces the override as a note the advisor can act on', () => {
		expect(evaluate(phys456, state([])).notes).toContain('permission of the instructor');
	});

	it('leaves a permission-only prerequisite satisfied, since nothing is checkable', () => {
		expect(evaluate({ note: 'Permission of the instructor' }, state([])).satisfied).toBe(true);
	});

	it('treats a placement score as a genuine alternative, not an override', () => {
		// MATH 162M: "qualifying score on SAT ... or a grade of C or better in MATH 102M".
		// Discounting the score would force precalculus-for-precalculus into every plan.
		const math162m: Expr = {
			one_of: [
				{ placement: 'qualifying score on SAT' },
				{ course: 'MATH 102M', min_grade: 'C' }
			]
		};
		expect(evaluate(math162m, state([])).satisfied).toBe(true);
	});

	it('treats non-permission prose as a genuine alternative', () => {
		// CHEM 121N: "High school chemistry, CHEM 103, or CHEM 105N".
		const chem: Expr = {
			one_of: [{ note: 'High school chemistry' }, { course: 'CHEM 103' }]
		};
		expect(evaluate(chem, state([])).satisfied).toBe(true);
	});

	it('does not pick the override branch as the cheapest way to satisfy a clause', () => {
		expect(minimalAdditions(phys456, state([])).sort()).toEqual(['PHYS 323', 'PHYS 452']);
	});
});
