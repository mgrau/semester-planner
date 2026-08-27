import { describe, expect, it } from 'vitest';
import {
	ImportError,
	decodePayload,
	importPayloadFrom,
	matchByUin,
	prepareImport,
	uinDigits,
	withoutMiddleInitial,
	type BannerPayload
} from './bannerPlus';
import { bannerProgramId, catalog } from '$lib/catalog';
import { DEFAULT_SETTINGS } from '$lib/stores/roster.svelte';
import type { Student } from '$lib/types';

/** The contract under test is IMPORT.md, shared with the banner_plus repo. */

function encode(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

const PAYLOAD: BannerPayload = {
	v: 1,
	source: 'banner-plus',
	generated: '2026-08-27T14:03:11.000Z',
	student: {
		uin: '01234567',
		firstName: 'Jane',
		lastName: 'Doe',
		email: 'jdoe001@odu.edu',
		majors: ['Astrophysics'],
		standing: 'Junior',
		admitTerm: { season: 'fall', year: 2024 },
		confidential: false
	},
	terms: [
		{
			season: 'fall',
			year: 2024,
			code: '202410',
			courses: [
				{ code: 'MATH 211', title: 'Calculus I', credits: 4, grade: 'B+', status: 'completed' },
				{ code: 'ENGL 110C', title: 'Composition', credits: 3, grade: 'A', status: 'completed' },
				{ code: 'HIST 100H', title: 'Dropped', credits: 3, grade: 'W', status: 'withdrawn' }
			]
		},
		{
			season: 'spring',
			year: 2025,
			code: '202420',
			courses: [{ code: 'MATH 212', credits: 4, status: 'in-progress' }]
		}
	]
};

const base = {
	catalogYear: catalog.catalogYear,
	defaultSettings: DEFAULT_SETTINGS,
	newId: () => 'new-id',
	now: '2026-08-27T15:00:00.000Z',
	knownCourses: new Set(catalog.courses.keys())
};

const prepare = (payload: BannerPayload, students: Student[] = []) =>
	prepareImport({ ...base, payload, students });

describe('reading the link', () => {
	it('finds the payload in a fragment', () => {
		expect(importPayloadFrom('#import=abc123')).toBe('abc123');
		expect(importPayloadFrom('#other=1&import=abc123')).toBe('abc123');
		expect(importPayloadFrom('#nothing')).toBeNull();
		expect(importPayloadFrom('')).toBeNull();
	});

	it('round-trips a v1 payload', () => {
		const decoded = decodePayload(encode(PAYLOAD));
		expect(decoded.student.uin).toBe('01234567');
		expect(decoded.terms).toHaveLength(2);
		expect(decoded.terms[0].courses[0].code).toBe('MATH 211');
	});

	it('survives base64url substitutions and missing padding', () => {
		// A payload long enough to need padding, with bytes that encode to + and /.
		const p = { ...PAYLOAD, student: { ...PAYLOAD.student, lastName: 'Ýÿ~?þ Doe' } };
		expect(decodePayload(encode(p)).student.lastName).toBe('Ýÿ~?þ Doe');
	});

	it('refuses a version it does not know', () => {
		expect(() => decodePayload(encode({ ...PAYLOAD, v: 2 }))).toThrow(ImportError);
		expect(() => decodePayload(encode({ ...PAYLOAD, v: 2 }))).toThrow(/version 2/);
	});

	it('refuses something that is not a payload', () => {
		expect(() => decodePayload('not-base64!!')).toThrow(ImportError);
		expect(() => decodePayload(encode({ v: 1, terms: [] }))).toThrow(/names no student/);
		expect(() => decodePayload(encode({ ...PAYLOAD, terms: [{ season: 'harvest', year: 1 }] }))).toThrow(
			ImportError
		);
	});

	it('refuses an unreasonably large link rather than trusting it', () => {
		expect(() => decodePayload('A'.repeat(600_000))).toThrow(/too large/);
	});
});

describe('creating a student', () => {
	const { student, summary } = prepare(PAYLOAD);

	it('turns terms into semesters, not prior credit', () => {
		expect(summary.action).toBe('create');
		expect(student.priorCredits).toEqual([]);
		expect(student.semesters.map((s) => s.id)).toEqual(['fall-2024', 'spring-2025']);
	});

	it('keeps the calendar year Banner already converted for us', () => {
		// Spring 2025 comes from code 202420 — academic year 2024, calendar year 2025. Getting
		// this wrong shifts two thirds of a transcript by a year.
		const spring = student.semesters.find((s) => s.term === 'spring')!;
		expect(spring.year).toBe(2025);
		expect(spring.id).toBe('spring-2025');
	});

	it("records identity, marking every row as Banner's", () => {
		expect(student.studentId).toBe('01234567');
		expect(student.firstName).toBe('Jane');
		expect(student.lastName).toBe('Doe');
		expect(student.name).toBe('Jane Doe');
		expect(student.email).toBe('jdoe001@odu.edu');
		expect(student.semesters.every((s) => s.courses.every((c) => c.origin === 'banner'))).toBe(true);
	});

	it('carries the grade and status of each course', () => {
		const fall = student.semesters[0].courses;
		expect(fall.find((c) => c.code === 'MATH 211')).toMatchObject({
			credits: 4,
			grade: 'B+',
			status: 'completed'
		});
		const spring = student.semesters[1].courses[0];
		expect(spring).toMatchObject({ code: 'MATH 212', status: 'in-progress' });
		expect(spring.grade).toBeUndefined();
	});

	it('drops a withdrawal, which is neither earned nor in progress', () => {
		const codes = student.semesters.flatMap((s) => s.courses.map((c) => c.code));
		expect(codes).not.toContain('HIST 100H');
		expect(summary.withdrawnCount).toBe(1);
		expect(summary.courseCount).toBe(3);
	});

	it('takes the start term from the admit term', () => {
		expect(student.startTerm).toBe('fall');
		expect(student.startYear).toBe(2024);
	});

	it('maps the major to a program', () => {
		expect(student.programId).toBe('physics-astrophysics-bs');
		expect(summary.programUnmapped).toBe(false);
	});

	it('fills the gap left by a term with no registration', () => {
		const gapped = prepare({
			...PAYLOAD,
			terms: [PAYLOAD.terms[0], { season: 'fall', year: 2025, courses: [] }]
		});
		// Banner omits a term the student sat out; a plan wants the span continuous.
		expect(gapped.student.semesters.map((s) => s.id)).toEqual([
			'fall-2024',
			'spring-2025',
			'fall-2025'
		]);
		expect(gapped.student.semesters[1].courses).toEqual([]);
	});
});

describe('mapping Banner majors', () => {
	it('takes an exact name', () => {
		expect(bannerProgramId(['Physics'])).toBe('physics-bs');
		expect(bannerProgramId(['Astrophysics'])).toBe('physics-astrophysics-bs');
	});

	it('falls back to the longest name inside the text', () => {
		expect(bannerProgramId(['Physics & Electrical Engn - BS'])).toBe(
			'physics-electrical-engineering-bs'
		);
		// and the longer name wins over the shorter one it contains
		expect(bannerProgramId(['Physics & Electrical Engn'])).not.toBe('physics-bs');
	});

	it('takes the first major that maps', () => {
		expect(bannerProgramId(['Basket Weaving', 'Astrophysics'])).toBe('physics-astrophysics-bs');
	});

	it('leaves it for the advisor rather than guessing', () => {
		expect(bannerProgramId(['Marine Biology'])).toBeUndefined();
		expect(bannerProgramId([])).toBeUndefined();
		expect(prepare({ ...PAYLOAD, student: { ...PAYLOAD.student, majors: ['Marine Biology'] } }).student.programId).toBe('');
	});
});

describe('matching an existing advisee', () => {
	const stored = (studentId: string | undefined, id = 's1'): Student => ({
		id,
		name: 'Jane Doe',
		firstName: 'Jane',
		lastName: 'Doe',
		studentId,
		programId: 'physics-astrophysics-bs',
		catalogYear: catalog.catalogYear,
		startTerm: 'fall',
		startYear: 2024,
		priorCredits: [],
		semesters: [],
		settings: { ...DEFAULT_SETTINGS },
		updatedAt: '2026-01-01T00:00:00.000Z'
	});

	it('compares the digits, not the strings', () => {
		expect(uinDigits('UIN 01234567')).toBe('1234567');
		expect(uinDigits('01234567')).toBe(uinDigits('1234567'));
		expect(matchByUin([stored('UIN 01234567')], '01234567')).toHaveLength(1);
		expect(matchByUin([stored('7654321')], '01234567')).toHaveLength(0);
		expect(matchByUin([stored(undefined)], '01234567')).toHaveLength(0);
	});

	it('stops when two advisees share one UIN', () => {
		// A data problem to surface, not to silently pick a winner in.
		expect(() => prepare(PAYLOAD, [stored('01234567', 'a'), stored('1234567', 'b')])).toThrow(
			/share the UIN/
		);
	});
});

describe("re-importing over an advisor's work", () => {
	const advisorPlan: Student = {
		id: 's1',
		name: 'Jane Doe',
		firstName: 'Jane',
		lastName: 'Doe',
		studentId: 'UIN 01234567',
		programId: 'physics-bs', // the advisor changed it away from Banner's major
		catalogYear: catalog.catalogYear,
		startTerm: 'fall',
		startYear: 2024,
		notes: 'Wants to graduate early.',
		priorCredits: [
			{ id: 'p1', kind: 'course', course: 'CHEM 121N', credits: 4, source: 'Tidewater CC' }
		],
		placements: ['MATH 163'],
		semesters: [
			{
				id: 'fall-2024',
				term: 'fall',
				year: 2024,
				courses: [
					// what a previous import wrote, now stale
					{ code: 'MATH 211', credits: 4, origin: 'banner', grade: 'C' },
					// what the advisor added by hand
					{ code: 'UNIV 110', credits: 1 }
				]
			},
			{
				id: 'fall-2026',
				term: 'fall',
				year: 2026,
				courses: [{ code: 'PHYS 313', credits: 3 }]
			}
		],
		settings: { ...DEFAULT_SETTINGS },
		updatedAt: '2026-01-01T00:00:00.000Z'
	};

	const { student, summary } = prepare(PAYLOAD, [advisorPlan]);
	const term = (id: string) => student.semesters.find((s) => s.id === id)!;

	it('updates rather than creating a second record', () => {
		expect(summary.action).toBe('update');
		expect(student.id).toBe('s1');
	});

	it('replaces what the last import wrote', () => {
		const math = term('fall-2024').courses.find((c) => c.code === 'MATH 211')!;
		expect(math.grade).toBe('B+');
	});

	it("keeps the advisor's own course in a past term", () => {
		expect(term('fall-2024').courses.map((c) => c.code)).toContain('UNIV 110');
		expect(summary.keptCourses).toBe(1);
	});

	it('does not touch a term the payload does not name', () => {
		// This is the plan — the thing the app exists to hold.
		expect(term('fall-2026').courses).toEqual([{ code: 'PHYS 313', credits: 3 }]);
		expect(summary.untouchedTerms).toBe(1);
	});

	it('leaves notes, prior credit, placements and settings alone', () => {
		expect(student.notes).toBe('Wants to graduate early.');
		expect(student.priorCredits).toEqual(advisorPlan.priorCredits);
		expect(student.placements).toEqual(['MATH 163']);
		expect(student.settings).toEqual(advisorPlan.settings);
		expect(student.catalogYear).toBe(advisorPlan.catalogYear);
	});

	it('shows a disagreement over the major without applying it', () => {
		expect(student.programId).toBe('physics-bs');
		expect(summary.conflicts.map((c) => c.field)).toContain('Major');
	});

	it('adds a term the student did not have', () => {
		expect(term('spring-2025').courses.map((c) => c.code)).toEqual(['MATH 212']);
		expect(summary.addedTerms).toContain('Spring 2025');
	});

	it('does not leave the same course in a term twice', () => {
		// A duplicate code within one term is a fatal duplicate key in the plan grid.
		const withDuplicate = {
			...advisorPlan,
			semesters: [
				{
					...advisorPlan.semesters[0],
					courses: [{ code: 'MATH 211', credits: 4 }] // advisor typed it before the import ran
				}
			]
		};
		const merged = prepare(PAYLOAD, [withDuplicate]).student.semesters[0].courses;
		expect(merged.filter((c) => c.code === 'MATH 211')).toHaveLength(1);
		expect(merged[0].origin).toBe('banner');
	});
});

describe('what the summary tells the advisor', () => {
	it('names the terms and counts the work', () => {
		const { summary } = prepare(PAYLOAD);
		expect(summary.terms).toEqual(['Fall 2024', 'Spring 2025']);
		expect(summary.name).toBe('Jane Doe');
		expect(summary.uin).toBe('01234567');
		expect(summary.generated).toBe('2026-08-27T14:03:11.000Z');
	});

	it('flags a course our catalog does not have', () => {
		const { summary } = prepare({
			...PAYLOAD,
			terms: [
				{ season: 'fall', year: 2024, courses: [{ code: 'ZZZ 999', credits: 3, status: 'completed' }] }
			]
		});
		expect(summary.unknownCourses).toEqual(['ZZZ 999']);
	});
});

describe('the name Banner hands over', () => {
	it('drops the middle initial riding on the first name', () => {
		// Banner splits "MARSILLAC, ROWAN T"; an advisee is "Rowan", not "Rowan T".
		expect(withoutMiddleInitial('Rowan T')).toBe('Rowan');
		expect(withoutMiddleInitial('Rowan T.')).toBe('Rowan');
		expect(withoutMiddleInitial('Mary Jane K')).toBe('Mary Jane');
	});

	it('leaves a name that is not carrying one', () => {
		expect(withoutMiddleInitial('Rowan')).toBe('Rowan');
		expect(withoutMiddleInitial('Mary Jane')).toBe('Mary Jane');
		// a one-letter first name is a name, not an initial
		expect(withoutMiddleInitial('T')).toBe('T');
	});

	it('uses it for the record and the display name', () => {
		const { student } = prepare({
			...PAYLOAD,
			student: { ...PAYLOAD.student, firstName: 'Rowan T' }
		});
		expect(student.firstName).toBe('Rowan');
		expect(student.name).toBe('Rowan Doe');
	});
});
