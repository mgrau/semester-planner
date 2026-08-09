import { describe, expect, it } from 'vitest';
import { catalog, majorView, programLabel } from '$lib/catalog';
import { majorViewProgress } from './majorView';
import { generatePlan } from './planner';
import { reservedByCategory, reservedCredits, takenFrom, totalCredits } from './requirements';
import { DEFAULT_SETTINGS } from '$lib/stores/roster.svelte';

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
		expect(named + held).toBeLessThanOrEqual(program.total_credits + 6);
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
