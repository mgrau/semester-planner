import { describe, expect, it } from 'vitest';
import { validatePlan } from './validate';
import { catalog } from '$lib/catalog';
import { DEFAULT_SETTINGS } from '$lib/stores/roster.svelte';
import type { PlannedCourse, Student } from '$lib/types';

describe('coursework the registrar has already reported', () => {
	const student = (courses: PlannedCourse[]): Student => ({
		id: 't',
		name: 'Test',
		programId: 'physics-astrophysics-bs',
		catalogYear: catalog.catalogYear,
		startTerm: 'fall',
		startYear: 2024,
		priorCredits: [],
		semesters: [{ id: 'fall-2024', term: 'fall', year: 2024, courses }],
		settings: { ...DEFAULT_SETTINGS },
		updatedAt: ''
	});

	const kinds = (s: Student) => validatePlan(s, catalog).map((i) => i.kind);

	it('does not ask whether a completed course met its prerequisites', () => {
		// MATH 211 needs precalculus. The student took and passed it; the university answered
		// that question by enrolling them, and re-litigating a finished term buries the notes
		// that are actually actionable.
		const imported = student([
			{ code: 'MATH 211', credits: 4, origin: 'banner', grade: 'B+', status: 'completed' }
		]);
		expect(kinds(imported)).not.toContain('prereq-unmet');
	});

	it('still asks when an advisor placed the same course by hand', () => {
		expect(kinds(student([{ code: 'MATH 211', credits: 4 }]))).toContain('prereq-unmet');
	});

	it('does not flag the term a course was actually taken in', () => {
		// PHYS 452 is fall-only in our data; a student who took it in spring took it in spring.
		const spring: Student = {
			...student([]),
			semesters: [
				{
					id: 'spring-2025',
					term: 'spring',
					year: 2025,
					courses: [{ code: 'PHYS 452', credits: 3, origin: 'banner', status: 'completed' }]
				}
			]
		};
		expect(kinds(spring)).not.toContain('term-unavailable');
	});

	it('uses a reported grade for a later minimum-grade clause', () => {
		// MATH 212 needs a C or better in MATH 211. A D does not clear it.
		const weak: Student = {
			...student([]),
			semesters: [
				{
					id: 'fall-2024',
					term: 'fall',
					year: 2024,
					courses: [{ code: 'MATH 211', credits: 4, grade: 'D', status: 'completed' }]
				},
				{
					id: 'spring-2025',
					term: 'spring',
					year: 2025,
					courses: [{ code: 'MATH 212', credits: 4 }]
				}
			]
		};
		expect(kinds(weak)).toContain('prereq-unmet');

		const strong = {
			...weak,
			semesters: [
				{ ...weak.semesters[0], courses: [{ code: 'MATH 211', credits: 4, grade: 'B+', status: 'completed' as const }] },
				weak.semesters[1]
			]
		};
		expect(kinds(strong)).not.toContain('prereq-unmet');
	});
});

describe('courses that may be taken more than once', () => {
	const twice = (code: string): Student => ({
		id: 't',
		name: 'Test',
		programId: 'physics-bs',
		catalogYear: catalog.catalogYear,
		startTerm: 'fall',
		startYear: 2026,
		priorCredits: [],
		semesters: [
			{ id: 'fall-2026', term: 'fall', year: 2026, courses: [{ code, credits: 1 }] },
			{ id: 'spring-2027', term: 'spring', year: 2027, courses: [{ code, credits: 1 }] }
		],
		settings: { ...DEFAULT_SETTINGS },
		updatedAt: ''
	});

	it('does not flag a research course taken in two terms', () => {
		// Repeating PHYS 197 is the point of it, not a mistake.
		expect(catalog.courses.get('PHYS 197')?.repeatable).toBe(true);
		expect(validatePlan(twice('PHYS 197'), catalog).map((i) => i.kind)).not.toContain(
			'duplicate-course'
		);
	});

	it('reads the catalog when it says so itself', () => {
		// Most repeatable courses say "May be repeated for credit" in their own description.
		const stated = [...catalog.courses.values()].filter((c) =>
			/may be repeated/i.test(c.description ?? '')
		);
		expect(stated.length).toBeGreaterThan(50);
		expect(stated.every((c) => c.repeatable)).toBe(true);
	});

	it('still flags an ordinary course planned twice', () => {
		expect(validatePlan(twice('MATH 211'), catalog).map((i) => i.kind)).toContain(
			'duplicate-course'
		);
	});
});
