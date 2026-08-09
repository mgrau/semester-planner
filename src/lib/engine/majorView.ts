import type { Catalog, NormalizedProgram, Requirement, RequirementFilter } from '$lib/types';
import { requirementLabel } from '$lib/catalog';
import { creditsOf, flatPool, poolOptions, programProgress, type Progress, type TakenCourse } from './requirements';

/**
 * Regroup a program's major requirements into the shape the department advises in.
 *
 * The catalog gives ~26 flat requirement rows per physics program — "Astrophysics Required
 * Courses" as one 15-course block, then a dozen two-item or-rows. An advisor thinks in terms of
 * "Physics 1 & 2, the 300-levels, the 400-levels, and the supporting courses".
 *
 * This is strictly a *view*: every course a group claims is pulled from the program's own
 * requirements, and any requirement not fully claimed still appears, minus the courses that
 * moved. Nothing is invented and nothing is silently dropped — a course counted here is a
 * course the catalog required.
 */

export interface ViewGroup {
	id: string;
	name: string;
	/** Whole alternatives; the first is the department's preference. */
	sequences?: string[][];
	filter?: RequirementFilter;
	note?: string;
}

export interface MajorView {
	applies_to?: string[];
	groups?: ViewGroup[];
}

function matches(code: string, filter: RequirementFilter, catalog: Catalog): boolean {
	const course = catalog.courses.get(code);
	if (!course) return false;
	const level = parseInt(course.number, 10);
	if (filter.level_min != null && !(level >= filter.level_min)) return false;
	if (filter.level_max != null && !(level <= filter.level_max)) return false;
	if (filter.subject && !filter.subject.includes(course.subject)) return false;
	if (filter.attributes && !filter.attributes.every((a) => course.attributes?.includes(a)))
		return false;
	return true;
}

/** Every course the program requires or offers as a choice. */
function programUniverse(program: NormalizedProgram): string[] {
	const out = new Set<string>();
	for (const req of program.requirements) {
		for (const c of req.all_of ?? []) out.add(c);
		for (const c of flatPool(req)) out.add(c);
	}
	return [...out];
}

/**
 * Courses the program requires outright, excluding anything that is merely an option.
 *
 * Level-based groups must only claim these. Pulling in alternatives would report the road not
 * taken as missing — a plan using PHYS 489W/490W would show PHYS 499W outstanding — and would
 * strip choice requirements ("Select two of the following") of the very options they choose
 * between. Choice pools stay whole, under their own heading.
 */
function requiredCourses(program: NormalizedProgram): string[] {
	const out = new Set<string>();
	for (const req of program.requirements) {
		for (const c of req.all_of ?? []) out.add(c);
	}
	return [...out];
}

function credits(codes: string[], catalog: Catalog): number {
	return codes.reduce((s, c) => s + creditsOf(catalog.courses.get(c)), 0);
}

/**
 * Strip claimed courses out of a requirement. Returns null when nothing is left of it.
 * Explicit credit totals are dropped along with the courses, since the catalog's number
 * described the whole block and no longer applies to the remainder.
 */
function withoutClaimed(req: Requirement, claimed: Set<string>): Requirement | null {
	const allOf = (req.all_of ?? []).filter((c) => !claimed.has(c));
	const options = poolOptions(req).filter((g) => !g.every((c) => claimed.has(c)));

	if (!allOf.length && !options.length && !req.filter) return null;

	const shrank =
		allOf.length !== (req.all_of ?? []).length || options.length !== poolOptions(req).length;

	return {
		...req,
		all_of: allOf.length ? allOf : undefined,
		one_of: options.length ? options.map((g) => (g.length === 1 ? g[0] : { all_of: g })) : undefined,
		credits: shrank ? undefined : req.credits,
		count: shrank ? undefined : req.count
	};
}

export function majorViewProgress(
	program: NormalizedProgram,
	taken: TakenCourse[],
	catalog: Catalog,
	view: MajorView | undefined
): Progress[] {
	const groups = view?.groups ?? [];
	const applies = !view?.applies_to || view.applies_to.includes(program.id);
	if (!applies || !groups.length) return programProgress(program, taken, catalog.courses);

	const held = new Map(taken.map((t) => [t.code, t.credits]));
	const universe = programUniverse(program);
	const required = requiredCourses(program);
	const claimed = new Set<string>();
	const out: Progress[] = [];

	for (const group of groups) {
		if (group.sequences?.length) {
			// Only consider sequences the program actually offers, so a view shared across
			// programs does not invent a requirement for one that lacks it.
			const available = group.sequences.filter((seq) => seq.some((c) => universe.includes(c)));
			if (!available.length) continue;

			for (const seq of group.sequences) for (const c of seq) claimed.add(c);

			const complete = available.find((seq) => seq.every((c) => held.has(c)));
			const partial = available
				.map((seq) => seq.filter((c) => held.has(c)))
				.sort((a, b) => b.length - a.length)[0];
			const assigned = complete ?? partial ?? [];
			const preferred = available[0];

			out.push({
				id: group.id,
				name: group.name,
				requiredCredits: credits(preferred, catalog),
				earnedCredits: credits(assigned, catalog),
				plannedCredits: 0,
				satisfied: Boolean(complete),
				assigned,
				missing: complete ? [] : preferred.filter((c) => !held.has(c)),
				options: available.flat(),
				notes: group.note
			});
			continue;
		}

		if (group.filter) {
			const members = required.filter(
				(c) => !claimed.has(c) && matches(c, group.filter!, catalog)
			);
			if (!members.length) continue;
			for (const c of members) claimed.add(c);

			const have = members.filter((c) => held.has(c));
			out.push({
				id: group.id,
				name: group.name,
				requiredCredits: credits(members, catalog),
				earnedCredits: credits(have, catalog),
				plannedCredits: 0,
				satisfied: have.length === members.length,
				assigned: have,
				missing: members.filter((c) => !held.has(c)),
				notes: group.note
			});
		}
	}

	// Whatever the view did not claim keeps its catalog grouping, so nothing disappears.
	const leftovers = program.requirements
		.map((r) => withoutClaimed(r, claimed))
		.filter((r): r is Requirement => r !== null);

	const rest = programProgress(
		{ ...program, requirements: leftovers },
		taken.filter((t) => !claimed.has(t.code)),
		catalog.courses
	).map((p) => ({
		...p,
		name: requirementLabel(program.id, p.id, p.name),
		section: 'Other requirements'
	}));

	return [...out, ...rest];
}
