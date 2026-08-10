import type { Course, GenEdCategory, PriorCredit } from '$lib/types';

/**
 * How a prior-credit record should be presented.
 *
 * Three quite different things share the `PriorCredit` type, and lumping them into one list is
 * what made the panel hard to read:
 *
 * - **coursework** — a course the student holds credit for, which counts toward the 120.
 * - **satisfied** — a requirement met without ODU coursework: a Language and Culture waiver,
 *   or a background condition like high school chemistry. Carries no credit.
 *
 * Placement (`Student.placements`) is a third kind again and lives outside this type entirely,
 * because it satisfies a prerequisite while granting nothing.
 */
export type PriorCreditGroup = 'coursework' | 'satisfied';

export function groupOf(p: PriorCredit): PriorCreditGroup {
	// A record with no course code is a declared condition, not coursework — this is what the
	// starting-preparation checklist produces for "High school chemistry".
	if (p.kind === 'category' || !p.course) return 'satisfied';
	return 'coursework';
}

export interface PriorCreditView {
	name: string;
	/** Secondary line: what it is, or where it came from. */
	detail: string;
	/** Shown on the right; blank when the record carries no credit. */
	credits: string;
}

export function describePriorCredit(
	p: PriorCredit,
	genEd: GenEdCategory[],
	courses: Map<string, Course>
): PriorCreditView {
	if (p.kind === 'category') {
		// A block waiver names itself; a single-category record names the requirement.
		if (p.categories?.length) {
			const n = p.categories.length;
			return {
				name: p.source ?? 'Transfer credit',
				detail: `${n} general education ${n === 1 ? 'category' : 'categories'} waived`,
				credits: ''
			};
		}
		const name = genEd.find((c) => c.id === p.category)?.name ?? p.category ?? 'Requirement';
		return { name, detail: p.source ?? 'Requirement satisfied', credits: '' };
	}

	if (!p.course) {
		// Declared background — named by whatever produced it, never blank.
		return {
			name: p.source ?? 'Declared',
			detail: p.satisfiesNotes?.join('; ') ?? 'Recorded on the student',
			credits: ''
		};
	}

	const detail = [courses.get(p.course)?.title, p.grade ? `grade ${p.grade}` : null, p.source]
		.filter(Boolean)
		.join(' · ');
	return { name: p.course, detail, credits: p.credits ? `${p.credits} cr` : '' };
}

export function courseworkCredits(priorCredits: PriorCredit[]): number {
	return priorCredits
		.filter((p) => groupOf(p) === 'coursework')
		.reduce((sum, p) => sum + p.credits, 0);
}
