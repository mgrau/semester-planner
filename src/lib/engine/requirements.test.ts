import { describe, expect, it } from 'vitest';
import { genEdProgress, programProgress, takenFrom, satisfiedCategoriesFrom } from './requirements';
import type { Course, GenEdCategory, NormalizedProgram } from '$lib/types';

function course(code: string, credits: number): Course {
	const [subject, number] = code.split(' ');
	return { code, subject, number, title: code, credits: { min: credits, max: credits } };
}

const courses = new Map(
	[
		course('MATH 211', 4),
		course('PHYS 231N', 4),
		course('PHYS 232N', 4),
		course('ENGL 110C', 3),
		course('ARTH 121A', 3),
		course('MUSC 264A', 3),
		course('PHIL 150P', 3)
	].map((c) => [c.code, c])
);

const genEd: GenEdCategory[] = [
	{ id: 'written', name: 'Written Communication', credits: 3, approved: ['ENGL 110C'] },
	{ id: 'creativity', name: 'Human Creativity', credits: 3, approved: ['ARTH 121A', 'MUSC 264A'] },
	{ id: 'philosophy', name: 'Philosophy and Ethics', credits: 3, approved: ['PHIL 150P'] },
	{ id: 'nature', name: 'The Nature of Science', credits: 8, approved: ['PHYS 231N', 'PHYS 232N'] }
];

const program: NormalizedProgram = {
	id: 'p',
	name: 'P',
	degree: 'BS',
	department: 'Physics',
	total_credits: 120,
	requirements: [{ id: 'core', name: 'Core', all_of: ['MATH 211', 'PHYS 231N', 'PHYS 232N'] }],
	categoriesSatisfiedByMajor: [],
	courseDoubleCounts: [],
	untrackable: []
};

const taken = (codes: string[]) =>
	codes.map((c) => ({ code: c, credits: courses.get(c)!.credits.min }));

describe('double counting across tracks', () => {
	it('lets one course count for both the major and a gen-ed category', () => {
		const t = taken(['PHYS 231N', 'PHYS 232N', 'MATH 211']);

		const major = programProgress(program, t, courses);
		expect(major.find((m) => m.id === 'core')?.satisfied).toBe(true);

		const gened = genEdProgress(genEd, t, courses, new Set(), []);
		const nature = gened.find((g) => g.id === 'nature')!;
		// The same PHYS courses satisfy the 8-credit Nature of Science requirement.
		expect(nature.earnedCredits).toBe(8);
		expect(nature.satisfied).toBe(true);
	});

	it('does not let one course satisfy two gen-ed categories at once', () => {
		// ARTH 121A is approved only for creativity here; add a course approved for two.
		const twoWay: GenEdCategory[] = [
			{ id: 'a', name: 'A', credits: 3, approved: ['ARTH 121A'] },
			{ id: 'b', name: 'B', credits: 3, approved: ['ARTH 121A'] }
		];
		const gened = genEdProgress(twoWay, taken(['ARTH 121A']), courses, new Set(), []);
		const satisfiedCount = gened.filter((g) => g.satisfied).length;
		expect(satisfiedCount).toBe(1);
	});

	it('admits a catalog-stated course double count into the category pool', () => {
		// ENMA 480 is not on the philosophy approved list, but the EE program says it counts.
		const withEnma = new Map(courses);
		withEnma.set('ENMA 480', course('ENMA 480', 3));
		const gened = genEdProgress(
			genEd,
			[{ code: 'ENMA 480', credits: 3 }],
			withEnma,
			new Set(),
			[{ course: 'ENMA 480', satisfies: 'philosophy' }]
		);
		expect(gened.find((g) => g.id === 'philosophy')?.satisfied).toBe(true);
	});

	it('marks a category satisfied outright by prior credit, e.g. a language waiver', () => {
		const gened = genEdProgress(genEd, [], courses, new Set(['creativity']), []);
		expect(gened.find((g) => g.id === 'creativity')?.satisfied).toBe(true);
	});

	it('reports partial progress toward a multi-course category', () => {
		const gened = genEdProgress(genEd, taken(['PHYS 231N']), courses, new Set(), []);
		const nature = gened.find((g) => g.id === 'nature')!;
		expect(nature.earnedCredits).toBe(4);
		expect(nature.satisfied).toBe(false);
	});

	it('lists the specific courses a major requirement is still missing', () => {
		const major = programProgress(program, taken(['MATH 211']), courses);
		expect(major.find((m) => m.id === 'core')?.missing.sort()).toEqual(['PHYS 231N', 'PHYS 232N']);
	});
});

describe('placeholder credits', () => {
	it('counts reserved credits toward a category and marks it satisfied', () => {
		const gened = genEdProgress(
			genEd,
			[],
			courses,
			new Set(),
			[],
			new Map([['creativity', 3]])
		);
		const creativity = gened.find((g) => g.id === 'creativity')!;
		expect(creativity.plannedCredits).toBe(3);
		expect(creativity.satisfied).toBe(true);
		// but it is reserved, not earned — the distinction has to survive
		expect(creativity.earnedCredits).toBe(0);
	});

	it('only counts the shortfall, so a leftover slot cannot exceed the requirement', () => {
		const gened = genEdProgress(
			genEd,
			taken(['PHYS 231N', 'PHYS 232N']),
			courses,
			new Set(),
			[],
			new Map([['nature', 6]])
		);
		const nature = gened.find((g) => g.id === 'nature')!;
		expect(nature.earnedCredits).toBe(8);
		expect(nature.plannedCredits).toBe(0);
	});

	it('reports partial reservation as still unsatisfied', () => {
		const gened = genEdProgress(genEd, [], courses, new Set(), [], new Map([['nature', 4]]));
		const nature = gened.find((g) => g.id === 'nature')!;
		expect(nature.plannedCredits).toBe(4);
		expect(nature.satisfied).toBe(false);
	});
});

describe('pool options with sequences', () => {
	it('accepts either a single course or a two-course sequence', () => {
		const withThesis = new Map(courses);
		withThesis.set('PHYS 499W', course('PHYS 499W', 3));
		withThesis.set('PHYS 489W', course('PHYS 489W', 1));
		withThesis.set('PHYS 490W', course('PHYS 490W', 2));

		const prog: NormalizedProgram = {
			...program,
			requirements: [
				{
					id: 'thesis',
					name: 'Senior thesis',
					one_of: ['PHYS 499W', { all_of: ['PHYS 489W', 'PHYS 490W'] }],
					credits: 3
				}
			]
		};

		const viaCapstone = programProgress(
			prog,
			[{ code: 'PHYS 499W', credits: 3 }],
			withThesis
		);
		expect(viaCapstone.find((p) => p.id === 'thesis')?.satisfied).toBe(true);

		const viaSequence = programProgress(
			prog,
			[
				{ code: 'PHYS 489W', credits: 1 },
				{ code: 'PHYS 490W', credits: 2 }
			],
			withThesis
		);
		expect(viaSequence.find((p) => p.id === 'thesis')?.satisfied).toBe(true);

		// Half the sequence is not enough.
		const halfway = programProgress(prog, [{ code: 'PHYS 489W', credits: 1 }], withThesis);
		expect(halfway.find((p) => p.id === 'thesis')?.satisfied).toBe(false);
	});
});

describe('rule-based categories', () => {
	it('satisfies a Writing Intensive category from the W attribute, not a list', () => {
		const withW = new Map(courses);
		withW.set('PHYS 490W', {
			...course('PHYS 490W', 3),
			attributes: ['W']
		});
		const cats: GenEdCategory[] = [
			{
				id: 'wi',
				name: 'Writing Intensive',
				credits: 3,
				approved: [],
				filter: { attributes: ['W'] }
			}
		];
		const gened = genEdProgress(cats, [{ code: 'PHYS 490W', credits: 3 }], withW);
		expect(gened[0].satisfied).toBe(true);
		expect(gened[0].assigned).toContain('PHYS 490W');
	});

	it('does not let a non-W course satisfy it', () => {
		const cats: GenEdCategory[] = [
			{ id: 'wi', name: 'Writing Intensive', credits: 3, approved: [], filter: { attributes: ['W'] } }
		];
		const gened = genEdProgress(cats, taken(['ARTH 121A']), courses);
		expect(gened[0].satisfied).toBe(false);
	});
});

describe('takenFrom', () => {
	it('merges prior credit with planned courses and de-duplicates', () => {
		const t = takenFrom(
			[{ id: '1', kind: 'course', course: 'MATH 211', credits: 4 }],
			[
				{ code: 'MATH 211', credits: 4 },
				{ code: 'PHYS 231N', credits: 4 }
			]
		);
		expect(t.map((x) => x.code).sort()).toEqual(['MATH 211', 'PHYS 231N']);
	});

	it('ignores category-kind prior credit, which grants no course', () => {
		const t = takenFrom([{ id: '1', kind: 'category', category: 'language', credits: 6 }], []);
		expect(t).toEqual([]);
	});
});

describe('satisfiedCategoriesFrom', () => {
	it('collects category waivers', () => {
		const s = satisfiedCategoriesFrom([
			{ id: '1', kind: 'category', category: 'language', credits: 6 },
			{ id: '2', kind: 'course', course: 'MATH 211', credits: 4 }
		]);
		expect([...s]).toEqual(['language']);
	});
});
