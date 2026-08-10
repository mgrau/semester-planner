import { describe, expect, it } from 'vitest';
import { planToHtmlTable } from './exports';
import { catalog } from './catalog';
import type { CourseKind } from './courseKind';
import type { Student } from './types';
import { DEFAULT_SETTINGS } from './stores/roster.svelte';

const kinds = new Map<string, CourseKind>([
	['MATH 211', 'math'],
	['PHYS 261N', 'major']
]);

const student: Student = {
	id: 't',
	name: 'Test Student',
	firstName: 'Test',
	lastName: 'Student',
	programId: 'physics-astrophysics-bs',
	catalogYear: catalog.catalogYear,
	startTerm: 'fall',
	startYear: 2026,
	priorCredits: [],
	settings: { ...DEFAULT_SETTINGS },
	updatedAt: '',
	semesters: [
		{
			id: 'fall-2026',
			term: 'fall',
			year: 2026,
			courses: [
				{ code: 'MATH 211', credits: 4 },
				{ code: 'ENGL 110C', credits: 3 }
			]
		},
		{
			id: 'spring-2027',
			term: 'spring',
			year: 2027,
			courses: [{ code: 'PHYS 261N', credits: 4 }]
		}
	]
};

/** Cell text by row, using the same 4-column grid the export builds. */
function cells(html: string): string[][] {
	return [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((r) =>
		[...r[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1])
	);
}

describe('spreadsheet export', () => {
	const html = planToHtmlTable(student, catalog, kinds);
	const rows = cells(html);

	it('puts a live SUM in each term header rather than a frozen number', () => {
		// Rows: 1 title, 2 meta, 3 Fall header, 4 column labels, 5-6 courses,
		//       7 Spring header, 8 column labels, 9 course, 10 grand total.
		expect(rows[2].at(-1)).toBe('=SUM(D5:D6)');
		expect(rows[6].at(-1)).toBe('=SUM(D9:D9)');
	});

	it('sums the term totals, not every course row, for the grand total', () => {
		// Deleting a whole term should leave the grand total valid.
		expect(rows.at(-1)?.at(-1)).toBe('=SUM(D3,D7)');
	});

	it('keeps every row four columns wide, so credits always land in column D', () => {
		// A cell's colspan still occupies its columns, so `1 + colspans` must reach 4 on every
		// row. If it did not, the SUM ranges would point at the wrong column.
		const widths = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((r) =>
			[...r[1].matchAll(/<td([^>]*)>/g)].reduce((sum, td) => {
				const span = /colspan="(\d+)"/.exec(td[1]);
				return sum + (span ? Number(span[1]) : 1);
			}, 0)
		);
		for (const w of widths) expect(w, `row spans ${w} columns`).toBe(4);
	});

	it('puts course credits in the last cell of a course row', () => {
		expect(rows[4].length).toBe(4);
		expect(rows[4].at(-1)).toBe('4');
	});

	it('references rows that actually hold course credits', () => {
		// Row 5 and 6 are the two Fall courses; guard against an off-by-one in the header row.
		expect(rows[4].at(-1)).toBe('4');
		expect(rows[5].at(-1)).toBe('3');
	});

	it('handles an empty term without a broken range', () => {
		const withEmpty: Student = {
			...student,
			semesters: [{ id: 'fall-2026', term: 'fall', year: 2026, courses: [] }]
		};
		const r = cells(planToHtmlTable(withEmpty, catalog, kinds));
		expect(r[2].at(-1)).toBe('0');
		expect(r.at(-1)?.at(-1)).toBe('=SUM(D3)');
	});
});
