import { describe, expect, it } from 'vitest';
import { generatePlan } from './planner';
import type {
	Catalog,
	Course,
	GenEdCategory,
	NormalizedProgram,
	PlannerSettings,
	Term
} from '$lib/types';

/**
 * A miniature physics curriculum with the same shape as the real one: a MATH gateway chain
 * feeding a PHYS chain, a choice requirement, and a fall-only course.
 */
function course(
	code: string,
	credits: number,
	opts: Partial<Course> = {}
): Course {
	const [subject, number] = code.split(' ');
	return {
		code,
		subject,
		number,
		title: code,
		credits: { min: credits, max: credits },
		...opts
	};
}

const COURSES: Course[] = [
	course('MATH 211', 4),
	course('MATH 212', 4, { prereq: { course: 'MATH 211', min_grade: 'C' } }),
	course('MATH 312', 4, { prereq: { course: 'MATH 212' } }),
	course('PHYS 261N', 4, {
		prereq: { course: 'MATH 211', min_grade: 'C' },
		precoreq: { course: 'MATH 212' }
	}),
	course('PHYS 262N', 4, {
		prereq: {
			all_of: [
				{ course: 'PHYS 261N', min_grade: 'C' },
				{ course: 'MATH 212', min_grade: 'C' }
			]
		}
	}),
	course('PHYS 319', 3, { prereq: { course: 'PHYS 262N' }, terms: ['spring'] }),
	course('PHYS 323', 3, { prereq: { course: 'PHYS 262N' }, terms: ['fall'] }),
	course('PHYS 355', 3, { prereq: { course: 'PHYS 262N' }, precoreq: { course: 'MATH 312' } }),
	course('ENGL 110C', 3),
	course('ARTH 121A', 3),
	course('HIST 100H', 3)
];

const GEN_ED: GenEdCategory[] = [
	{ id: 'written', name: 'Written Communication', credits: 3, approved: ['ENGL 110C'] },
	{ id: 'creativity', name: 'Human Creativity', credits: 3, approved: ['ARTH 121A'] },
	{ id: 'interpret', name: 'Interpreting the Past', credits: 3, approved: ['HIST 100H'] },
	{ id: 'math', name: 'Mathematics', credits: 3, approved: ['MATH 102M'] }
];

const catalog: Catalog = {
	courses: new Map(COURSES.map((c) => [c.code, c])),
	genEd: GEN_ED,
	programs: new Map(),
	catalogYear: 'test'
};

const program: NormalizedProgram = {
	id: 'test-physics',
	name: 'Test Physics',
	degree: 'BS',
	department: 'Physics',
	total_credits: 60,
	requirements: [
		{
			id: 'core',
			name: 'Core',
			all_of: ['PHYS 261N', 'PHYS 262N', 'PHYS 355', 'MATH 211', 'MATH 212', 'MATH 312']
		},
		{ id: 'elective', name: 'Upper elective', one_of: ['PHYS 319', 'PHYS 323'], credits: 3 }
	],
	// The catalog says the major covers the Mathematics gen-ed category outright.
	categoriesSatisfiedByMajor: ['math'],
	courseDoubleCounts: [],
	untrackable: [],
	plan_of_study: []
};

const settings: PlannerSettings = {
	maxCreditsPerTerm: 16,
	minCreditsPerTerm: 12,
	includeSummers: false,
	summerMaxCredits: 7,
	targetYears: 4
};

const base = {
	program,
	catalog,
	settings,
	startTerm: 'fall' as const,
	startYear: 2026,
	priorCredits: []
};

function termOf(result: ReturnType<typeof generatePlan>, code: string): string | undefined {
	return result.semesters.find((s) => s.courses.some((c) => c.code === code))?.id;
}

function indexOf(result: ReturnType<typeof generatePlan>, code: string): number {
	return result.semesters.findIndex((s) => s.courses.some((c) => c.code === code));
}

describe('generatePlan', () => {
	it('places every required course', () => {
		const r = generatePlan(base);
		for (const code of ['MATH 211', 'MATH 212', 'MATH 312', 'PHYS 261N', 'PHYS 262N', 'PHYS 355']) {
			expect(termOf(r, code), `${code} should be scheduled`).toBeDefined();
		}
		expect(r.unplaced.filter((u) => u.code.startsWith('PHYS') || u.code.startsWith('MATH'))).toEqual(
			[]
		);
	});

	it('starts the math gateway before physics, without special-casing it', () => {
		const r = generatePlan(base);
		expect(indexOf(r, 'MATH 211')).toBeLessThanOrEqual(indexOf(r, 'PHYS 261N'));
		expect(indexOf(r, 'PHYS 261N')).toBeLessThan(indexOf(r, 'PHYS 262N'));
	});

	it('never places a course before its prerequisite', () => {
		const r = generatePlan(base);
		expect(indexOf(r, 'MATH 211')).toBeLessThan(indexOf(r, 'MATH 212'));
		expect(indexOf(r, 'MATH 212')).toBeLessThan(indexOf(r, 'MATH 312'));
		expect(indexOf(r, 'PHYS 262N')).toBeLessThan(indexOf(r, 'PHYS 355'));
	});

	it('allows a pre-or-corequisite in the same term', () => {
		const r = generatePlan(base);
		// PHYS 261N has MATH 212 as a pre-or-coreq, so same term is legal.
		expect(indexOf(r, 'MATH 212')).toBeLessThanOrEqual(indexOf(r, 'PHYS 261N'));
	});

	it('respects term-restricted offerings', () => {
		const r = generatePlan(base);
		const spring = termOf(r, 'PHYS 319');
		if (spring) expect(spring).toContain('spring');
		const fall = termOf(r, 'PHYS 323');
		if (fall) expect(fall).toContain('fall');
	});

	it('honors the credit cap in every term', () => {
		const r = generatePlan(base);
		for (const sem of r.semesters) {
			const credits = sem.courses.reduce((s, c) => s + c.credits, 0);
			expect(credits, `${sem.id} over cap`).toBeLessThanOrEqual(settings.maxCreditsPerTerm);
		}
	});

	it('skips courses the student already transferred in', () => {
		const r = generatePlan({
			...base,
			priorCredits: [
				{ id: '1', kind: 'course', course: 'MATH 211', credits: 4, grade: 'A', source: 'AP' },
				{ id: '2', kind: 'course', course: 'MATH 212', credits: 4, grade: 'B', source: 'AP' }
			]
		});
		expect(termOf(r, 'MATH 211')).toBeUndefined();
		expect(termOf(r, 'MATH 212')).toBeUndefined();
		// and physics can now start immediately
		expect(indexOf(r, 'PHYS 261N')).toBe(0);
	});

	it('emits placeholders for open gen-ed categories rather than guessing a course', () => {
		const r = generatePlan(base);
		const placeholders = r.semesters.flatMap((s) => s.courses.filter((c) => c.placeholder));
		expect(placeholders.length).toBeGreaterThan(0);
		const labels = placeholders.map((p) => p.placeholder!.label);
		expect(labels).toContain('Human Creativity');
		// The major covers Mathematics, so no Mathematics slot should be reserved.
		expect(labels).not.toContain('Mathematics');
	});

	it('leaves advisor-locked courses where they were put', () => {
		const locked = [
			{
				id: 'fall-2026',
				term: 'fall' as const,
				year: 2026,
				courses: [{ code: 'ENGL 110C', credits: 3, locked: true }]
			}
		];
		const r = generatePlan({ ...base, locked });
		const sem = r.semesters.find((s) => s.id === 'fall-2026');
		expect(sem?.courses.some((c) => c.code === 'ENGL 110C' && c.locked)).toBe(true);
	});

	it('picks one alternative from a choice requirement, not all of them', () => {
		const r = generatePlan(base);
		const placed = ['PHYS 319', 'PHYS 323'].filter((c) => termOf(r, c));
		expect(placed.length).toBe(1);
	});
});

describe('faults found by students testing real plans', () => {
	const astroLike: NormalizedProgram = {
		...program,
		id: 'test-astro',
		requirements: [{ id: 'core', name: 'Core', all_of: ['MATH 211'] }]
	};

	/** Language and Culture is 6 credits — two courses, not one of 4 and one of 3. */
	const sixCreditCategory: GenEdCategory[] = [
		{ id: 'language', name: 'Language and Culture', credits: 6, approved: ['SPAN 111F'] },
		{ id: 'nature', name: 'The Nature of Science', credits: 8, approved: ['PHYS 261N'] }
	];

	const planWith = (genEd: GenEdCategory[]) =>
		generatePlan({
			program: astroLike,
			catalog: { ...catalog, genEd },
			settings,
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: []
		});

	it('gives every placeholder a distinct code', () => {
		// Two slots of one category can land in the same term. They used to share a code, which
		// is a duplicate key in a keyed {#each} — a hard render error that froze the whole plan
		// column, so Clear and Auto-populate appeared to do nothing.
		const r = planWith(sixCreditCategory);
		const codes = r.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(new Set(codes).size, 'placeholder codes must be unique').toBe(codes.length);
	});

	it('reserves exactly the credits a category asks for', () => {
		const r = planWith(sixCreditCategory);
		const byCategory = new Map<string, number>();
		for (const sem of r.semesters) {
			for (const c of sem.courses) {
				if (!c.placeholder?.category) continue;
				byCategory.set(
					c.placeholder.category,
					(byCategory.get(c.placeholder.category) ?? 0) + c.credits
				);
			}
		}
		// 6 came out as 4 + 3 = 7 before, over-reserving a credit.
		expect(byCategory.get('language')).toBe(6);
		expect(byCategory.get('nature')).toBe(8);
	});
});

describe('the terms available to the plan', () => {
	const terms = (ids: [Term, number][]) =>
		ids.map(([term, year]) => ({ id: `${term}-${year}`, term, year }));

	it('fills only the terms it was given, and adds none', () => {
		// Auto-populate works inside the schedule the advisor has laid out; growing a summer term
		// on its own would undo a decision they made deliberately.
		const availableTerms = terms([
			['fall', 2026],
			['spring', 2027],
			['fall', 2027],
			['spring', 2028]
		]);
		const r = generatePlan({ ...base, availableTerms });
		expect(r.semesters.map((s) => s.id)).toEqual(availableTerms.map((t) => t.id));
		expect(r.semesters.some((s) => s.term === 'summer')).toBe(false);
	});

	it('fills a summer the advisor did add', () => {
		const availableTerms = terms([
			['fall', 2026],
			['spring', 2027],
			['summer', 2027]
		]);
		const r = generatePlan({ ...base, availableTerms });
		expect(r.semesters.map((s) => s.id)).toEqual(availableTerms.map((t) => t.id));
	});

	it('reports what did not fit rather than making room for it', () => {
		const r = generatePlan({ ...base, availableTerms: terms([['fall', 2026]]) });
		expect(r.semesters).toHaveLength(1);
		expect(r.unplaced.length).toBeGreaterThan(0);
	});

	it('keeps a locked course in a term the planner never reached', () => {
		const availableTerms = terms([
			['fall', 2026],
			['spring', 2027],
			['fall', 2027],
			['spring', 2028],
			['fall', 2028],
			['spring', 2029]
		]);
		const locked = [
			{
				id: 'spring-2029',
				term: 'spring' as const,
				year: 2029,
				courses: [{ code: 'ENGL 110C', credits: 3, locked: true }]
			}
		];
		const r = generatePlan({ ...base, availableTerms, locked });
		const last = r.semesters.find((s) => s.id === 'spring-2029');
		expect(last?.courses.map((c) => c.code)).toContain('ENGL 110C');
	});

	it('lays out its own terms when none are given', () => {
		const r = generatePlan(base);
		expect(r.semesters.length).toBeGreaterThan(1);
	});
});
