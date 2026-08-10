import { describe, expect, it } from 'vitest';
import { courseworkCredits, describePriorCredit, groupOf } from './priorCredits';
import {
	associateDegreeCategories,
	catalog,
	preparationToRecords,
	startingPreparation
} from './catalog';
import { satisfiedCategoriesFrom } from './engine/requirements';
import type { PriorCredit } from './types';

const view = (p: PriorCredit) => describePriorCredit(p, catalog.genEd, catalog.courses);

let n = 0;
const newId = () => `id-${n++}`;

describe('prior credit presentation', () => {
	it('names a course by its code, with the title alongside', () => {
		const v = view({ id: '1', kind: 'course', course: 'MATH 211', credits: 4, grade: 'A' });
		expect(v.name).toBe('MATH 211');
		expect(v.detail).toContain('Calculus I');
		expect(v.detail).toContain('grade A');
		expect(v.credits).toBe('4 cr');
	});

	it('names a waived requirement by the requirement', () => {
		const v = view({ id: '1', kind: 'category', category: 'language', credits: 6 });
		expect(v.name).toBe('Language and Culture');
		// A waiver is not credit earned, so no credit figure is shown against it.
		expect(v.credits).toBe('');
	});

	it('never leaves a declared condition unnamed', () => {
		// This is what the "High school chemistry" checkbox produces: a record with no course
		// code at all. It used to render as a blank row.
		const v = view({
			id: '1',
			kind: 'course',
			credits: 0,
			source: 'High school chemistry',
			satisfiesNotes: ['High school chemistry']
		});
		expect(v.name).toBe('High school chemistry');
		expect(v.name).not.toBe('');
	});

	it('gives every record produced by the default checklist a name', () => {
		const { priorCredits } = preparationToRecords(
			startingPreparation.filter((o) => o.default).map((o) => o.id),
			newId
		);
		expect(priorCredits.length).toBeGreaterThan(0);
		for (const p of priorCredits) {
			expect(view(p).name.trim(), `record from ${p.source} has no name`).not.toBe('');
		}
	});
});

describe('grouping', () => {
	it('separates coursework from requirements met without it', () => {
		expect(groupOf({ id: '1', kind: 'course', course: 'MATH 211', credits: 4 })).toBe('coursework');
		expect(groupOf({ id: '2', kind: 'category', category: 'language', credits: 6 })).toBe(
			'satisfied'
		);
		// No course code means a declared condition, not coursework.
		expect(groupOf({ id: '3', kind: 'course', credits: 0, source: 'High school chemistry' })).toBe(
			'satisfied'
		);
	});

	it('counts only real coursework toward the earned total', () => {
		const records: PriorCredit[] = [
			{ id: '1', kind: 'course', course: 'MATH 211', credits: 4 },
			{ id: '2', kind: 'category', category: 'language', credits: 6 },
			{ id: '3', kind: 'course', credits: 0, source: 'High school chemistry' }
		];
		expect(courseworkCredits(records)).toBe(4);
	});

	it('leaves a default new student with zero earned credits', () => {
		const { priorCredits } = preparationToRecords(
			startingPreparation.filter((o) => o.default).map((o) => o.id),
			newId
		);
		expect(courseworkCredits(priorCredits)).toBe(0);
	});
});

describe('transfer associate degree', () => {
	it('covers the lower-division categories but not the writing programme', () => {
		const ids = associateDegreeCategories.map((c) => c.id);
		// The catalog: lower-division general education is met "except ... requirements for
		// completion of the undergraduate writing program".
		expect(ids).not.toContain('written');
		expect(ids).toContain('oral');
		expect(ids).toContain('nature');
		expect(ids).toContain('language');
	});

	it('never waives an upper-division requirement', () => {
		const ids = associateDegreeCategories.map((c) => c.id);
		expect(ids).not.toContain('upper-division-writing-intensive');
		expect(ids).not.toContain('upper-division-outside-major');
	});

	it('leaves the writing requirements outstanding after it is applied', () => {
		const records: PriorCredit[] = associateDegreeCategories.map((c, i) => ({
			id: String(i),
			kind: 'category',
			category: c.id,
			credits: c.credits
		}));
		const satisfied = satisfiedCategoriesFrom(records);
		expect(satisfied.has('written')).toBe(false);
		expect(satisfied.has('upper-division-writing-intensive')).toBe(false);
		expect(satisfied.has('philosophy')).toBe(true);
	});

	it('awards no credit — a waiver is not coursework', () => {
		const records: PriorCredit[] = associateDegreeCategories.map((c, i) => ({
			id: String(i),
			kind: 'category',
			category: c.id,
			credits: c.credits
		}));
		expect(courseworkCredits(records)).toBe(0);
	});

	it('is one record naming the degree, not one per category', () => {
		const block: PriorCredit = {
			id: '1',
			kind: 'category',
			categories: associateDegreeCategories.map((c) => c.id),
			credits: 0,
			source: 'Associate degree (transfer)'
		};
		// It satisfies every category it covers...
		const satisfied = satisfiedCategoriesFrom([block]);
		expect(satisfied.size).toBe(associateDegreeCategories.length);
		expect(satisfied.has('philosophy')).toBe(true);
		expect(satisfied.has('written')).toBe(false);

		// ...while reading as a single line.
		const v = view(block);
		expect(v.name).toBe('Associate degree (transfer)');
		expect(v.detail).toBe('11 general education categories waived');
		expect(v.credits).toBe('');
	});
})
