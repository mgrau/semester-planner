import type { PlannedCourse, PlannerSettings, Semester, Student, Term } from '$lib/types';
import { nextTerm, sortSemesters, termOrdinal } from '$lib/engine/validate';
import { bannerProgramId } from '$lib/catalog';

/**
 * Importing a student from Banner Plus, which hands us a whole registration history in the URL
 * fragment. The producing end is bookmarklet/src/55-planner.js in the banner_plus repo; the two
 * deploy separately and nothing checks them against each other, so `v` is what turns a mismatch
 * into a refusal rather than a misreading.
 *
 * Everything here is pure: decode, match, merge, and describe. Nothing touches the roster or the
 * location — the caller does that, after an advisor has seen the summary and agreed to it. The
 * payload is a named student's transcript arriving over a link anyone could construct, so it is
 * treated as a proposal throughout, never as truth to apply on sight.
 */

/** A four-year transcript runs 5–8 KB. Well past that is not a transcript. */
const MAX_ENCODED_BYTES = 512 * 1024;

const SEASONS: Term[] = ['fall', 'spring', 'summer', 'winter'];

export interface BannerTermRef {
	season: Term;
	year: number;
}

export interface BannerCourse {
	code: string;
	title?: string;
	credits: number;
	grade?: string;
	status: 'completed' | 'in-progress' | 'withdrawn';
	crn?: string;
}

export interface BannerTerm extends BannerTermRef {
	code?: string;
	courses: BannerCourse[];
}

export interface BannerPayload {
	v: number;
	source?: string;
	generated?: string;
	student: {
		uin: string;
		firstName: string;
		lastName: string;
		email?: string;
		majors?: string[];
		college?: string;
		standing?: string;
		admitTerm?: BannerTermRef;
		confidential?: boolean;
	};
	terms: BannerTerm[];
}

/** Thrown for a payload we will not act on. The message is shown to the advisor as-is. */
export class ImportError extends Error {}

/**
 * base64url — standard base64 with `+` → `-`, `/` → `_` and the padding dropped. Reverse the
 * substitutions, re-pad, then decode the UTF-8 bytes.
 */
export function decodeBase64Url(encoded: string): string {
	const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/** The encoded payload out of a URL fragment, or null if this is not an import link. */
export function importPayloadFrom(hash: string): string | null {
	const m = /(?:^#?|&)import=([^&]+)/.exec(hash);
	return m ? m[1] : null;
}

function isTermRef(v: unknown): v is BannerTermRef {
	const t = v as BannerTermRef;
	return Boolean(t) && SEASONS.includes(t.season) && Number.isFinite(t.year);
}

/** Decode and check the envelope. Anything we cannot vouch for is refused, not guessed at. */
export function decodePayload(encoded: string): BannerPayload {
	if (encoded.length > MAX_ENCODED_BYTES) {
		throw new ImportError('That import link is too large to be a transcript.');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeBase64Url(encoded));
	} catch {
		throw new ImportError('That import link is not readable — it may have been truncated.');
	}

	const p = parsed as BannerPayload;
	if (!p || typeof p !== 'object') throw new ImportError('That import link carries no data.');
	if (p.v !== 1) {
		throw new ImportError(
			`This link is version ${p.v ?? '?'}, which this planner does not know how to read. Update the planner, or the bookmarklet.`
		);
	}
	if (!p.student?.uin || !p.student.lastName) {
		throw new ImportError('That import link names no student.');
	}
	if (!Array.isArray(p.terms)) throw new ImportError('That import link carries no terms.');
	for (const t of p.terms) {
		if (!isTermRef(t) || !Array.isArray(t.courses)) {
			throw new ImportError('That import link has a term this planner cannot read.');
		}
	}
	return p;
}

/** Just the digits, so "UIN 01234567", "01234567" and "1234567" all compare equal. */
export function uinDigits(value: string | undefined): string {
	return (value ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

export function matchByUin(students: Student[], uin: string): Student[] {
	const key = uinDigits(uin);
	if (!key) return [];
	return students.filter((s) => uinDigits(s.studentId) === key);
}

const termId = (t: BannerTermRef) => `${t.season}-${t.year}`;

/**
 * Banner splits `LAST, FIRST M`, so the middle initial rides along on the first name. An
 * advisee is "Rowan", not "Rowan T" — everywhere this app shows a name it wants the one people
 * use. Only a trailing single letter is dropped, so a one-letter first name survives.
 */
export function withoutMiddleInitial(first: string): string {
	return first.trim().replace(/\s+[A-Za-z]\.?$/, '').trim() || first.trim();
}

/** Registration rows worth planning: withdrawn is neither credit earned nor work in progress. */
function plannedCoursesOf(term: BannerTerm): PlannedCourse[] {
	return term.courses
		.filter((c) => c.status !== 'withdrawn' && c.code)
		.map((c) => ({
			code: c.code.trim().toUpperCase(),
			credits: Number(c.credits) || 0,
			origin: 'banner' as const,
			...(c.grade ? { grade: c.grade } : {}),
			...(c.status === 'completed' || c.status === 'in-progress' ? { status: c.status } : {})
		}));
}

/**
 * Empty fall/spring terms between the first and last term the payload names.
 * Banner simply omits a term with no registration; a plan wants the span to be continuous, so a
 * semester off reads as a gap in a row of terms rather than as a term that never existed.
 */
function fillGaps(semesters: Semester[]): Semester[] {
	if (semesters.length < 2) return semesters;
	const sorted = sortSemesters(semesters);
	const have = new Set(sorted.map((s) => s.id));
	const last = termOrdinal(sorted[sorted.length - 1]);
	const out = [...sorted];

	let cursor: { term: Term; year: number } = { term: sorted[0].term, year: sorted[0].year };
	let guard = 0;
	while (termOrdinal(cursor) < last && guard++ < 60) {
		cursor = nextTerm(cursor.term, cursor.year, false);
		const id = `${cursor.term}-${cursor.year}`;
		if (termOrdinal(cursor) < last && !have.has(id)) {
			out.push({ id, term: cursor.term, year: cursor.year, courses: [] });
			have.add(id);
		}
	}
	return sortSemesters(out);
}

export interface ImportConflict {
	field: string;
	stored: string;
	incoming: string;
}

export interface ImportSummary {
	action: 'create' | 'update';
	name: string;
	uin: string;
	generated?: string;
	/** Terms the payload carries, oldest first, as display labels. */
	terms: string[];
	courseCount: number;
	withdrawnCount: number;
	/** Terms the payload adds to an existing student. */
	addedTerms: string[];
	/** Advisor-placed courses inside payload terms that the merge keeps. */
	keptCourses: number;
	/** Terms the student already has that this import will not touch. */
	untouchedTerms: number;
	/** Where Banner disagrees with what is stored. Shown, never applied. */
	conflicts: ImportConflict[];
	/** Course codes the payload names that our catalog does not have. */
	unknownCourses: string[];
	/** Set when no major mapped, so the advisor knows they must pick a program. */
	programUnmapped: boolean;
	/** The program a new record would be created with, when a major mapped. */
	programId?: string;
}

export interface ImportPlan {
	student: Student;
	summary: ImportSummary;
}

export interface PrepareOptions {
	payload: BannerPayload;
	/** The whole roster, for matching on UIN. */
	students: Student[];
	catalogYear: string;
	defaultSettings: PlannerSettings;
	newId: () => string;
	now: string;
	/** Course codes the catalog knows, so the summary can flag the ones it does not. */
	knownCourses?: Set<string>;
}

/**
 * Work out what this payload would do, without doing any of it.
 *
 * The governing rule for an existing student is that the import owns what Banner knows and
 * nothing else: it replaces the rows it wrote before, leaves the advisor's alone, and never
 * touches a term the payload does not name — which is the plan, and the reason the app exists.
 */
export function prepareImport(opts: PrepareOptions): ImportPlan {
	const { payload, students, catalogYear, defaultSettings, newId, now, knownCourses } = opts;
	const b = payload.student;

	const matches = matchByUin(students, b.uin);
	if (matches.length > 1) {
		throw new ImportError(
			`${matches.length} advisees share the UIN ${b.uin}. Sort that out before importing — this planner will not guess which one is meant.`
		);
	}
	const existing = matches[0];

	const incomingTerms = sortSemesters(
		payload.terms.map((t) => ({
			id: termId(t),
			term: t.season,
			year: t.year,
			courses: plannedCoursesOf(t)
		}))
	);
	const incomingById = new Map(incomingTerms.map((s) => [s.id, s]));

	const withdrawnCount = payload.terms.reduce(
		(n, t) => n + t.courses.filter((c) => c.status === 'withdrawn').length,
		0
	);
	const courseCount = incomingTerms.reduce((n, s) => n + s.courses.length, 0);

	const unknownCourses = knownCourses
		? [
				...new Set(
					incomingTerms.flatMap((s) => s.courses.map((c) => c.code)).filter((c) => !knownCourses.has(c))
				)
			]
		: [];

	const programId = bannerProgramId(b.majors ?? []);
	const firstName = withoutMiddleInitial(b.firstName ?? '');
	const name = [firstName, b.lastName].filter(Boolean).join(' ').trim();

	// --- create -----------------------------------------------------------
	if (!existing) {
		const start = payload.student.admitTerm ?? incomingTerms[0];
		const student: Student = {
			id: newId(),
			name,
			firstName,
			lastName: b.lastName,
			studentId: b.uin,
			...(b.email ? { email: b.email } : {}),
			...(b.confidential ? { confidential: true } : {}),
			programId: programId ?? '',
			catalogYear,
			startTerm: (start && 'season' in start ? start.season : start?.term) ?? 'fall',
			startYear: start?.year ?? new Date(now).getFullYear(),
			priorCredits: [],
			placements: [],
			semesters: fillGaps(incomingTerms),
			settings: { ...defaultSettings },
			updatedAt: now
		};
		return {
			student,
			summary: {
				action: 'create',
				name,
				uin: b.uin,
				generated: payload.generated,
				terms: incomingTerms.map(label),
				courseCount,
				withdrawnCount,
				addedTerms: [],
				keptCourses: 0,
				untouchedTerms: 0,
				conflicts: [],
				unknownCourses,
				programUnmapped: !programId,
				...(programId ? { programId } : {})
			}
		};
	}

	// --- update -----------------------------------------------------------
	let keptCourses = 0;
	const merged: Semester[] = existing.semesters.map((sem) => {
		const incoming = incomingById.get(sem.id);
		if (!incoming) return sem; // not named by the payload: the advisor's, untouched

		// Replace only what a previous import wrote. An advisor's own row in a past term stays,
		// unless Banner now reports the same course — then Banner's is the record of it.
		const codes = new Set(incoming.courses.map((c) => c.code));
		const kept = sem.courses.filter((c) => c.origin !== 'banner' && !codes.has(c.code));
		keptCourses += kept.length;
		return { ...sem, courses: [...incoming.courses, ...kept] };
	});

	const existingIds = new Set(existing.semesters.map((s) => s.id));
	const addedTerms = incomingTerms.filter((s) => !existingIds.has(s.id));

	const conflicts: ImportConflict[] = [];
	const push = (field: string, stored: unknown, incoming: unknown) => {
		const a = String(stored ?? '').trim();
		const c = String(incoming ?? '').trim();
		if (c && a !== c) conflicts.push({ field, stored: a || '(not set)', incoming: c });
	};
	// Program and start term seed a new record; on an existing one they are a suggestion. An
	// advisor who changed the program did so for a reason, so the difference is shown, not applied.
	if (programId) push('Major', existing.programId, programId);
	if (b.admitTerm) {
		push(
			'Start term',
			`${existing.startTerm} ${existing.startYear}`,
			`${b.admitTerm.season} ${b.admitTerm.year}`
		);
	}

	const student: Student = {
		...existing,
		// Banner is authoritative for identity.
		firstName,
		lastName: b.lastName,
		name,
		studentId: b.uin,
		...(b.email ? { email: b.email } : {}),
		confidential: Boolean(b.confidential),
		semesters: sortSemesters([...merged, ...addedTerms]),
		updatedAt: now
	};

	return {
		student,
		summary: {
			action: 'update',
			name,
			uin: b.uin,
			generated: payload.generated,
			terms: incomingTerms.map(label),
			courseCount,
			withdrawnCount,
			addedTerms: addedTerms.map(label),
			keptCourses,
			untouchedTerms: existing.semesters.filter((s) => !incomingById.has(s.id)).length,
			conflicts,
			unknownCourses,
			programUnmapped: !existing.programId && !programId
		}
	};
}

function label(s: { term: Term; year: number }): string {
	return `${s.term[0].toUpperCase()}${s.term.slice(1)} ${s.year}`;
}
