import type {
	Catalog,
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
	category_filters?: Record<string, RequirementFilter & { note?: string }>;
	major_view?: MajorView;
	program_labels?: Record<string, string>;
	requirement_labels?: Record<string, string>;
	starting_preparation?: PreparationOption[];
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
		const { note, ...filter } = f;
		return {
			...c,
			filter,
			notes: [c.notes, note].filter(Boolean).join('\n\n')
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
	if (p?.id) programs.set(p.id, normalizeProgram(p));
}

export const catalog: Catalog = {
	courses: buildCourseIndex(coursesData.courses ?? []),
	genEd: applyCategoryFilters(genEdData.categories ?? []),
	programs,
	catalogYear: coursesData.meta?.catalog_year ?? genEdData.meta?.catalog_year ?? 'unknown'
};

export const allCourses: Course[] = coursesData.courses ?? [];

export const programList: NormalizedProgram[] = [...programs.values()].sort((a, b) =>
	a.name.localeCompare(b.name)
);

export const genEdById = new Map<string, GenEdCategory>(catalog.genEd.map((c) => [c.id, c]));

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
