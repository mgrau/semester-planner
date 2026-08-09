import type { Catalog, NormalizedProgram } from '$lib/types';
import { flatPool } from '$lib/engine/requirements';

/**
 * What role a course plays in the degree, used to color-code the plan.
 *
 * Role beats subject as the organizing idea: an advisor scanning a plan wants to see "this is
 * major coursework, that is general education", and the subject split inside the major
 * (physics / math / lab science) is the secondary cue that makes a term readable at a glance.
 */
export type CourseKind =
	| 'major'
	| 'math'
	| 'science'
	| 'computing'
	| 'gened'
	| 'elective'
	| 'placeholder';

export interface KindStyle {
	/** Left accent stripe — carries the color without fighting the status background. */
	accent: string;
	/** Small swatch for the legend. */
	swatch: string;
	label: string;
}

export const KIND_STYLES: Record<CourseKind, KindStyle> = {
	major: { accent: 'border-l-blue-500', swatch: 'bg-blue-500', label: 'Physics / major' },
	math: { accent: 'border-l-violet-500', swatch: 'bg-violet-500', label: 'Mathematics' },
	science: { accent: 'border-l-emerald-500', swatch: 'bg-emerald-500', label: 'Lab science' },
	computing: { accent: 'border-l-cyan-500', swatch: 'bg-cyan-500', label: 'Computing' },
	gened: { accent: 'border-l-amber-500', swatch: 'bg-amber-500', label: 'General education' },
	elective: { accent: 'border-l-slate-400', swatch: 'bg-slate-400', label: 'Elective' },
	placeholder: {
		accent: 'border-l-slate-300',
		swatch: 'bg-slate-300',
		label: 'Requirement to fill'
	}
};

const MATH_SUBJECTS = new Set(['MATH', 'STAT']);
const SCIENCE_SUBJECTS = new Set(['CHEM', 'BIOL', 'OEAS', 'BIOC']);
const COMPUTING_SUBJECTS = new Set(['CS', 'CYSE', 'DASC', 'ECE', 'ENGN', 'ENMA', 'MAE']);

/**
 * Build a lookup for one program. Precomputed rather than derived per chip, since the gen-ed
 * approved lists run to a few hundred codes.
 */
export function buildKindIndex(
	program: NormalizedProgram | undefined,
	catalog: Catalog
): Map<string, CourseKind> {
	const kinds = new Map<string, CourseKind>();

	const genEdCourses = new Set<string>(catalog.genEd.flatMap((c) => c.approved ?? []));

	// General education first, so a major requirement listing the same course overrides it —
	// a course that is both is doing major work in the plan the advisor is reading.
	for (const code of genEdCourses) kinds.set(code, 'gened');

	for (const req of program?.requirements ?? []) {
		for (const code of [...(req.all_of ?? []), ...flatPool(req)]) {
			kinds.set(code, subjectKind(code, catalog));
		}
	}

	return kinds;
}

function subjectKind(code: string, catalog: Catalog): CourseKind {
	const subject = catalog.courses.get(code)?.subject ?? code.split(' ')[0];
	if (MATH_SUBJECTS.has(subject)) return 'math';
	if (SCIENCE_SUBJECTS.has(subject)) return 'science';
	if (COMPUTING_SUBJECTS.has(subject)) return 'computing';
	return 'major';
}

export function kindOf(
	code: string,
	isPlaceholder: boolean,
	index: Map<string, CourseKind>
): CourseKind {
	if (isPlaceholder) return 'placeholder';
	return index.get(code) ?? 'elective';
}

/** The kinds actually present in a plan, in a stable order, for the legend. */
export function legendFor(kinds: CourseKind[]): CourseKind[] {
	const order: CourseKind[] = [
		'major',
		'math',
		'science',
		'computing',
		'gened',
		'elective',
		'placeholder'
	];
	const present = new Set(kinds);
	return order.filter((k) => present.has(k));
}
