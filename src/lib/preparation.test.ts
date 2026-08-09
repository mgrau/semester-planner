import { describe, expect, it } from 'vitest';
import { catalog, preparationToRecords, startingPreparation } from '$lib/catalog';
import { generatePlan } from '$lib/engine/planner';
import { genEdProgress, satisfiedCategoriesFrom, takenFrom, totalCredits } from '$lib/engine/requirements';
import { DEFAULT_SETTINGS } from '$lib/stores/roster.svelte';

const astro = catalog.programs.get('physics-astrophysics-bs')!;

let counter = 0;
const newId = () => `id-${counter++}`;

const defaults = () => startingPreparation.filter((o) => o.default).map((o) => o.id);

describe('starting preparation', () => {
	it('offers the math ladder ODU actually has, highest first', () => {
		const math = startingPreparation
			.filter((o) => o.group === 'Mathematics already earned')
			.map((o) => o.id);
		expect(math).toEqual(['math-212', 'math-211', 'math-163', 'math-166', 'math-162m']);
		// There is no MATH 161 in the catalog; offering it would be a dead option.
		expect(catalog.courses.has('MATH 161')).toBe(false);
	});

	it('defaults to the typical incoming major', () => {
		expect(defaults().sort()).toEqual(
			['calculus-ready', 'hs-chemistry', 'language-requirement', 'writing-placement'].sort()
		);
	});

	it('treats calculus readiness as placement, not credit', () => {
		const { priorCredits, placements } = preparationToRecords(['calculus-ready'], newId);
		// Placement satisfies MATH 211's prerequisite without adding credit hours.
		expect(placements).toContain('MATH 163');
		expect(placements).toContain('MATH 166');
		expect(totalCredits(takenFrom(priorCredits, []))).toBe(0);
	});

	it('treats an earned math course as credit and places past what it supersedes', () => {
		const { priorCredits, placements } = preparationToRecords(['math-211'], newId);
		expect(takenFrom(priorCredits, [])).toEqual([{ code: 'MATH 211', credits: 4 }]);
		expect(placements).toContain('MATH 163');
	});

	it('records the Language and Culture waiver as a satisfied category', () => {
		const { priorCredits } = preparationToRecords(['language-requirement'], newId);
		expect([...satisfiedCategoriesFrom(priorCredits)]).toEqual(['language']);
		// A waiver is not credit earned.
		expect(totalCredits(takenFrom(priorCredits, []))).toBe(0);
	});
});

describe('a default new student', () => {
	const prep = preparationToRecords(defaults(), newId);

	it('needs no precalculus scheduled, because readiness was declared', () => {
		const result = generatePlan({
			program: astro,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: prep.priorCredits,
			placements: prep.placements
		});
		const codes = result.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(codes).not.toContain('MATH 163');
		expect(codes).not.toContain('MATH 162M');
		expect(codes).toContain('MATH 211');
	});

	it('starts with zero earned credits', () => {
		expect(totalCredits(takenFrom(prep.priorCredits, []))).toBe(0);
	});

	it('reserves no Language and Culture credits in the plan', () => {
		const result = generatePlan({
			program: astro,
			catalog,
			settings: { ...DEFAULT_SETTINGS },
			startTerm: 'fall',
			startYear: 2026,
			priorCredits: prep.priorCredits,
			placements: prep.placements
		});
		const categories = result.semesters
			.flatMap((s) => s.courses)
			.filter((c) => c.placeholder)
			.map((c) => c.placeholder!.category);
		expect(categories).not.toContain('language');
	});

	it('shows Language and Culture as satisfied in the gen-ed panel', () => {
		const progress = genEdProgress(
			catalog.genEd,
			[],
			catalog.courses,
			new Set([
				...satisfiedCategoriesFrom(prep.priorCredits),
				...astro.categoriesSatisfiedByMajor
			]),
			astro.courseDoubleCounts
		);
		expect(progress.find((p) => p.id === 'language')?.satisfied).toBe(true);
	});
});
