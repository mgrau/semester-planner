import type { PlannerSettings, PriorCredit, Semester, Student, Term } from '$lib/types';

/**
 * The student roster, persisted to localStorage.
 *
 * Uses Svelte 5 runes in a .svelte.ts module so components can read `roster.students`
 * reactively without a subscription ceremony.
 */

const STORAGE_KEY = 'odu-planner.roster.v1';

export const DEFAULT_SETTINGS: PlannerSettings = {
	maxCreditsPerTerm: 16,
	minCreditsPerTerm: 12,
	includeSummers: false,
	summerMaxCredits: 7,
	targetYears: 4
};

function uid(): string {
	return Math.random().toString(36).slice(2, 10);
}

/** Fall/spring pairs for `years` years, starting at the given term. */
export function buildEmptySemesters(
	startTerm: Term,
	startYear: number,
	years: number,
	includeSummers: boolean
): Semester[] {
	const out: Semester[] = [];
	let term: Term = startTerm;
	let year = startYear;
	const count = years * (includeSummers ? 3 : 2);
	for (let i = 0; i < count; i++) {
		out.push({ id: `${term}-${year}`, term, year, courses: [] });
		if (term === 'fall') {
			term = 'spring';
			year += 1;
		} else if (term === 'spring') {
			term = includeSummers ? 'summer' : 'fall';
		} else {
			term = 'fall';
		}
	}
	return out;
}

export function createStudent(
	firstName: string,
	lastName: string,
	programId: string,
	catalogYear: string,
	startTerm: Term = 'fall',
	startYear: number = new Date().getFullYear(),
	priorCredits: PriorCredit[] = [],
	placements: string[] = []
): Student {
	return {
		id: uid(),
		name: [firstName, lastName].filter(Boolean).join(' '),
		firstName,
		lastName,
		programId,
		catalogYear,
		startTerm,
		startYear,
		priorCredits,
		placements,
		semesters: buildEmptySemesters(startTerm, startYear, 4, false),
		settings: { ...DEFAULT_SETTINGS },
		updatedAt: new Date().toISOString()
	};
}

/**
 * Earlier versions recorded planner placement assumptions as zero-credit prior credit, which
 * misreported them as coursework the student had completed. Reclassify them as placements —
 * the information was right, the category was wrong.
 */
function migratePlacements(s: Student): Student {
	const legacy = (s.priorCredits ?? []).filter(
		(p) => p.source === 'Assumed placement — verify' && p.course
	);
	if (!legacy.length) return s;
	return {
		...s,
		priorCredits: s.priorCredits.filter((p) => !legacy.includes(p)),
		placements: [...new Set([...(s.placements ?? []), ...legacy.map((p) => p.course!)])]
	};
}

/**
 * Give every course in a plan a code unique within its term.
 *
 * The plan grid renders each term with a keyed {#each} over the course code, and Svelte treats a
 * repeated key as a fatal error that takes the whole component down — so a single duplicate makes
 * the plan refuse to display and every button on it appear dead. Placeholders were once coded by
 * category alone, so two slots of one category in one term collided; plans saved then are still
 * out there in files and in localStorage. Renumber placeholders, and drop a real course listed
 * twice in the same term, which is meaningless anyway.
 */
function repairDuplicateCodes(s: Student): Student {
	let seq = 0;
	let changed = false;

	const semesters = (s.semesters ?? []).map((sem) => {
		const seen = new Set<string>();
		const courses = [];
		let repaired = false;
		for (const c of sem.courses ?? []) {
			if (!seen.has(c.code)) {
				seen.add(c.code);
				courses.push(c);
				continue;
			}
			changed = repaired = true;
			// A real course listed twice in one term means nothing; a placeholder is a second
			// genuine slot that only needs a code of its own.
			if (!c.placeholder?.category) continue;
			let code = c.code;
			while (seen.has(code)) code = `placeholder:${c.placeholder.category}:${seq++}`;
			seen.add(code);
			courses.push({ ...c, code });
		}
		return repaired ? { ...sem, courses } : sem;
	});

	return changed ? { ...s, semesters } : s;
}

/**
 * Split a legacy single-field name. Records created before names were split, and imported
 * plans, only carry `name`; the last whitespace-separated token is treated as the surname.
 */
function ensureSplitName(s: Student): Student {
	if (s.lastName != null || s.firstName != null) return s;
	const parts = (s.name ?? '').trim().split(/\s+/);
	const lastName = parts.length > 1 ? parts.pop()! : (parts[0] ?? '');
	return { ...s, firstName: parts.join(' '), lastName };
}

/** "Last, First" for rosters and sorted lists. */
export function sortName(s: Student): string {
	const last = s.lastName?.trim();
	const first = s.firstName?.trim();
	if (last && first) return `${last}, ${first}`;
	return last || first || s.name || '(unnamed)';
}

/** "First Last" for headings and exports. */
export function fullName(s: Student): string {
	const joined = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
	return joined || s.name || '(unnamed)';
}

const TERM_RANK: Record<Term, number> = { spring: 0, summer: 1, fall: 2, winter: 3 };

/** Newest cohort first, then alphabetical by surname within a cohort. */
export function byStartTermThenName(a: Student, b: Student): number {
	return (
		b.startYear - a.startYear ||
		TERM_RANK[b.startTerm] - TERM_RANK[a.startTerm] ||
		sortName(a).localeCompare(sortName(b))
	);
}

export function startTermLabel(s: Student): string {
	return `${s.startTerm[0].toUpperCase()}${s.startTerm.slice(1)} ${s.startYear}`;
}

const TERM_ABBR: Record<Term, string> = {
	fall: 'Fa',
	spring: 'Sp',
	summer: 'Su',
	winter: 'Wi'
};

/** "Fa26" — for the header when there is no room for "Fall 2026". */
export function shortTermLabel(s: Student): string {
	return `${TERM_ABBR[s.startTerm]}${String(s.startYear).slice(-2)}`;
}

/**
 * Bring a record from storage or an imported file up to what the app expects now. Applied to
 * everything that enters the roster from outside, so an older plan opens rather than failing.
 */
export function normalizeStudent(s: Student): Student {
	return repairDuplicateCodes(migratePlacements(ensureSplitName(s)));
}

function load(): Student[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as Student[]).map(normalizeStudent) : [];
	} catch {
		// A corrupt blob should not brick the app; start clean and let the advisor re-import.
		console.warn('Could not read saved roster; starting empty.');
		return [];
	}
}

class Roster {
	students = $state<Student[]>(load());
	selectedId = $state<string | null>(null);

	get selected(): Student | null {
		return this.students.find((s) => s.id === this.selectedId) ?? null;
	}

	save() {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(this.students));
	}

	add(student: Student) {
		this.students.push(student);
		this.selectedId = student.id;
		this.save();
	}

	remove(id: string) {
		this.students = this.students.filter((s) => s.id !== id);
		if (this.selectedId === id) this.selectedId = this.students[0]?.id ?? null;
		this.save();
	}

	/** Mutate any student by id and persist. */
	updateStudent(id: string, fn: (s: Student) => void) {
		const s = this.students.find((x) => x.id === id);
		if (!s) return;
		fn(s);
		s.name = [s.firstName, s.lastName].filter(Boolean).join(' ').trim() || s.name;
		s.updatedAt = new Date().toISOString();
		this.save();
	}

	/** Mutate the selected student and persist. */
	update(fn: (s: Student) => void) {
		const s = this.selected;
		if (!s) return;
		fn(s);
		// Keep the legacy display field in step with the split fields.
		s.name = [s.firstName, s.lastName].filter(Boolean).join(' ').trim() || s.name;
		s.updatedAt = new Date().toISOString();
		this.save();
	}

	/** Replace or add a student from an imported YAML plan. */
	upsert(raw: Student) {
		// Everything that arrives from outside — an imported file, a PDF — comes through here.
		const student = normalizeStudent(raw);
		const i = this.students.findIndex((s) => s.id === student.id);
		if (i >= 0) this.students[i] = student;
		else this.students.push(student);
		this.selectedId = student.id;
		this.save();
	}

	newId() {
		return uid();
	}
}

export const roster = new Roster();
