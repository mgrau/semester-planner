import type { NormalizedProgram, Program, Requirement } from '$lib/types';

export type { NormalizedProgram };

/**
 * Reconcile the scraped catalog data with what the engine needs.
 *
 * The scrapers deliberately stay faithful to the catalog's own wording and shape, which means
 * a few things arrive in forms the engine cannot consume directly. Normalizing here — rather
 * than making the scrape lossy — keeps data/ auditable against the real catalog.
 */

/** "0-6" → 6, "30-36" → 36, 4 → 4. Ranges take the maximum: the planner reserves the worst case. */
export function parseCredits(v: unknown): number | undefined {
	if (typeof v === 'number') return v;
	if (typeof v !== 'string') return undefined;
	const parts = v.match(/\d+(?:\.\d+)?/g);
	if (!parts?.length) return undefined;
	return Math.max(...parts.map(Number));
}

/**
 * Rollup rows ("Complete lower-division requirements 30-36") restate the sum of other rows.
 * Counting them as requirements would double-report every credit to the advisor.
 */
function isRollup(r: Requirement): boolean {
	return /^complete-(lower|upper)-division-requirements/.test(r.id);
}

export function normalizeProgram(
	raw: Program,
	/** Category -> the courses that actually satisfy it; see data/local/preferences.yaml. */
	majorSatisfies: Record<string, string[]> = {}
): NormalizedProgram {
	const categoriesSatisfiedByMajor: string[] = [];
	const courseDoubleCounts: { course: string; satisfies: string }[] = [];

	for (const dc of (raw.double_counts ?? []) as (typeof raw.double_counts extends (infer T)[]
		? T
		: never)[]) {
		const entry = dc as { course?: string; satisfies?: string };
		if (!entry.satisfies) continue; // satisfies_requirement entries are program-internal notes
		if (entry.course) {
			courseDoubleCounts.push({ course: entry.course, satisfies: entry.satisfies });
			continue;
		}

		// "Satisfied by the major" with no course named. Where we know which courses do it, say
		// so, and the category then tracks the plan instead of being satisfied from the start.
		const named = majorSatisfies[entry.satisfies];
		if (named === undefined) {
			categoriesSatisfiedByMajor.push(entry.satisfies);
		} else {
			for (const course of named) {
				courseDoubleCounts.push({ course, satisfies: entry.satisfies });
			}
		}
	}

	const untrackable: { name: string; notes?: string }[] = [];
	const requirements: Requirement[] = [];

	for (const r of raw.requirements ?? []) {
		const credits = parseCredits((r as { credits?: unknown }).credits);
		// The scraper names gen-ed groups `gened-<anchor>`; tag them so the gen-ed track owns
		// them and the major panel does not report the same credits twice.
		const genedCategory = r.gened_category ?? (r.id.startsWith('gened-') ? r.id.slice(6) : undefined);

		const req: Requirement = { ...r, credits, gened_category: genedCategory };
		const hasPool = Boolean(req.all_of?.length || req.one_of?.length || req.filter);

		if (isRollup(req)) continue;
		if (genedCategory) continue; // handled by the gen-ed track against gened.yaml

		if (!hasPool) {
			untrackable.push({ name: req.name, notes: req.notes });
			continue;
		}
		requirements.push(req);
	}

	return {
		...raw,
		requirements,
		categoriesSatisfiedByMajor,
		courseDoubleCounts,
		untrackable
	};
}
