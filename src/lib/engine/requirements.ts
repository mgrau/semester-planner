import type {
	Course,
	GenEdCategory,
	PriorCredit,
	Semester,
	Program,
	Requirement,
	RequirementFilter
} from '$lib/types';

/**
 * Requirement satisfaction, including ODU's double-counting behavior.
 *
 * The model is two independent tracks: major requirements and general education. A course is
 * consumed at most once *within* a track, but may count in both tracks at once — that is
 * exactly what double-counting means (MATH 211 satisfies both the major and the Mathematics
 * gen-ed category). Within a track, assignment is greedy, most-constrained-course-first,
 * which is not provably optimal but matches how an advisor reasons and is stable to explain.
 */

export interface Progress {
	id: string;
	name: string;
	/** Credits (or course count) required. */
	requiredCredits: number;
	earnedCredits: number;
	/**
	 * Credits reserved by placeholder slots in the plan — the requirement has room booked for it
	 * but no course chosen yet. Counted toward `satisfied` so the advisor sees a plan that
	 * accounts for the requirement, and reported separately so "reserved" never reads as "done".
	 */
	plannedCredits: number;
	satisfied: boolean;
	/** Courses assigned to this requirement. */
	assigned: string[];
	/** Still-needed named courses, when the requirement lists specific ones. */
	missing: string[];
	/** Choose-from pool, when the requirement is elective. */
	options?: string[];
	notes?: string;
	/** Optional heading this item sits under, used by the major-requirement view. */
	section?: string;
}

/** A course the student holds or plans to hold, with the credits it carries. */
export interface TakenCourse {
	code: string;
	credits: number;
}

export function creditsOf(course: Course | undefined, fallback = 3): number {
	if (!course) return fallback;
	// Variable-credit courses (PHYS 297 is 1-3) plan at their minimum unless overridden.
	return course.credits?.min ?? fallback;
}

function matchesFilter(course: Course | undefined, f: RequirementFilter): boolean {
	if (!course) return false;
	const level = parseInt(course.number, 10);
	if (f.level_min != null && !(level >= f.level_min)) return false;
	if (f.level_max != null && !(level <= f.level_max)) return false;
	if (f.subject && !f.subject.includes(course.subject)) return false;
	if (f.attributes && !f.attributes.every((a) => course.attributes?.includes(a))) return false;
	return true;
}

/**
 * The pool's choices, each as the set of courses that choice requires.
 * `[["PHYS 499W"], ["PHYS 489W", "PHYS 490W"]]` for a course-or-sequence requirement.
 */
export function poolOptions(req: Requirement): string[][] {
	return (req.one_of ?? []).map((o) => (typeof o === 'string' ? [o] : o.all_of));
}

/** Every course appearing anywhere in the pool, flattened. */
export function flatPool(req: Requirement): string[] {
	return poolOptions(req).flat();
}

/** Does this course belong to the requirement's pool at all? */
function eligible(req: Requirement, code: string, courses: Map<string, Course>): boolean {
	if (req.all_of?.includes(code)) return true;
	// Credits accumulate the same either way: PHYS 489W (1) + PHYS 490W (2) reaches the same 3
	// credits as PHYS 499W, so flattening the sequence is safe for progress accounting. A
	// half-finished sequence correctly reads as partial rather than satisfied.
	if (flatPool(req).includes(code)) return true;
	if (req.filter && matchesFilter(courses.get(code), req.filter)) return true;
	return false;
}

/**
 * Assign taken courses to requirements within a single track.
 * Most-constrained-first: a course that only fits one requirement is placed before a course
 * that fits several, so flexible courses stay available for the pools that need them.
 */
function assignTrack(
	reqs: Requirement[],
	taken: TakenCourse[],
	courses: Map<string, Course>
): Progress[] {
	const progress = new Map<string, Progress>();
	for (const r of reqs) {
		const required =
			r.credits ??
			(r.all_of
				? r.all_of.reduce((s, c) => s + creditsOf(courses.get(c)), 0)
				: (r.count ?? 1) * 3);
		progress.set(r.id, {
			id: r.id,
			name: r.name,
			requiredCredits: required,
			earnedCredits: 0,
			plannedCredits: 0,
			satisfied: false,
			assigned: [],
			missing: [...(r.all_of ?? [])],
			options: flatPool(r),
			notes: r.notes
		});
	}

	// Named (all_of) courses bind first — they are not interchangeable.
	for (const r of reqs) {
		const p = progress.get(r.id)!;
		for (const code of r.all_of ?? []) {
			const t = taken.find((t) => t.code === code);
			if (t) {
				p.assigned.push(code);
				p.earnedCredits += t.credits;
				p.missing = p.missing.filter((m) => m !== code);
			}
		}
	}

	const consumed = new Set([...progress.values()].flatMap((p) => p.assigned));
	const remaining = taken.filter((t) => !consumed.has(t.code));

	// Elective pools: fill most-constrained course first.
	const poolReqs = reqs.filter((r) => r.one_of || r.filter);
	const fitCount = new Map<string, number>();
	for (const t of remaining) {
		fitCount.set(t.code, poolReqs.filter((r) => eligible(r, t.code, courses)).length);
	}
	const ordered = [...remaining].sort(
		(a, b) => (fitCount.get(a.code) ?? 0) - (fitCount.get(b.code) ?? 0)
	);

	for (const t of ordered) {
		if (!fitCount.get(t.code)) continue;
		// Prefer the requirement with the largest unmet gap, so nothing starves.
		const candidates = poolReqs
			.filter((r) => eligible(r, t.code, courses))
			.map((r) => progress.get(r.id)!)
			.filter((p) => p.earnedCredits < p.requiredCredits)
			.sort((a, b) => b.requiredCredits - b.earnedCredits - (a.requiredCredits - a.earnedCredits));
		const target = candidates[0];
		if (target) {
			target.assigned.push(t.code);
			target.earnedCredits += t.credits;
		}
	}

	for (const p of progress.values()) {
		p.satisfied =
			p.earnedCredits + p.plannedCredits >= p.requiredCredits && p.missing.length === 0;
	}
	return [...progress.values()];
}

export function programProgress(
	program: Program,
	taken: TakenCourse[],
	courses: Map<string, Course>
): Progress[] {
	// Requirement groups that merely restate a gen-ed category are handled by the gen-ed
	// track; keeping them here would double-report the same credits to the advisor.
	const reqs = program.requirements.filter((r) => !r.gened_category);
	return assignTrack(reqs, taken, courses);
}

export function genEdProgress(
	categories: GenEdCategory[],
	taken: TakenCourse[],
	courses: Map<string, Course>,
	/** Gen-ed categories satisfied outright by prior credit (e.g. a Language & Culture waiver). */
	satisfiedCategories: Set<string> = new Set(),
	/** Catalog-stated double counts, which admit a course to a category's pool. */
	doubleCounts: { course: string; satisfies: string }[] = [],
	/** Credits reserved by placeholder slots in the plan, keyed by gen-ed category id. */
	reserved: Map<string, number> = new Map()
): Progress[] {
	const extra = new Map<string, string[]>();
	for (const dc of doubleCounts) {
		if (!extra.has(dc.satisfies)) extra.set(dc.satisfies, []);
		extra.get(dc.satisfies)!.push(dc.course);
	}

	const reqs: Requirement[] = categories.map((c) => ({
		id: c.id,
		name: c.name,
		one_of: [...(c.approved ?? []), ...(extra.get(c.id) ?? [])],
		filter: c.filter,
		credits: c.credits,
		notes: c.notes
	}));

	const result = assignTrack(reqs, taken, courses);
	for (const p of result) {
		// A placeholder slot in the plan means the credits are booked but the course is not yet
		// chosen. Only count the shortfall, so a category already covered by real coursework is
		// not pushed past 100% by a leftover slot.
		const slot = reserved.get(p.id) ?? 0;
		if (slot > 0) {
			p.plannedCredits = Math.min(slot, Math.max(0, p.requiredCredits - p.earnedCredits));
		}

		if (satisfiedCategories.has(p.id)) {
			p.satisfied = true;
			p.plannedCredits = 0;
			p.earnedCredits = Math.max(p.earnedCredits, p.requiredCredits);
			p.notes = [p.notes, 'Satisfied by prior credit.'].filter(Boolean).join(' ');
		} else {
			p.satisfied =
				p.earnedCredits + p.plannedCredits >= p.requiredCredits && p.missing.length === 0;
		}
	}
	return result;
}

/** Everything the student holds or plans, as a flat credit list. */
export function takenFrom(
	priorCredits: PriorCredit[],
	planned: { code: string; credits: number }[]
): TakenCourse[] {
	const out = new Map<string, TakenCourse>();
	for (const p of priorCredits) {
		if (p.kind === 'course' && p.course) out.set(p.course, { code: p.course, credits: p.credits });
	}
	for (const c of planned) {
		if (!out.has(c.code)) out.set(c.code, { code: c.code, credits: c.credits });
	}
	return [...out.values()];
}

export function satisfiedCategoriesFrom(priorCredits: PriorCredit[]): Set<string> {
	// A record may name one category or several: a transfer associate degree waives a whole
	// block of them, and is recorded once rather than once per category.
	return new Set(
		priorCredits
			.filter((p) => p.kind === 'category')
			.flatMap((p) => p.categories ?? (p.category ? [p.category] : []))
	);
}

export function totalCredits(taken: TakenCourse[]): number {
	return taken.reduce((s, t) => s + t.credits, 0);
}

/**
 * Credits the plan has booked for a requirement without naming a course yet, per gen-ed
 * category. Feeds both the progress bars and the headline credit count.
 */
export function reservedByCategory(semesters: Semester[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const sem of semesters) {
		for (const c of sem.courses) {
			const cat = c.placeholder?.category;
			if (!cat) continue;
			map.set(cat, (map.get(cat) ?? 0) + c.credits);
		}
	}
	return map;
}

/** Total credits sitting in placeholder slots, whatever requirement they belong to. */
export function reservedCredits(semesters: Semester[]): number {
	return semesters.reduce(
		(sum, sem) => sum + sem.courses.filter((c) => c.placeholder).reduce((s, c) => s + c.credits, 0),
		0
	);
}
