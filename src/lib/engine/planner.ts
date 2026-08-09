import type {
	Catalog,
	Course,
	GenEdCategory,
	NormalizedProgram,
	PlannedCourse,
	PlannerSettings,
	Semester,
	Student,
	Term
} from '$lib/types';
import { coursesIn, evaluate, minimalAdditions, type CreditState } from './expr';
import { creditsOf, poolOptions, satisfiedCategoriesFrom } from './requirements';
import { sortSemesters } from './validate';
import { avoidedCourses, preferredCourses } from '$lib/catalog';

/**
 * Greedy critical-path planner.
 *
 * The heuristic the department actually uses — "take math until you can start physics, then
 * take physics" — falls out of critical-path scheduling: schedule first the course with the
 * longest chain of dependents still ahead of it. MATH 211 has the whole physics sequence
 * behind it, so it sorts to the front without being special-cased.
 *
 * Deliberate choice: named major requirements are placed as concrete courses, but open
 * gen-ed categories are placed as PLACEHOLDERS. The planner knows a student needs 3 credits
 * of Human Creativity; it does not know they want ARTH 121A. Guessing there would produce a
 * plan an advisor has to undo. Placeholders keep the credit accounting honest and leave the
 * choice where it belongs.
 */

export interface PlanRequest {
	program: NormalizedProgram;
	catalog: Catalog;
	settings: PlannerSettings;
	startTerm: Term;
	startYear: number;
	priorCredits: Student['priorCredits'];
	/** Courses already declared as placement, which satisfy prerequisites without credit. */
	placements?: string[];
	/** Courses the advisor has already placed and locked; the planner works around them. */
	locked?: Semester[];
}

export interface PlanResult {
	semesters: Semester[];
	/** Requirements the planner could not place within the target horizon. */
	unplaced: { code: string; reason: string }[];
	notes: string[];
}

function nextTerm(term: Term, year: number, includeSummers: boolean): { term: Term; year: number } {
	if (term === 'fall') return { term: 'spring', year: year + 1 };
	if (term === 'spring') return includeSummers ? { term: 'summer', year } : { term: 'fall', year };
	return { term: 'fall', year };
}

/** Longest chain of still-needed courses that depends on this one. */
function criticalPath(code: string, needed: Set<string>, courses: Map<string, Course>): number {
	const memo = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const c of needed) {
		const course = courses.get(c);
		if (!course) continue;
		for (const p of new Set([...coursesIn(course.prereq), ...coursesIn(course.precoreq)])) {
			if (!dependents.has(p)) dependents.set(p, []);
			dependents.get(p)!.push(c);
		}
	}
	const walk = (c: string, stack: Set<string>): number => {
		if (memo.has(c)) return memo.get(c)!;
		if (stack.has(c)) return 0; // defensive: catalogs occasionally contain cycles
		stack.add(c);
		const kids = (dependents.get(c) ?? []).filter((k) => needed.has(k));
		const depth = kids.length ? 1 + Math.max(...kids.map((k) => walk(k, stack))) : 0;
		stack.delete(c);
		memo.set(c, depth);
		return depth;
	};
	return walk(code, new Set());
}

/**
 * Courses named in the catalog's own recommended sequence. When a requirement offers a
 * choice, this is the department's answer to "which one?" — PHYS 261N rather than PHYS 231N
 * for the physics majors — so it beats any tiebreak we could invent.
 */
function planOfStudyPreference(program: NormalizedProgram): Set<string> {
	const out = new Set<string>();
	for (const term of program.plan_of_study ?? []) {
		for (const item of term.items ?? []) {
			if (item.course) out.add(item.course);
			for (const c of item.one_of ?? []) out.add(c);
		}
	}
	return out;
}

function optionCredits(group: string[], catalog: Catalog): number {
	return group.reduce((s, c) => s + creditsOf(catalog.courses.get(c)), 0);
}

/**
 * Rank one choice in a requirement pool. Lower is better.
 *
 * The department's own advising practice (data/local/preferences.yaml) outranks the catalog's
 * recommended sequence — ODU Physics steers students to the two-semester PHYS 489W/490W thesis
 * over the one-semester PHYS 499W, which the catalog lists first.
 */
function rankOption(group: string[], preferred: Set<string>): number {
	if (group.some((c) => preferredCourses.has(c))) return 0;
	if (group.some((c) => avoidedCourses.has(c))) return 3;
	if (group.every((c) => preferred.has(c))) return 1;
	return 2;
}

/** Concrete courses the program still requires by name, prerequisites included. */
function neededCourses(
	program: NormalizedProgram,
	held: Set<string>,
	catalog: Catalog
): string[] {
	const out = new Set<string>();
	const preferred = planOfStudyPreference(program);

	for (const req of program.requirements) {
		for (const code of req.all_of ?? []) {
			if (!held.has(code)) out.add(code);
		}

		// Choice requirements ("MATH 312 or MATH 285", "PHYS 499W or PHYS 489W & PHYS 490W",
		// "Select two of the following") need a concrete pick, or the plan silently omits most
		// of the physics major. Options are chosen as whole groups so a two-course sequence is
		// never half-scheduled.
		const options = poolOptions(req).filter((g) => g.every((c) => catalog.courses.has(c)));
		if (!options.length) continue;

		const satisfiedOptions = options.filter((g) => g.every((c) => held.has(c))).length;
		const perOption = optionCredits(options[0], catalog);
		const needCount =
			req.count ?? Math.max(1, Math.ceil((req.credits ?? perOption) / Math.max(1, perOption)));
		let short = needCount - satisfiedOptions;
		if (short <= 0) continue;

		const candidates = options
			.filter((g) => !g.every((c) => held.has(c)))
			.sort((a, b) => rankOption(a, preferred) - rankOption(b, preferred));

		for (const group of candidates) {
			if (short <= 0) break;
			if (group.every((c) => out.has(c))) continue;
			for (const c of group) out.add(c);
			short--;
		}
	}
	// Pull in every unmet prerequisite, recursively.
	//
	// A student who is not ready for Calculus I genuinely has to take precalculus, and the plan
	// should say so rather than quietly assume it away. Where the student *has* placed past a
	// course, that is declared on the student (`placements`) and seeded into `held` before this
	// runs, so nothing gets scheduled twice. Chains terminate on their own: MATH 162M's
	// prerequisite is a placement score, not another course.
	let changed = true;
	let guard = 0;
	while (changed && guard++ < 50) {
		changed = false;
		for (const code of [...out]) {
			const course = catalog.courses.get(code);
			if (!course) continue;
			const state: CreditState = { completed: new Set([...held, ...out]) };

			for (const expr of [course.prereq, course.precoreq]) {
				// One branch per `one_of`, not every alternative — otherwise a plan picks up
				// ENGL 211C *and* ENGL 231C to satisfy a single "or" clause.
				const missing = minimalAdditions(expr, state, preferred).filter((d) =>
					catalog.courses.has(d)
				);
				for (const dep of missing) {
					if (!out.has(dep)) {
						out.add(dep);
						changed = true;
					}
				}
			}
		}
	}
	return [...out];
}

/**
 * For one_of prerequisites, only one alternative is truly needed. Prune the pulled-in set so
 * we do not schedule PHYS 231N *and* PHYS 226N *and* PHYS 261N to satisfy a single clause.
 */
function pruneAlternatives(
	needed: Set<string>,
	program: NormalizedProgram,
	catalog: Catalog,
	held: Set<string>
): void {
	const required = new Set(program.requirements.flatMap((r) => r.all_of ?? []));
	for (const code of [...needed]) {
		const course = catalog.courses.get(code);
		if (!course) continue;
		for (const expr of [course.prereq, course.precoreq]) {
			if (!expr || !('one_of' in expr)) continue;
			const alts = coursesIn(expr).filter((a) => needed.has(a) && !required.has(a));
			if (alts.length <= 1) continue;
			// Keep the alternative already satisfied, else the one with the lightest load.
			const keep =
				alts.find((a) => held.has(a)) ??
				alts.sort(
					(a, b) => creditsOf(catalog.courses.get(a)) - creditsOf(catalog.courses.get(b))
				)[0];
			for (const a of alts) if (a !== keep) needed.delete(a);
		}
	}
}

function offeredIn(course: Course | undefined, term: Term): boolean {
	if (!course?.terms) return true; // catalog silent → assume available
	return course.terms.includes(term);
}

/** Gen-ed categories still owed, as placeholder slots. */
function genEdSlots(
	categories: GenEdCategory[],
	held: Set<string>,
	satisfiedCats: Set<string>,
	program: NormalizedProgram,
	catalog: Catalog
): { category: string; label: string; credits: number }[] {
	const doubles = new Map<string, string>();
	for (const dc of program.courseDoubleCounts ?? []) doubles.set(dc.course, dc.satisfies);

	const slots: { category: string; label: string; credits: number }[] = [];
	for (const cat of categories) {
		if (satisfiedCats.has(cat.id) || !cat.credits) continue;

		const approved = new Set(cat.approved ?? []);
		/**
		 * Does this course land in the category? Includes rule-based categories — Writing
		 * Intensive is any W course, so PHYS 489W/490W cover it and no slot should be reserved.
		 */
		const covers = (code: string) => {
			if (approved.has(code) || doubles.get(code) === cat.id) return true;
			if (!cat.filter) return false;
			const c = catalog.courses.get(code);
			if (!c) return false;
			const level = parseInt(c.number, 10);
			if (cat.filter.level_min != null && !(level >= cat.filter.level_min)) return false;
			if (cat.filter.subject && !cat.filter.subject.includes(c.subject)) return false;
			if (cat.filter.attributes && !cat.filter.attributes.every((a) => c.attributes?.includes(a)))
				return false;
			return true;
		};

		// Count real credits, not a flat 3 per course — a 1-credit W course covers 1 credit.
		let owed = cat.credits;
		for (const code of held) {
			if (covers(code)) owed -= creditsOf(catalog.courses.get(code));
		}
		// Major courses the catalog says cover this category, which the plan will take anyway.
		for (const [course, catId] of doubles) {
			if (catId === cat.id && !held.has(course)) owed -= creditsOf(catalog.courses.get(course));
		}

		while (owed > 0) {
			const chunk = Math.min(owed, 4);
			slots.push({ category: cat.id, label: cat.name, credits: chunk === 4 ? 4 : 3 });
			owed -= chunk;
		}
	}
	return slots;
}

export function generatePlan(req: PlanRequest): PlanResult {
	const { program, catalog, settings } = req;
	const notes: string[] = [];
	const unplaced: { code: string; reason: string }[] = [];

	const held = new Set([
		...req.priorCredits.filter((p) => p.kind === 'course' && p.course).map((p) => p.course!),
		...(req.placements ?? [])
	]);
	const grades = new Map(
		req.priorCredits
			.filter((p) => p.kind === 'course' && p.course && p.grade)
			.map((p) => [p.course!, p.grade!])
	);
	const satisfiedCats = new Set([
		...satisfiedCategoriesFrom(req.priorCredits),
		...(program.categoriesSatisfiedByMajor ?? [])
	]);

	// Courses already locked into terms by the advisor stay put.
	const lockedByTerm = new Map<string, PlannedCourse[]>();
	for (const sem of req.locked ?? []) {
		const keep = sem.courses.filter((c) => c.locked);
		if (keep.length) lockedByTerm.set(`${sem.term}-${sem.year}`, keep);
	}
	const lockedCodes = new Set(
		[...lockedByTerm.values()].flat().map((c) => c.code)
	);

	const needed = new Set(neededCourses(program, held, catalog));
	pruneAlternatives(needed, program, catalog, held);
	for (const c of lockedCodes) needed.delete(c);

	const depth = new Map<string, number>();
	for (const c of needed) depth.set(c, criticalPath(c, needed, catalog.courses));

	const slots = genEdSlots(
		catalog.genEd,
		new Set([...held, ...needed]),
		satisfiedCats,
		program,
		catalog
	);

	const semesters: Semester[] = [];
	const completed: Set<string> = new Set(held);
	let { term, year } = { term: req.startTerm, year: req.startYear };
	const termsPerYear = settings.includeSummers ? 3 : 2;
	const targetTermCount = settings.targetYears * termsPerYear;
	// Allow overrun past the target so an infeasible plan is shown honestly rather than truncated.
	const maxTerms = targetTermCount + 4;
	let guard = 0;

	while ((needed.size > 0 || slots.length > 0) && guard++ < maxTerms) {
		const id = `${term}-${year}`;
		const planned: PlannedCourse[] = [...(lockedByTerm.get(id) ?? [])];
		let credits = planned.reduce((s, c) => s + c.credits, 0);
		const cap = term === 'summer' ? settings.summerMaxCredits : settings.maxCreditsPerTerm;

		const before: CreditState = { completed: new Set(completed), grades };

		// Eligible now, hardest-blocking first.
		const eligible = [...needed]
			.filter((code) => {
				const course = catalog.courses.get(code);
				if (!course) return false;
				if (!offeredIn(course, term)) return false;
				return evaluate(course.prereq, before).satisfied;
			})
			.sort((a, b) => {
				const d = (depth.get(b) ?? 0) - (depth.get(a) ?? 0);
				if (d !== 0) return d;
				return parseInt(a.replace(/\D+/g, ''), 10) - parseInt(b.replace(/\D+/g, ''), 10);
			});

		// Leave room for general education instead of front-loading the major and stranding
		// every gen-ed slot in extra years at the end. Spread the remaining gen-ed credits over
		// the terms remaining in the target horizon.
		const termsLeftInTarget = Math.max(1, targetTermCount - semesters.length);
		const genEdCreditsLeft = slots.reduce((s, x) => s + x.credits, 0);
		const genEdReserve = Math.min(
			Math.max(0, cap - 4),
			Math.ceil(genEdCreditsLeft / termsLeftInTarget)
		);
		const majorCap = Math.max(4, cap - genEdReserve);

		for (const code of eligible) {
			if (!needed.has(code)) continue; // already placed as someone's corequisite partner
			const course = catalog.courses.get(code)!;

			// Strict corequisites must land in the same term. Mutually-corequisite pairs
			// (CHEM 121N lecture + CHEM 122N lab) each block the other, so they are placed as a
			// unit rather than one at a time.
			const group: string[] = [code];
			const trial = new Set([...completed, ...planned.map((p) => p.code), code]);
			let coreqOk = evaluate(course.coreq, { completed: trial, grades }).satisfied;

			if (!coreqOk) {
				for (const partner of minimalAdditions(course.coreq, { completed: trial, grades })) {
					const pc = catalog.courses.get(partner);
					if (!pc || !needed.has(partner) || !offeredIn(pc, term)) continue;
					if (!evaluate(pc.prereq, before).satisfied) continue;
					group.push(partner);
					trial.add(partner);
					if (evaluate(course.coreq, { completed: trial, grades }).satisfied) {
						coreqOk = true;
						break;
					}
				}
			}
			if (!coreqOk) continue;

			const groupCredits = group.reduce((s, c) => s + creditsOf(catalog.courses.get(c)), 0);
			if (credits + groupCredits > majorCap) continue;

			// Every member's own pre-or-corequisites must hold given the whole group.
			const groupState: CreditState = { completed: trial, grades };
			if (group.some((c) => !evaluate(catalog.courses.get(c)!.precoreq, groupState).satisfied))
				continue;
			if (group.some((c) => !evaluate(catalog.courses.get(c)!.coreq, groupState).satisfied))
				continue;

			for (const c of group) {
				planned.push({ code: c, credits: creditsOf(catalog.courses.get(c)), auto: true });
				needed.delete(c);
			}
			credits += groupCredits;
		}

		// Backfill with gen-ed placeholders.
		while (slots.length && credits + slots[0].credits <= cap) {
			const slot = slots.shift()!;
			planned.push({
				code: `placeholder:${slot.category}:${semesters.length}`,
				placeholder: { label: slot.label, category: slot.category },
				credits: slot.credits,
				auto: true
			});
			credits += slot.credits;
		}

		if (planned.length) {
			semesters.push({ id, term, year, courses: planned });
			for (const p of planned) if (!p.placeholder) completed.add(p.code);
		} else if (needed.size > 0) {
			// Nothing could be placed — everything left is gated behind a term restriction.
			semesters.push({ id, term, year, courses: [] });
		}

		({ term, year } = nextTerm(term, year, settings.includeSummers));
	}

	for (const code of needed) {
		const course = catalog.courses.get(code);
		unplaced.push({
			code,
			reason: course
				? 'Could not be scheduled within the planning horizon — check prerequisites and term offerings.'
				: 'Not found in the catalog.'
		});
	}
	for (const slot of slots) {
		unplaced.push({ code: slot.label, reason: 'No room left in the planning horizon.' });
	}

	const yearsUsed = semesters.filter((s) => s.term !== 'summer').length / 2;
	if (yearsUsed > settings.targetYears) {
		notes.push(
			`This plan spans ${yearsUsed.toFixed(1)} years of fall/spring terms, past the ${settings.targetYears}-year target. Consider summer terms or a higher credit cap.`
		);
	}

	return { semesters: sortSemesters(semesters), unplaced, notes };
}
