import type { Expr, Grade } from '$lib/types';

/** Grade ordering for "C or better" style minimums. */
const GRADE_RANK: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1 };

export function meetsGrade(earned: Grade | undefined, required: Grade | undefined): boolean {
	if (!required) return true;
	// An unrecorded grade is assumed passing — advisors plan before grades exist.
	if (!earned) return true;
	return GRADE_RANK[earned] >= GRADE_RANK[required];
}

/**
 * What the student has completed at the point we are evaluating against.
 * `grades` is optional and only consulted for min-grade clauses.
 */
export interface CreditState {
	completed: Set<string>;
	grades?: Map<string, Grade>;
}

export interface EvalResult {
	satisfied: boolean;
	/** Courses that would satisfy the shortfall, best-effort, for UI hints. */
	missing: string[];
	/** Clauses we could not decide mechanically (permission of instructor, placement). */
	notes: string[];
}

export function isCourseLeaf(e: Expr): e is { course: string; min_grade?: Grade } {
	return 'course' in e;
}

/**
 * Evaluate a prerequisite expression against completed credit.
 *
 * Unresolvable clauses (`note`, `placement`) evaluate as SATISFIED but are surfaced in
 * `notes`. Blocking a plan on "permission of the instructor" would make the tool useless
 * to an advisor; flagging it for a human to confirm is the useful behavior.
 */
export function evaluate(expr: Expr | null | undefined, state: CreditState): EvalResult {
	if (!expr) return { satisfied: true, missing: [], notes: [] };

	if (isCourseLeaf(expr)) {
		const has = state.completed.has(expr.course);
		const gradeOk = has && meetsGrade(state.grades?.get(expr.course), expr.min_grade);
		return {
			satisfied: has && gradeOk,
			missing: has && gradeOk ? [] : [expr.course],
			notes: []
		};
	}

	if ('note' in expr) return { satisfied: true, missing: [], notes: [expr.note] };
	if ('placement' in expr) return { satisfied: true, missing: [], notes: [expr.placement] };

	if ('all_of' in expr) {
		const parts = expr.all_of.map((e) => evaluate(e, state));
		return {
			satisfied: parts.every((p) => p.satisfied),
			missing: parts.flatMap((p) => p.missing),
			notes: parts.flatMap((p) => p.notes)
		};
	}

	if ('one_of' in expr) {
		const parts = expr.one_of.map((e) => evaluate(e, state));
		const satisfied = parts.some((p) => p.satisfied);
		return {
			satisfied,
			// Any one of the alternatives closes the gap; show them all as options.
			missing: satisfied ? [] : parts.flatMap((p) => p.missing),
			notes: parts.flatMap((p) => p.notes)
		};
	}

	if ('n_of' in expr) {
		const parts = expr.n_of.options.map((e) => evaluate(e, state));
		const met = parts.filter((p) => p.satisfied).length;
		return {
			satisfied: met >= expr.n_of.n,
			missing: met >= expr.n_of.n ? [] : parts.filter((p) => !p.satisfied).flatMap((p) => p.missing),
			notes: parts.flatMap((p) => p.notes)
		};
	}

	return { satisfied: true, missing: [], notes: [] };
}

/**
 * The smallest set of courses that would satisfy `expr` given what is already completed.
 *
 * Unlike `evaluate().missing`, which reports every alternative as a hint for the UI, this
 * commits to ONE branch of each `one_of`. The planner needs a decision, not a menu: reporting
 * all three of PHYS 231N / 226N / 261N as "needed" would schedule all three.
 *
 * `prefer` breaks ties — pass the catalog's recommended sequence so the department's own
 * choice wins over an arbitrary one.
 */
export function minimalAdditions(
	expr: Expr | null | undefined,
	state: CreditState,
	prefer: Set<string> = new Set()
): string[] {
	if (!expr) return [];
	if (evaluate(expr, state).satisfied) return [];

	if (isCourseLeaf(expr)) return [expr.course];
	if ('note' in expr || 'placement' in expr) return [];

	if ('all_of' in expr) {
		return unique(expr.all_of.flatMap((e) => minimalAdditions(e, state, prefer)));
	}

	if ('one_of' in expr) {
		const options = expr.one_of
			.map((e) => minimalAdditions(e, state, prefer))
			.sort((a, b) => cost(a, prefer) - cost(b, prefer));
		return options[0] ?? [];
	}

	if ('n_of' in expr) {
		const met = expr.n_of.options.filter((e) => evaluate(e, state).satisfied).length;
		const still = Math.max(0, expr.n_of.n - met);
		const options = expr.n_of.options
			.filter((e) => !evaluate(e, state).satisfied)
			.map((e) => minimalAdditions(e, state, prefer))
			.sort((a, b) => cost(a, prefer) - cost(b, prefer));
		return unique(options.slice(0, still).flat());
	}

	return [];
}

/** Fewer courses is cheaper; preferred courses are cheaper still. */
function cost(courses: string[], prefer: Set<string>): number {
	return courses.length * 10 - courses.filter((c) => prefer.has(c)).length;
}

function unique(xs: string[]): string[] {
	return [...new Set(xs)];
}

/** Every course code mentioned anywhere in an expression. Used to build the prereq graph. */
export function coursesIn(expr: Expr | null | undefined): string[] {
	if (!expr) return [];
	if (isCourseLeaf(expr)) return [expr.course];
	if ('note' in expr || 'placement' in expr) return [];
	if ('all_of' in expr) return expr.all_of.flatMap(coursesIn);
	if ('one_of' in expr) return expr.one_of.flatMap(coursesIn);
	if ('n_of' in expr) return expr.n_of.options.flatMap(coursesIn);
	return [];
}

/** Render an expression as readable English, for tooltips and the issue list. */
export function describe(expr: Expr | null | undefined): string {
	if (!expr) return '';
	if (isCourseLeaf(expr)) {
		return expr.min_grade ? `${expr.course} (${expr.min_grade} or better)` : expr.course;
	}
	if ('note' in expr) return expr.note;
	if ('placement' in expr) return expr.placement;
	if ('all_of' in expr) return expr.all_of.map(wrap).join(' and ');
	if ('one_of' in expr) return expr.one_of.map(wrap).join(' or ');
	if ('n_of' in expr) return `${expr.n_of.n} of: ${expr.n_of.options.map(describe).join(', ')}`;
	return '';
}

function wrap(e: Expr): string {
	const inner = describe(e);
	const compound = !isCourseLeaf(e) && ('all_of' in e || 'one_of' in e);
	return compound ? `(${inner})` : inner;
}
