import { describe, expect, it } from 'vitest';
import { catalog, majorView, programLabel } from '$lib/catalog';
import { majorViewProgress } from './majorView';
import { generatePlan } from './planner';
import { reservedByCategory, reservedCredits, takenFrom, totalCredits } from './requirements';
import { DEFAULT_SETTINGS } from '$lib/stores/roster.svelte';
import { validatePlan } from './validate';
import { describe as describeExpr } from './expr';
import type { Student } from '$lib/types';

const astro = catalog.programs.get('physics-astrophysics-bs')!;

function fullPlanTaken(programId: string) {
	const program = catalog.programs.get(programId)!;
	const r = generatePlan({
		program,
		catalog,
		settings: { ...DEFAULT_SETTINGS },
		startTerm: 'fall',
		startYear: 2026,
		priorCredits: []
	});
	return takenFrom(
		[],
		r.semesters.flatMap((s) =>
			s.courses.filter((c) => !c.placeholder).map((c) => ({ code: c.code, credits: c.credits }))
		)
	);
}

describe('major requirement view', () => {
	const progress = majorViewProgress(astro, fullPlanTaken('physics-astrophysics-bs'), catalog, majorView);
	const byId = (id: string) => progress.find((p) => p.id === id);

	it('leads with Physics 1 & 2 satisfied by the preferred sequence', () => {
		const intro = byId('intro-physics')!;
		expect(intro.name).toBe('Physics 1 & 2');
		expect(intro.assigned).toEqual(['PHYS 261N', 'PHYS 262N']);
		expect(intro.satisfied).toBe(true);
	});

	it('accepts an alternative intro sequence a transfer student brings', () => {
		const p = majorViewProgress(
			astro,
			[
				{ code: 'PHYS 231N', credits: 4 },
				{ code: 'PHYS 232N', credits: 4 }
			],
			catalog,
			majorView
		);
		expect(p.find((x) => x.id === 'intro-physics')?.satisfied).toBe(true);
	});

	it('groups the 300- and 400-level physics courses', () => {
		expect(byId('physics-300')?.assigned).toContain('PHYS 303');
		expect(byId('physics-300')?.assigned).toContain('PHYS 355');
		expect(byId('physics-400')?.assigned).toContain('PHYS 425');
	});

	it('never lists an unchosen alternative as missing', () => {
		// PHYS 499W is the road not taken; it must not appear as an outstanding 400-level course.
		expect(byId('physics-400')?.missing ?? []).not.toContain('PHYS 499W');
		for (const p of progress) {
			expect(p.missing, `${p.name} reports missing courses`).toEqual([]);
		}
	});

	it('leaves choice requirements intact under their own section', () => {
		const electives = byId('astrophysics-select-3');
		expect(electives?.satisfied).toBe(true);
		expect(electives?.section).toBe('Other requirements');
	});

	it('loses no required course when regrouping', () => {
		const inView = new Set(progress.flatMap((p) => p.assigned));
		const required = new Set(astro.requirements.flatMap((r) => r.all_of ?? []));
		for (const code of required) {
			expect(inView.has(code), `${code} disappeared from the requirement view`).toBe(true);
		}
	});

	it('reports every group satisfied for a complete plan', () => {
		const unmet = progress.filter((p) => !p.satisfied).map((p) => p.name);
		expect(unmet).toEqual([]);
	});

	it('falls back to the catalog grouping for a program the view does not cover', () => {
		const minor = catalog.programs.get('physics-minor');
		if (!minor) return;
		const p = majorViewProgress(minor, [], catalog, majorView);
		expect(p.every((x) => x.id !== 'intro-physics')).toBe(true);
	});
});

describe('requirement labels', () => {
	const progress = majorViewProgress(
		astro,
		fullPlanTaken('physics-astrophysics-bs'),
		catalog,
		majorView
	);
	const names = progress.map((p) => p.name);

	it('replaces the catalog row labels with advisor-facing names', () => {
		expect(names).toContain('Senior Thesis');
		expect(names).toContain('Seminar');
		expect(names).toContain('Electives');
	});

	it('drops the meaningless "Select two of the following" heading', () => {
		expect(names).not.toContain('Select two of the following:');
	});

	it('applies shared labels across the other physics programs', () => {
		for (const id of ['physics-bs', 'physics-professional-bs']) {
			const p = catalog.programs.get(id);
			if (!p) continue;
			const n = majorViewProgress(p, fullPlanTaken(id), catalog, majorView).map((x) => x.name);
			expect(n, `${id} senior thesis`).toContain('Senior Thesis');
			expect(n, `${id} electives`).toContain('Electives');
		}
	});
});

describe('credit accounting', () => {
	it('counts reserved placeholder credits toward the plan total', () => {
		const program = catalog.programs.get('physics-astrophysics-bs')!;
		const r = generatePlan({
			program,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: []
		});
		const named = totalCredits(
			takenFrom(
				[],
				r.semesters.flatMap((s) =>
					s.courses.filter((c) => !c.placeholder).map((c) => ({ code: c.code, credits: c.credits }))
				)
			)
		);
		const held = reservedCredits(r.semesters);

		// Unchosen gen-ed slots are real allocated credits; the headline must include them.
		expect(held).toBeGreaterThan(0);
		expect(named + held).toBeGreaterThan(named);
		expect(named + held).toBeLessThanOrEqual(program.total_credits + 10);
	});

	it('attributes reserved credits to the right gen-ed category', () => {
		const semesters = [
			{
				id: 'fall-2026',
				term: 'fall' as const,
				year: 2026,
				courses: [
					{
						code: 'placeholder:creativity:0',
						placeholder: { label: 'Human Creativity', category: 'creativity' },
						credits: 3
					},
					{ code: 'MATH 211', credits: 4 }
				]
			}
		];
		expect(reservedByCategory(semesters).get('creativity')).toBe(3);
		expect(reservedCredits(semesters)).toBe(3);
	});
});

describe('programLabel', () => {
	it('gives short advisor-facing names instead of the catalog title', () => {
		expect(programLabel('physics-astrophysics-bs')).toBe('Astrophysics');
		expect(programLabel('physics-bs')).toBe('Physics');
	});

	it('does not surface the degree letters as the distinguishing label', () => {
		expect(programLabel('physics-astrophysics-bs')).not.toMatch(/\bBS\b/);
	});
});

describe('term availability', () => {
	it('honours hand-recorded offerings the catalog omits', () => {
		// The catalog names a term for only 10 of 126 PHYS/ASTP courses; the rest come from
		// data/local/preferences.yaml, confirmed by the department.
		for (const code of ['PHYS 303', 'PHYS 323', 'PHYS 355', 'PHYS 420', 'PHYS 425', 'PHYS 452']) {
			expect(catalog.courses.get(code)?.terms, `${code} should be fall-only`).toEqual(['fall']);
		}
		for (const code of ['PHYS 309', 'PHYS 319', 'PHYS 413', 'PHYS 453', 'PHYS 454', 'PHYS 456']) {
			expect(catalog.courses.get(code)?.terms, `${code} should be spring-only`).toEqual(['spring']);
		}
		expect(catalog.courses.get('ASTP 414')?.terms).toEqual(['fall']);
		expect(catalog.courses.get('ASTP 313')?.terms).toEqual(['spring']);
	});

	it('leaves the every-semester and sporadic courses unconstrained', () => {
		// Asserting a term for these would be inventing data: the intro sequences run every
		// semester, and the upper-division electives run sporadically.
		for (const code of [
			'PHYS 261N',
			'PHYS 262N',
			'PHYS 411',
			'PHYS 415',
			'PHYS 416',
			'PHYS 417',
			'PHYS 489W',
			'PHYS 490W',
			'ASTP 103N',
			'ASTP 104N',
			'ASTP 495'
		]) {
			expect(catalog.courses.get(code)?.terms, `${code} should have no fixed term`).toBeUndefined();
		}
	});

	it('keeps what the catalog does state', () => {
		expect(catalog.courses.get('PHYS 323')?.terms).toEqual(['fall']);
		expect(catalog.courses.get('PHYS 319')?.terms).toEqual(['spring']);
	});

	it('never schedules a course outside the terms it is taught', () => {
		const result = generatePlan({
			program: astro,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: [],
			placements: ['MATH 163', 'MATH 166', 'MATH 162M']
		});
		for (const sem of result.semesters) {
			for (const c of sem.courses) {
				const terms = catalog.courses.get(c.code)?.terms;
				if (!terms) continue;
				expect(terms, `${c.code} placed in ${sem.term}`).toContain(sem.term);
			}
		}
	});
});

describe('discontinued courses', () => {
	it('marks PHYS 120 as no longer offered but keeps it nameable', () => {
		// A returning student may hold credit for it, so it stays in the catalog.
		const phys120 = catalog.courses.get('PHYS 120');
		expect(phys120).toBeDefined();
		expect(phys120?.discontinued).toBe(true);
	});

	it('picks the surviving option for a requirement that lists it', () => {
		// The Seminar requirement is "PHYS 120 or PHYS 309"; only PHYS 309 still runs.
		const result = generatePlan({
			program: astro,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: [],
			placements: ['MATH 163', 'MATH 166', 'MATH 162M']
		});
		const codes = result.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(codes).not.toContain('PHYS 120');
		expect(codes).toContain('PHYS 309');
	});

	it('warns when a discontinued course is already sitting in a plan', () => {
		const student = studentWith({
			semesters: [
				{ id: 'fall-2026', term: 'fall', year: 2026, courses: [{ code: 'PHYS 120', credits: 1 }] }
			]
		});
		const warnings = validatePlan(student, catalog).filter((i) =>
			i.message.includes('no longer offered')
		);
		expect(warnings.length).toBe(1);
	});
});

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

describe('lecture and lab pairs', () => {
	it('makes CHEM 123N and CHEM 124N mutual corequisites', () => {
		// The catalog links them only loosely: 123N has no corequisite, and 124N lists 123N as a
		// pre-*or*-corequisite, which would permit taking the lab a term later.
		expect(describeExpr(catalog.courses.get('CHEM 123N')?.coreq)).toBe('CHEM 124N');
		expect(describeExpr(catalog.courses.get('CHEM 124N')?.coreq)).toBe('CHEM 123N');
	});

	it('keeps the catalog corequisite the first pair already has', () => {
		expect(describeExpr(catalog.courses.get('CHEM 121N')?.coreq)).toContain('CHEM 122N');
	});

	it('schedules each pair in one term', () => {
		const physics = catalog.programs.get('physics-bs')!;
		const r = generatePlan({
			program: physics,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: [],
			placements: ['MATH 163', 'MATH 166', 'MATH 162M']
		});
		const termOf = (code: string) => r.semesters.find((s) => s.courses.some((c) => c.code === code))?.id;
		expect(termOf('CHEM 121N')).toBe(termOf('CHEM 122N'));
		expect(termOf('CHEM 123N')).toBe(termOf('CHEM 124N'));
		expect(termOf('CHEM 123N')).toBeDefined();
	});

	it('flags a plan that splits a pair across terms', () => {
		const student = studentWith({
			programId: 'physics-bs',
			placements: ['MATH 163'],
			semesters: [
				{
					id: 'fall-2026',
					term: 'fall',
					year: 2026,
					courses: [
						{ code: 'CHEM 121N', credits: 3 },
						{ code: 'CHEM 122N', credits: 1 }
					]
				},
				{ id: 'spring-2027', term: 'spring', year: 2027, courses: [{ code: 'CHEM 123N', credits: 3 }] },
				{ id: 'fall-2027', term: 'fall', year: 2027, courses: [{ code: 'CHEM 124N', credits: 1 }] }
			]
		});
		const errors = validatePlan(student, catalog).filter((i) => i.kind === 'coreq-unmet');
		expect(errors.map((e) => e.message)).toContain('CHEM 123N must be taken with CHEM 124N.');
	});
});
