import type { Catalog, Issue, PriorCredit, Semester, Student, Term } from '$lib/types';
import { describe, evaluate, type CreditState } from './expr';

/** Chronological order within a calendar year. */
const TERM_ORDER: Record<Term, number> = { spring: 0, summer: 1, fall: 2, winter: 3 };

export function sortSemesters(semesters: Semester[]): Semester[] {
	return [...semesters].sort(
		(a, b) => a.year - b.year || TERM_ORDER[a.term] - TERM_ORDER[b.term]
	);
}

export function termLabel(s: { term: Term; year: number }): string {
	return `${s.term[0].toUpperCase()}${s.term.slice(1)} ${s.year}`;
}

/** Prerequisite prose the student has already declared, so it need not be re-confirmed. */
function declaredNotes(priorCredits: PriorCredit[]): string[] {
	return priorCredits.flatMap((p) => p.satisfiesNotes ?? []).map((n) => n.toLowerCase());
}

function priorState(priorCredits: PriorCredit[], placements: string[] = []): CreditState {
	// Placement satisfies a prerequisite without being coursework, so it belongs in `completed`
	// but never contributes credit.
	const completed = new Set<string>(placements);
	const grades = new Map<string, NonNullable<PriorCredit['grade']>>();
	for (const p of priorCredits) {
		if (p.kind === 'course' && p.course) {
			completed.add(p.course);
			if (p.grade) grades.set(p.course, p.grade);
		}
	}
	return { completed, grades };
}

/**
 * Validate a plan term by term.
 *
 * Prerequisites are checked against everything completed *strictly before* the term.
 * Pre-or-corequisites additionally accept the same term. Strict corequisites must be in
 * the same term (or already done).
 */
export function validatePlan(student: Student, catalog: Catalog): Issue[] {
	const issues: Issue[] = [];
	const { completed, grades } = priorState(student.priorCredits, student.placements ?? []);
	const declared = declaredNotes(student.priorCredits);
	const seen = new Set(completed);
	const seenGrades = new Map(grades);
	const placedIn = new Map<string, string>();
	const settings = student.settings;

	for (const sem of sortSemesters(student.semesters)) {
		const thisTerm = new Set(sem.courses.filter((c) => !c.placeholder).map((c) => c.code));
		const before: CreditState = { completed: new Set(seen), grades: seenGrades };
		const withThisTerm: CreditState = {
			completed: new Set([...seen, ...thisTerm]),
			grades: seenGrades
		};

		let credits = 0;
		for (const pc of sem.courses) {
			credits += pc.credits;
			if (pc.placeholder) continue;

			const course = catalog.courses.get(pc.code);
			if (!course) {
				issues.push({
					severity: 'warning',
					kind: 'unknown-course',
					message: `${pc.code} is not in the ${catalog.catalogYear} catalog.`,
					semesterId: sem.id,
					course: pc.code
				});
				continue;
			}

			const earlier = placedIn.get(pc.code);
			if (earlier) {
				issues.push({
					severity: 'warning',
					kind: 'duplicate-course',
					message: `${pc.code} is already planned in ${earlier}.`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			const pre = evaluate(course.prereq, before);
			if (!pre.satisfied) {
				// An unmet prerequisite is a real conflict. The planner schedules missing
				// prerequisites rather than assuming them away, so anything left here is either a
				// hand edit or a course the student must still place past — both worth flagging.
				issues.push({
					severity: 'error',
					kind: 'prereq-unmet',
					message: `${pc.code} needs ${describe(course.prereq)} beforehand — missing ${unique(pre.missing).join(' or ')}. Add it to the plan, or record it under "Placed past".`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			const preco = evaluate(course.precoreq, withThisTerm);
			if (!preco.satisfied) {
				issues.push({
					severity: 'error',
					kind: 'precoreq-unmet',
					message: `${pc.code} needs ${describe(course.precoreq)} before or alongside it — missing ${unique(preco.missing).join(' or ')}.`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			const co = evaluate(course.coreq, withThisTerm);
			if (!co.satisfied) {
				issues.push({
					severity: 'error',
					kind: 'coreq-unmet',
					message: `${pc.code} must be taken with ${describe(course.coreq)}.`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			// One line per course, not one per clause: a course with three unverifiable
			// conditions is one thing to check with the student, not three conflicts.
			const toConfirm = unique([...pre.notes, ...preco.notes, ...co.notes]).filter(
				(note) =>
					!isRoutineNote(note) &&
					!isUnactionableNote(note) &&
					// The advisor recorded this on the student, e.g. high school chemistry.
					!declared.some((d) => note.toLowerCase().includes(d) || d.includes(note.toLowerCase()))
			);
			if (toConfirm.length) {
				issues.push({
					severity: 'info',
					kind: 'policy',
					message: `${pc.code} assumes ${toConfirm.join('; ')} — confirm with the student.`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			if (course.terms && !course.terms.includes(sem.term)) {
				issues.push({
					severity: 'warning',
					kind: 'term-unavailable',
					message: `${pc.code} is normally offered ${course.terms.join(', ')}, not ${sem.term}.`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			if (course.discontinued) {
				issues.push({
					severity: 'warning',
					kind: 'unknown-course',
					message: `${pc.code} is no longer offered by ODU. Replace it with a current course.`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			if (course.needs_review) {
				issues.push({
					severity: 'info',
					kind: 'needs-review',
					message: `${pc.code} has prerequisites the importer could not fully parse — verify manually.`,
					semesterId: sem.id,
					course: pc.code
				});
			}

			placedIn.set(pc.code, termLabel(sem));
		}

		const cap = sem.term === 'summer' ? settings.summerMaxCredits : settings.maxCreditsPerTerm;
		if (credits > cap) {
			issues.push({
				severity: 'warning',
				kind: 'overload',
				message: `${termLabel(sem)} carries ${credits} credits, above the ${cap}-credit limit.`,
				semesterId: sem.id
			});
		}
		if (sem.term !== 'summer' && credits > 0 && credits < settings.minCreditsPerTerm) {
			issues.push({
				severity: 'info',
				kind: 'underload',
				message: `${termLabel(sem)} carries ${credits} credits, below the ${settings.minCreditsPerTerm}-credit full-time load.`,
				semesterId: sem.id
			});
		}

		for (const code of thisTerm) seen.add(code);
	}

	return issues;
}

/**
 * Notes that are true of nearly every upper-level course and tell an advisor nothing.
 * "Permission of the instructor" is a formality on most physics research and thesis courses;
 * surfacing it per course buries the notes that actually need a decision (program admission,
 * placement tests, background checks).
 */
const ROUTINE_NOTE = /permission of (the )?(instructor|department|the chair)|instructor(['’]s)? permission|departmental approval|approval (of|by) (the )?(instructor|department)/i;

function isRoutineNote(note: string): boolean {
	return ROUTINE_NOTE.test(note);
}

/**
 * Prose that cannot be acted on, so reporting it only crowds out what can.
 *
 * Two kinds show up in the catalog. A recommendation is not a requirement — "CHEM 105N strongly
 * recommended" is advice, and treating it as something to confirm misrepresents it. And a
 * dangling comparative like the "or higher" in "MATH 102M or MATH 103M or higher" says nothing
 * standing alone; the courses it qualifies are already checked.
 */
const UNACTIONABLE_NOTE = /\brecommend/i;
const DANGLING_QUALIFIER = /^(or\s+)?(higher|above|better|equivalent)$/i;

function isUnactionableNote(note: string): boolean {
	return UNACTIONABLE_NOTE.test(note) || DANGLING_QUALIFIER.test(note.trim());
}

function unique<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}
