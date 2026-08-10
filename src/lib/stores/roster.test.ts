import { describe, expect, it } from 'vitest';
import { normalizeStudent } from './roster.svelte';
import { studentFromYaml } from '$lib/exports';
import type { Student } from '$lib/types';

/**
 * Records saved by earlier versions are still in advisors' localStorage and in the .yaml files
 * they have already handed out, so opening one has to work.
 */

/** An export from before placeholders were numbered: two Language and Culture slots, one code. */
const LEGACY_EXPORT = `format: odu-planner-student/v1
student:
  id: hz7mu3jh
  name: ambrose orth
  programId: physics-astrophysics-bs
  catalogYear: 2026-2027
  startTerm: fall
  startYear: 2024
  priorCredits: []
  placements: []
  semesters:
    - id: fall-2025
      term: fall
      year: 2025
      courses:
        - code: MATH 212
          credits: 4
        - code: placeholder:language:3
          placeholder:
            label: Language and Culture
            category: language
          credits: 4
        - code: placeholder:language:3
          placeholder:
            label: Language and Culture
            category: language
          credits: 3
  settings:
    maxCreditsPerTerm: 16
    minCreditsPerTerm: 12
    includeSummers: true
    summerMaxCredits: 7
    targetYears: 4
  updatedAt: 2026-08-10T19:44:48.965Z
`;

function codesIn(s: Student, termId: string): string[] {
	return s.semesters.find((x) => x.id === termId)!.courses.map((c) => c.code);
}

describe('normalizeStudent', () => {
	it('opens a plan saved with colliding placeholder codes', () => {
		// A repeated key is fatal to the keyed {#each} that draws a term, which left the advisor
		// stuck on the student list with no plan and no error.
		const raw = studentFromYaml(LEGACY_EXPORT);
		expect(new Set(codesIn(raw, 'fall-2025')).size).toBeLessThan(codesIn(raw, 'fall-2025').length);

		const fixed = normalizeStudent(raw);
		const codes = codesIn(fixed, 'fall-2025');
		expect(new Set(codes).size).toBe(codes.length);
	});

	it('keeps both slots and their categories when it renumbers them', () => {
		const fixed = normalizeStudent(studentFromYaml(LEGACY_EXPORT));
		const term = fixed.semesters.find((s) => s.id === 'fall-2025')!;
		expect(term.courses).toHaveLength(3);
		const language = term.courses.filter((c) => c.placeholder?.category === 'language');
		expect(language.map((c) => c.credits)).toEqual([4, 3]);
	});

	it('drops a real course listed twice in one term', () => {
		const doubled = studentFromYaml(LEGACY_EXPORT);
		doubled.semesters[0].courses.push({ code: 'MATH 212', credits: 4 });
		expect(codesIn(normalizeStudent(doubled), 'fall-2025').filter((c) => c === 'MATH 212')).toEqual(
			['MATH 212']
		);
	});

	it('leaves the terms of a sound plan untouched', () => {
		const sound = studentFromYaml(LEGACY_EXPORT);
		sound.semesters[0].courses.splice(2, 1);
		// Codes should stay stable across loads rather than being renumbered every time.
		expect(normalizeStudent(sound).semesters[0]).toBe(sound.semesters[0]);
	});

	it('splits a name that predates the first/last fields', () => {
		const s = normalizeStudent(studentFromYaml(LEGACY_EXPORT));
		expect(s.firstName).toBe('ambrose');
		expect(s.lastName).toBe('orth');
	});
});
