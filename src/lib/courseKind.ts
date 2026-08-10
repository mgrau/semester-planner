import type { Catalog } from '$lib/types';

/**
 * What kind of course this is, used to colour-code the plan.
 *
 * Subject decides, not which requirement the course happens to satisfy. A math course is a
 * math course whether it is required by the major, approved for general education, or picked
 * up as a prerequisite — colouring MATH 162M as general education because it appears on the
 * gen-ed math list told the advisor the wrong thing about it.
 *
 * "General education" therefore means the non-technical courses: the humanities, arts and
 * social science that fill those categories.
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
	/** Left accent stripe — carries the colour without fighting the status background. */
	accent: string;
	/** Small swatch for the legend. */
	swatch: string;
	label: string;
}

export const KIND_STYLES: Record<CourseKind, KindStyle> = {
	major: { accent: 'border-l-blue-500', swatch: 'bg-blue-500', label: 'Physics' },
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

/** Subjects whose identity is stronger than the requirement they happen to fill. */
const SUBJECT_KIND: Record<string, CourseKind> = {
	PHYS: 'major',
	ASTP: 'major',

	MATH: 'math',
	STAT: 'math',

	CHEM: 'science',
	BIOL: 'science',
	BIOC: 'science',
	OEAS: 'science',

	CS: 'computing',
	CYSE: 'computing',
	DASC: 'computing',
	ECE: 'computing',
	ENGN: 'computing',
	ENMA: 'computing',
	MAE: 'computing'
};

/**
 * Precomputed for the whole catalog, since the gen-ed approved lists run to a few hundred codes
 * and the lookup happens once per chip. Only non-elective kinds are stored; anything absent is
 * an elective.
 */
export function buildKindIndex(catalog: Catalog): Map<string, CourseKind> {
	const kinds = new Map<string, CourseKind>();
	const genEdCourses = new Set(catalog.genEd.flatMap((c) => c.approved ?? []));

	// Keys include cross-list aliases, so PHYS 525 lands in the same bucket as PHYS 425.
	for (const code of catalog.courses.keys()) {
		const subject = code.split(' ')[0];
		const bySubject = SUBJECT_KIND[subject];
		if (bySubject) kinds.set(code, bySubject);
		else if (genEdCourses.has(code)) kinds.set(code, 'gened');
	}

	// A gen-ed course the catalog lists but has no entry for still deserves its colour.
	for (const code of genEdCourses) {
		if (!kinds.has(code)) kinds.set(code, SUBJECT_KIND[code.split(' ')[0]] ?? 'gened');
	}

	return kinds;
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
