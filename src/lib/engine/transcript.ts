import type { Catalog, Grade, PriorCredit } from '$lib/types';

/**
 * Best-effort extraction of completed coursework from pasted DegreeWorks / transcript text.
 *
 * This is intentionally forgiving and intentionally NOT trusted: every row it produces is
 * shown to the advisor for confirmation before it becomes prior credit. Transcript layouts
 * vary by term, by system, and by how the text survived the clipboard, so the parser aims to
 * catch as much as it can and flag its own uncertainty rather than silently guess.
 */

export interface ParsedRow {
	course: string;
	credits: number;
	grade?: Grade;
	term?: string;
	title?: string;
	/** True when the course code is not in the catalog — likely a transfer equivalency. */
	unknown: boolean;
	/** Why the row might be wrong, shown next to the confirm checkbox. */
	warning?: string;
	raw: string;
}

export interface ParseResult {
	rows: ParsedRow[];
	/** Lines that mentioned a course-like token but could not be parsed into a row. */
	skipped: string[];
}

const COURSE_RE = /\b([A-Z]{2,4})\s?(\d{3}[A-Z]?)\b/;
const GRADE_RE = /\b(A\+?|A-|B\+?|B-|C\+?|C-|D\+?|D-|F|P|S|CR|TR|IP|W|NR)\b/;
const CREDIT_RE = /\b(\d{1,2}(?:\.\d)?)\b/g;
const TERM_RE = /\b(Fall|Spring|Summer|Winter)\s*'?(\d{2,4})\b/i;

/** Grades that mean "credit earned". Everything else is in-progress or failed. */
const PASSING = new Set(['A', 'A+', 'A-', 'B', 'B+', 'B-', 'C', 'C+', 'C-', 'D', 'D+', 'D-', 'P', 'S', 'CR', 'TR']);

function normalizeGrade(g: string | undefined): Grade | undefined {
	if (!g) return undefined;
	const letter = g[0].toUpperCase();
	return letter === 'A' || letter === 'B' || letter === 'C' || letter === 'D' ? letter : undefined;
}

export function parseTranscript(text: string, catalog: Catalog): ParseResult {
	const rows: ParsedRow[] = [];
	const skipped: string[] = [];
	const seen = new Set<string>();

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const m = COURSE_RE.exec(line);
		if (!m) continue;

		const code = `${m[1]} ${m[2]}`;
		const rest = line.slice(m.index + m[0].length);

		const gradeMatch = GRADE_RE.exec(rest);
		const gradeToken = gradeMatch?.[1];

		// In-progress and withdrawn rows are not earned credit.
		if (gradeToken && !PASSING.has(gradeToken.toUpperCase())) {
			skipped.push(`${line}  → skipped (grade ${gradeToken})`);
			continue;
		}

		// Credits: prefer a small number (0.5–6) that is not part of the course number.
		const candidates = [...rest.matchAll(CREDIT_RE)]
			.map((c) => parseFloat(c[1]))
			.filter((n) => n > 0 && n <= 6);
		const catalogCourse = catalog.courses.get(code);
		let credits = candidates[0] ?? catalogCourse?.credits?.min ?? 3;
		let warning: string | undefined;
		if (candidates.length === 0) {
			warning = catalogCourse
				? 'Credits not found in the text; using the catalog value.'
				: 'Credits not found in the text; assumed 3.';
		} else if (candidates.length > 1 && new Set(candidates).size > 1) {
			warning = `Several numbers on this line could be credits (${[...new Set(candidates)].join(', ')}); picked ${credits}.`;
		}

		if (seen.has(code)) {
			skipped.push(`${line}  → skipped (${code} already captured)`);
			continue;
		}
		seen.add(code);

		const termMatch = TERM_RE.exec(line);

		rows.push({
			course: code,
			credits,
			grade: normalizeGrade(gradeToken),
			term: termMatch ? `${termMatch[1]} ${termMatch[2]}` : undefined,
			title: catalogCourse?.title,
			unknown: !catalogCourse,
			warning:
				warning ??
				(!catalogCourse
					? 'Not in the ODU catalog — likely a transfer course needing an equivalency.'
					: undefined),
			raw: line
		});
	}

	return { rows, skipped };
}

export function rowsToPriorCredits(rows: ParsedRow[], idFor: () => string): PriorCredit[] {
	return rows.map((r) => ({
		id: idFor(),
		kind: 'course' as const,
		course: r.course,
		credits: r.credits,
		grade: r.grade,
		source: r.term ? `Imported (${r.term})` : 'Imported'
	}));
}
