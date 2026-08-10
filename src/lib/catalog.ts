import type {
	Catalog,
	Expr,
	Term,
	Course,
	GenEdCategory,
	PriorCredit as PriorCreditSeed,
	Program,
	RequirementFilter
} from '$lib/types';
import { normalizeProgram, type NormalizedProgram } from '$lib/normalize';
import type { MajorView } from '$lib/engine/majorView';
import coursesDoc from '../../data/courses.yaml';
import genEdDoc from '../../data/gened.yaml';
import preferencesDoc from '../../data/local/preferences.yaml';

/** Every file in data/programs/ becomes a selectable degree program. */
const programDocs = import.meta.glob<{ default: { program: Program } }>(
	'../../data/programs/*.yaml',
	{ eager: true }
);

interface CoursesDoc {
	meta?: { catalog_year?: string };
	courses: Course[];
}
interface GenEdDoc {
	meta?: { catalog_year?: string };
	categories: GenEdCategory[];
}

interface PreferencesDoc {
	prefer?: string[];
	avoid?: string[];
	category_filters?: Record<string, RequirementFilter & { note?: string; credits?: number }>;
	major_view?: MajorView;
	program_labels?: Record<string, string>;
	requirement_labels?: Record<string, string>;
	starting_preparation?: PreparationOption[];
	earliest_year?: Record<string, number>;
	term_offerings?: Record<string, Term[]>;
	discontinued?: string[];
	taken_together?: string[][];
	associate_degree?: { label?: string; excludes?: string[] };
	major_satisfies_gened?: Record<string, string[]>;
}

/** A checkbox offered when creating a student: what they already bring with them. */
export interface PreparationGrant {
	course?: string;
	credits?: number;
	/** Satisfies this course as a prerequisite without awarding credit. */
	places_past?: string;
	satisfies?: string;
	/** Marks a gen-ed category satisfied outright, e.g. a Language and Culture waiver. */
	satisfies_category?: string;
}

export interface PreparationOption {
	id: string;
	label: string;
	/** Heading this option is listed under. */
	group?: string;
	detail?: string;
	default?: boolean;
	grants?: PreparationGrant[];
}

const coursesData = coursesDoc as unknown as CoursesDoc;
const genEdData = genEdDoc as unknown as GenEdDoc;

/** Hand-maintained departmental advising preferences. See data/local/preferences.yaml. */
export const preferences = (preferencesDoc ?? {}) as PreferencesDoc;

export const preferredCourses = new Set(preferences.prefer ?? []);
export const avoidedCourses = new Set(preferences.avoid ?? []);

/**
 * Earliest year of study a course may be scheduled in, by course code. Encodes class standing,
 * which the catalog's prerequisites do not capture.
 */
export const earliestYear = new Map<string, number>(
	Object.entries(preferences.earliest_year ?? {})
);

/** Entry conditions offered when creating a student. See data/local/preferences.yaml. */
export const startingPreparation: PreparationOption[] = preferences.starting_preparation ?? [];

/**
 * Turn the ticked preparation options into prior-credit records.
 * Zero-credit grants record a placement: the prerequisite is met, but nothing counts toward
 * the 120 credits.
 */
export function preparationToRecords(
	ids: Iterable<string>,
	newId: () => string
): { priorCredits: PriorCreditSeed[]; placements: string[] } {
	const chosen = new Set(ids);
	const priorCredits: PriorCreditSeed[] = [];
	const placements: string[] = [];

	for (const option of startingPreparation) {
		if (!chosen.has(option.id)) continue;
		const grants = option.grants ?? [];
		const notes = grants.map((g) => g.satisfies).filter((n): n is string => Boolean(n));

		for (const g of grants) {
			if (g.places_past) placements.push(g.places_past);
			if (g.satisfies_category) {
				priorCredits.push({
					id: newId(),
					kind: 'category',
					category: g.satisfies_category,
					credits: 0,
					source: option.label,
					preparationId: option.id
				});
			}
		}

		const courses = grants.filter((g) => g.course);
		for (const g of courses) {
			priorCredits.push({
				id: newId(),
				kind: 'course',
				course: g.course!,
				credits: g.credits ?? 0,
				source: option.label,
				preparationId: option.id,
				satisfiesNotes: notes.length ? notes : undefined
			});
		}

		// Options that only answer prerequisite prose still need a record, so the advisor can
		// see and undo what was declared.
		if (!courses.length && notes.length) {
			priorCredits.push({
				id: newId(),
				kind: 'course',
				credits: 0,
				source: option.label,
				preparationId: option.id,
				satisfiesNotes: notes
			});
		}
	}
	return { priorCredits, placements: [...new Set(placements)] };
}

/** How to regroup major requirements for presentation. See data/local/preferences.yaml. */
export const majorView: MajorView | undefined = preferences.major_view;

/**
 * Readable name for a requirement group, overriding the catalog's own row label.
 * A program-specific key wins over a bare requirement id.
 */
export function requirementLabel(
	programId: string | undefined,
	requirementId: string,
	fallback: string
): string {
	const labels = preferences.requirement_labels ?? {};
	return labels[`${programId}:${requirementId}`] ?? labels[requirementId] ?? fallback;
}

/**
 * Short, advisor-facing program name. Falls back to trimming the catalog's official name,
 * which is long and leads with the department rather than what distinguishes the major.
 */
export function programLabel(programId: string | undefined): string {
	if (!programId) return '';
	const configured = preferences.program_labels?.[programId];
	if (configured) return configured;
	const name = programs.get(programId)?.name;
	if (!name) return programId;
	return name
		.replace(/^Physics with a Major in\s+/i, '')
		.replace(/\s*\((BS|BA|BSEE|MBA)[^)]*\)\s*$/i, '')
		.trim();
}

/**
 * Apply rule-based satisfaction to gen-ed categories the catalog states as prose. The Writing
 * Intensive requirement lists no courses because W is a per-course attribute, not a list.
 */
function applyCategoryFilters(categories: GenEdCategory[]): GenEdCategory[] {
	const filters = preferences.category_filters ?? {};
	return categories.map((c) => {
		const f = filters[c.id];
		if (!f) return c;
		const { note, credits, ...filter } = f;
		return {
			...c,
			// A filter is optional: some entries only pin down the credit count, for a category
			// the catalog states as a choice of options rather than a single number.
			...(Object.keys(filter).length ? { filter } : {}),
			...(credits != null ? { credits } : {}),
			notes: [c.notes, note].filter(Boolean).join('\n\n')
		};
	});
}

/**
 * Apply the hand-recorded corrections in data/local/preferences.yaml over what the catalog says.
 *
 * Three kinds, all filling gaps the catalog leaves rather than contradicting it:
 *
 * - **Term availability.** The catalog names a term for only a handful of courses, and a course
 *   with no stated term is treated as available every term — so a fall-only course would
 *   silently be schedulable in the spring.
 * - **Discontinued courses**, which stay nameable but must never be scheduled.
 * - **Courses taken together.** A lecture/lab pair the catalog links only loosely becomes a
 *   mutual corequisite, so the planner places them as a unit and a split plan is flagged.
 */
function applyLocalOverrides(courses: Course[]): Course[] {
	const terms = preferences.term_offerings ?? {};
	const retired = new Set(preferences.discontinued ?? []);

	/** course -> the others it must share a term with */
	const partners = new Map<string, string[]>();
	for (const group of preferences.taken_together ?? []) {
		for (const code of group) {
			partners.set(code, [...(partners.get(code) ?? []), ...group.filter((c) => c !== code)]);
		}
	}

	if (!Object.keys(terms).length && !retired.size && !partners.size) return courses;

	return courses.map((c) => {
		const withPartners = partners.get(c.code);
		if (!terms[c.code] && !retired.has(c.code) && !withPartners) return c;

		// Add to any corequisite the catalog already states rather than replacing it.
		const required: Expr[] = (withPartners ?? []).map((course) => ({ course }));
		const coreq = withPartners?.length
			? c.coreq
				? ({ all_of: [c.coreq, ...required] } as Expr)
				: required.length === 1
					? required[0]
					: ({ all_of: required } as Expr)
			: c.coreq;

		return {
			...c,
			...(terms[c.code] ? { terms: terms[c.code] } : {}),
			...(retired.has(c.code) ? { discontinued: true } : {}),
			...(withPartners?.length ? { coreq } : {})
		};
	});
}

function buildCourseIndex(courses: Course[]): Map<string, Course> {
	const map = new Map<string, Course>();
	for (const c of courses) {
		map.set(c.code, c);
		// Cross-listed courses (PHYS 425/525) are reachable under either code.
		for (const alias of c.crosslist ?? []) {
			if (!map.has(alias)) map.set(alias, c);
		}
	}
	return map;
}

const programs = new Map<string, NormalizedProgram>();
for (const mod of Object.values(programDocs)) {
	const p = (mod as { default: { program: Program } }).default?.program;
	if (p?.id) programs.set(p.id, normalizeProgram(p, preferences.major_satisfies_gened ?? {}));
}

export const allCourses: Course[] = applyLocalOverrides(coursesData.courses ?? []);

export const catalog: Catalog = {
	courses: buildCourseIndex(allCourses),
	genEd: applyCategoryFilters(genEdData.categories ?? []),
	programs,
	catalogYear: coursesData.meta?.catalog_year ?? genEdData.meta?.catalog_year ?? 'unknown'
};

export const programList: NormalizedProgram[] = [...programs.values()].sort((a, b) =>
	a.name.localeCompare(b.name)
);

export const genEdById = new Map<string, GenEdCategory>(catalog.genEd.map((c) => [c.id, c]));

/**
 * The categories a transfer associate degree covers.
 *
 * Lower-division only — the upper-division block (the writing-intensive course in the major,
 * and upper-division study outside it) is taken at ODU whatever a student transfers in — minus
 * whatever data/local/preferences.yaml excludes, which is the undergraduate writing program.
 */
export const associateDegreeLabel =
	preferences.associate_degree?.label ?? 'Associate degree (transfer)';

export const associateDegreeCategories: GenEdCategory[] = catalog.genEd.filter(
	(c) =>
		!/upper-division/i.test(c.group ?? '') &&
		!(preferences.associate_degree?.excludes ?? []).includes(c.id)
);

/** Substring search over code and title, for the catalog picker. */
export function searchCourses(query: string, limit = 40): Course[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const normalized = q.replace(/\s+/g, ' ');
	const scored: { c: Course; score: number }[] = [];
	for (const c of allCourses) {
		const code = c.code.toLowerCase();
		const title = c.title.toLowerCase();
		let score = -1;
		if (code === normalized) score = 0;
		else if (code.startsWith(normalized)) score = 1;
		else if (code.replace(/\s/g, '').startsWith(normalized.replace(/\s/g, ''))) score = 2;
		else if (title.startsWith(normalized)) score = 3;
		else if (title.includes(normalized)) score = 4;
		else if (code.includes(normalized)) score = 5;
		if (score >= 0) scored.push({ c, score });
	}
	scored.sort((a, b) => a.score - b.score || a.c.code.localeCompare(b.c.code));
	return scored.slice(0, limit).map((s) => s.c);
}
