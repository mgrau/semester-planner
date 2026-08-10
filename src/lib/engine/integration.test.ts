import { describe, expect, it } from 'vitest';
import { catalog, programList } from '$lib/catalog';
import { generatePlan } from './planner';
import { validatePlan } from './validate';
import { describe as describeExpr } from './expr';
import { DEFAULT_SETTINGS } from '$lib/stores/roster.svelte';
import { genEdProgress, programProgress, satisfiedCategoriesFrom, takenFrom } from './requirements';
import type { Student } from '$lib/types';

/**
 * End-to-end against the real scraped ODU catalog. These assertions are about the plan being
 * *coherent* — no course before its prerequisite, no term over the cap — rather than matching
 * one exact schedule, so they stay meaningful when the catalog data is corrected.
 */

const astro = catalog.programs.get('physics-astrophysics-bs')!;

function planFor(programId: string, priorCredits: Student['priorCredits'] = []) {
	const program = catalog.programs.get(programId)!;
	return generatePlan({
		program,
		catalog,
		settings: { ...DEFAULT_SETTINGS },
		startTerm: 'fall',
		startYear: 2026,
		priorCredits
	});
}

describe('catalog data', () => {
	it('loaded courses, gen-ed categories, and programs', () => {
		expect(catalog.courses.size).toBeGreaterThan(5000);
		expect(catalog.genEd.length).toBeGreaterThanOrEqual(12);
		expect(programList.length).toBeGreaterThanOrEqual(5);
	});

	it('has the physics gateway courses with correct credits', () => {
		expect(catalog.courses.get('PHYS 231N')?.credits.min).toBe(4);
		expect(catalog.courses.get('MATH 211')?.credits.min).toBe(4);
		expect(catalog.courses.get('ENGL 110C')?.credits.min).toBe(3);
	});

	it('resolves cross-listed courses under either code', () => {
		expect(catalog.courses.get('PHYS 425')).toBeDefined();
	});

	it('folds the catalog gen-ed rows out of the major track', () => {
		// The astrophysics page restates all 12 gen-ed categories; those belong to the gen-ed
		// track, so the major requirement list must not contain them.
		expect(astro.requirements.some((r) => r.id.startsWith('gened-'))).toBe(false);
		expect(astro.requirements.length).toBeGreaterThan(0);
	});

	it('names the courses that cover Mathematics rather than waiving it outright', () => {
		// The page says "Mathematics: satisfied by the major" without naming a course. Applied
		// literally that marks it satisfied before the student has taken anything.
		expect(astro.categoriesSatisfiedByMajor).toEqual([]);
		expect(astro.courseDoubleCounts).toContainEqual({ course: 'MATH 211', satisfies: 'math' });
	});
});

describe('astrophysics plan', () => {
	const result = planFor('physics-astrophysics-bs');

	it('schedules the core physics sequence in order', () => {
		const idx = (code: string) =>
			result.semesters.findIndex((s) => s.courses.some((c) => c.code === code));
		expect(idx('MATH 211')).toBeGreaterThanOrEqual(0);
		expect(idx('MATH 211')).toBeLessThanOrEqual(idx('MATH 212'));

		const intro = ['PHYS 261N', 'PHYS 231N', 'PHYS 226N'].find((c) => idx(c) >= 0);
		expect(intro, 'an introductory physics course should be scheduled').toBeDefined();
	});

	it('produces a plan with no prerequisite violations', () => {
		const student: Student = {
			id: 't',
			name: 'Test',
			programId: 'physics-astrophysics-bs',
			catalogYear: catalog.catalogYear,
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: [],
			semesters: result.semesters,
			settings: { ...DEFAULT_SETTINGS },
			updatedAt: ''
		};
		const errors = validatePlan(student, catalog).filter((i) => i.kind === 'prereq-unmet');
		expect(errors.map((e) => e.message)).toEqual([]);
	});

	it('keeps every term at or under the credit cap', () => {
		for (const sem of result.semesters) {
			const credits = sem.courses.reduce((s, c) => s + c.credits, 0);
			expect(credits, `${sem.id} carries ${credits}`).toBeLessThanOrEqual(
				DEFAULT_SETTINGS.maxCreditsPerTerm
			);
		}
	});

	it('does not reserve gen-ed slots the major already covers', () => {
		const labels = result.semesters
			.flatMap((s) => s.courses)
			.filter((c) => c.placeholder)
			.map((c) => c.placeholder!.category);
		expect(labels).not.toContain('math');
		expect(labels).not.toContain('nature');
	});

	it('schedules the precalculus a student has not placed past', () => {
		const codes = result.semesters.flatMap((s) => s.courses.map((c) => c.code));
		// Nothing was declared for this student, so MATH 211's prerequisite is real work.
		expect(codes).toContain('MATH 163');
		expect(codes.indexOf('MATH 163')).toBeGreaterThanOrEqual(0);
	});

	it('omits precalculus once the student is declared ready for calculus', () => {
		const ready = generatePlan({
			program: astro,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: [],
			placements: ['MATH 163', 'MATH 166', 'MATH 162M']
		});
		const codes = ready.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(codes).not.toContain('MATH 163');
		expect(codes).not.toContain('MATH 162M');
	});

	it('reaches a credit total in the neighborhood of the degree', () => {
		const planned = result.semesters.flatMap((s) =>
			s.courses.map((c) => ({ code: c.code, credits: c.credits }))
		);
		const total = planned.reduce((s, c) => s + c.credits, 0);
		expect(total).toBeGreaterThan(90);
		expect(total).toBeLessThanOrEqual(140);
	});

	it('marks the major requirements satisfied once the plan is complete', () => {
		const planned = result.semesters.flatMap((s) =>
			s.courses.filter((c) => !c.placeholder).map((c) => ({ code: c.code, credits: c.credits }))
		);
		const taken = takenFrom([], planned);
		const progress = programProgress(astro, taken, catalog.courses);
		const unmet = progress.filter((p) => !p.satisfied);
		// Report which ones, so a failure is actionable rather than just a count.
		expect(unmet.map((u) => `${u.name}: missing ${u.missing.join(', ') || '(credits)'}`)).toEqual(
			[]
		);
	});
});

describe('departmental preferences', () => {
	const result = planFor('physics-astrophysics-bs');
	const codes = result.semesters.flatMap((s) => s.courses.map((c) => c.code));

	it('schedules the PHYS 489W/490W thesis sequence, not the PHYS 499W capstone', () => {
		expect(codes).toContain('PHYS 489W');
		expect(codes).toContain('PHYS 490W');
		expect(codes).not.toContain('PHYS 499W');
	});

	it('keeps the thesis sequence in order', () => {
		const idx = (code: string) =>
			result.semesters.findIndex((s) => s.courses.some((c) => c.code === code));
		expect(idx('PHYS 489W')).toBeLessThan(idx('PHYS 490W'));
	});

	it('satisfies Writing Intensive from the W attribute rather than reserving a slot', () => {
		const planned = result.semesters.flatMap((s) =>
			s.courses.filter((c) => !c.placeholder).map((c) => ({ code: c.code, credits: c.credits }))
		);
		const reserved = new Map<string, number>();
		for (const s of result.semesters) {
			for (const c of s.courses) {
				if (c.placeholder?.category)
					map(reserved, c.placeholder.category, c.credits);
			}
		}
		const progress = genEdProgress(
			catalog.genEd,
			takenFrom([], planned),
			catalog.courses,
			new Set(astro.categoriesSatisfiedByMajor),
			astro.courseDoubleCounts,
			reserved
		);
		const wi = progress.find((p) => p.id === 'upper-division-writing-intensive')!;
		expect(wi.satisfied).toBe(true);
		expect(wi.assigned).toContain('PHYS 489W');
		// and no redundant placeholder was booked for it
		expect(reserved.get('upper-division-writing-intensive')).toBeUndefined();
	});

	it('holds Senior Thesis to the senior year', () => {
		// The catalog asks only for ENGL 211C, so nothing but class standing keeps PHYS 489W out
		// of the sophomore year.
		const ready = generatePlan({
			program: astro,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: [],
			placements: ['MATH 163', 'MATH 166', 'MATH 162M']
		});
		const termIndex = (code: string) =>
			ready.semesters.findIndex((s) => s.courses.some((c) => c.code === code));
		expect(termIndex('PHYS 489W')).toBeGreaterThanOrEqual(6); // term 7, 0-indexed
		expect(termIndex('PHYS 490W')).toBeGreaterThan(termIndex('PHYS 489W'));
	});

	it('fits four years for a student ready for calculus', () => {
		// The default new student declares calculus readiness, which is the normal case.
		const ready = generatePlan({
			program: astro,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: [],
			placements: ['MATH 163', 'MATH 166', 'MATH 162M']
		});
		expect(ready.semesters.filter((s) => s.term !== 'summer').length).toBeLessThanOrEqual(8);
	});

	it('honestly runs longer when precalculus has to be scheduled', () => {
		// Not a defect: a student who is not calculus-ready has more to do, and the plan says so
		// instead of hiding the extra term.
		const fallSpring = result.semesters.filter((s) => s.term !== 'summer').length;
		expect(fallSpring).toBeGreaterThan(8);
		expect(result.notes.some((n) => n.includes('past the'))).toBe(true);
	});
});

function map(m: Map<string, number>, k: string, v: number) {
	m.set(k, (m.get(k) ?? 0) + v);
}

function studentWith(overrides: Partial<Student> = {}): Student {
	return {
		id: 't',
		name: 'Test',
		programId: 'physics-astrophysics-bs',
		catalogYear: catalog.catalogYear,
		startTerm: 'fall',
		startYear: 2026,
		priorCredits: [],
		semesters: [],
		settings: { ...DEFAULT_SETTINGS },
		updatedAt: '',
		...overrides
	};
}

describe('placement is not credit', () => {
	it('awards no credit for a declared placement', () => {
		const student = studentWith({ placements: ['MATH 163', 'MATH 162M'] });
		expect(takenFrom(student.priorCredits, [])).toEqual([]);
	});

	it('lets a declared placement satisfy the prerequisite', () => {
		const student = studentWith({
			placements: ['MATH 163', 'MATH 166'],
			semesters: [
				{ id: 'fall-2026', term: 'fall', year: 2026, courses: [{ code: 'MATH 211', credits: 4 }] }
			]
		});
		expect(validatePlan(student, catalog).filter((i) => i.kind === 'prereq-unmet')).toEqual([]);
	});
});

describe('the planner schedules prerequisites rather than assuming them', () => {
	it('puts a missing prerequisite in the plan, before the course that needs it', () => {
		const result = planFor('physics-astrophysics-bs');
		const idx = (code: string) =>
			result.semesters.findIndex((s) => s.courses.some((c) => c.code === code));
		expect(idx('MATH 163')).toBeGreaterThanOrEqual(0);
		expect(idx('MATH 163')).toBeLessThan(idx('MATH 211'));
	});

	it('produces a plan with no unmet prerequisites of its own making', () => {
		const result = planFor('physics-astrophysics-bs');
		const student = studentWith({ semesters: result.semesters });
		const errors = validatePlan(student, catalog).filter((i) => i.kind === 'prereq-unmet');
		expect(errors.map((e) => e.message)).toEqual([]);
	});

	it('stops chasing when a prerequisite is a placement score rather than a course', () => {
		// MATH 162M requires an SAT/ACT/placement result, so the chain ends there.
		const result = planFor('physics-astrophysics-bs');
		const codes = result.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(codes).not.toContain('MATH 102M');
		expect(codes).not.toContain('MATH 103M');
	});

	it('does not force a remedial course when the prose names a real alternative', () => {
		// CHEM 121N reads "MATH 102M or MATH 103M or higher" and "High school chemistry,
		// CHEM 103, or CHEM 105N". Neither remedial branch belongs in a physics plan.
		const result = planFor('physics-astrophysics-bs');
		const codes = result.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(codes).toContain('CHEM 121N');
		expect(codes).not.toContain('CHEM 103');
		expect(codes).not.toContain('CHEM 105N');
	});

	it('reports a genuine ordering mistake as an error', () => {
		const student = studentWith({
			semesters: [
				{ id: 'fall-2026', term: 'fall', year: 2026, courses: [{ code: 'PHYS 262N', credits: 4 }] }
			]
		});
		expect(
			validatePlan(student, catalog).filter((i) => i.kind === 'prereq-unmet').length
		).toBeGreaterThan(0);
	});
});

describe('auto-populate does not edit the student record', () => {
	it('returns only a schedule and its notes', () => {
		const result = planFor('physics-astrophysics-bs');
		expect(Object.keys(result).sort()).toEqual(['notes', 'semesters', 'unplaced']);
	});
});

describe('transfer credit shortens the plan', () => {
	it('drops courses the student brings in', () => {
		const withAp = planFor('physics-astrophysics-bs', [
			{ id: '1', kind: 'course', course: 'MATH 211', credits: 4, grade: 'A', source: 'AP' },
			{ id: '2', kind: 'course', course: 'MATH 212', credits: 4, grade: 'A', source: 'AP' },
			{ id: '3', kind: 'course', course: 'ENGL 110C', credits: 3, grade: 'A', source: 'DE' }
		]);
		const codes = withAp.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(codes).not.toContain('MATH 211');
		expect(codes).not.toContain('ENGL 110C');
	});

	it('honors a Language and Culture waiver recorded as prior credit', () => {
		const waived = planFor('physics-astrophysics-bs', [
			{ id: '1', kind: 'category', category: 'language', credits: 6, source: 'HS language' }
		]);
		const cats = waived.semesters
			.flatMap((s) => s.courses)
			.filter((c) => c.placeholder)
			.map((c) => c.placeholder!.category);
		expect(cats).not.toContain('language');
	});
});

describe('every program plans without crashing', () => {
	for (const program of programList) {
		it(`plans ${program.id}`, () => {
			const r = planFor(program.id);
			expect(r.semesters.length).toBeGreaterThan(0);
		});
	}
});

describe('gen-ed progress against real data', () => {
	it('counts a full plan toward gen-ed categories', () => {
		const result = planFor('physics-astrophysics-bs');
		const planned = result.semesters.flatMap((s) =>
			s.courses.filter((c) => !c.placeholder).map((c) => ({ code: c.code, credits: c.credits }))
		);
		const progress = genEdProgress(
			catalog.genEd,
			takenFrom([], planned),
			catalog.courses,
			new Set([...satisfiedCategoriesFrom([]), ...astro.categoriesSatisfiedByMajor]),
			astro.courseDoubleCounts
		);
		expect(progress.find((p) => p.id === 'math')?.satisfied).toBe(true);
		expect(progress.find((p) => p.id === 'nature')?.satisfied).toBe(true);
	});
});

describe('CHEM 121N parses to what the catalog actually says', () => {
	const chem = catalog.courses.get('CHEM 121N')!;

	it('is no longer flagged for manual review', () => {
		expect(chem.needs_review).toBeFalsy();
	});

	it('requires C or better in MATH 102M or 103M, or a higher math course', () => {
		const prereq = chem.prereq as { all_of: unknown[] };
		const math = prereq.all_of[0] as { one_of: { course?: string; note?: string }[] };
		expect(math.one_of.map((b) => b.course ?? b.note)).toEqual([
			'MATH 102M',
			'MATH 103M',
			'higher'
		]);
	});

	it('treats the chemistry background as advice, not a requirement', () => {
		// "High school chemistry, CHEM 103, or CHEM 105N strongly recommended" is a soft
		// requirement; parsing it into course leaves made CHEM 105N look mandatory.
		const prereq = chem.prereq as { all_of: { note?: string }[] };
		expect(prereq.all_of[1].note).toContain('recommended');
		expect(prereq.all_of[1].note).toContain('High school chemistry');
	});

	it('must be taken with the lab', () => {
		expect(describeExpr(chem.coreq)).toBe('CHEM 122N or CHEM 120');
	});

	it('leaves a default new student with no parse warnings at all', () => {
		const flagged = ['CHEM 121N', 'CHEM 122N', 'MATH 211', 'MATH 212', 'PHYS 261N'].filter(
			(c) => catalog.courses.get(c)?.needs_review
		);
		expect(flagged).toEqual([]);
	});
});
