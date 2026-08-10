/**
 * Domain model for the ODU semester planner.
 *
 * Catalog types (Course, GenEdCategory, Program) mirror data/SCHEMA.md and are read-only
 * — they are produced by the scrapers in scripts/. Student types are owned by the app and
 * are what gets persisted to localStorage and exported to YAML.
 */

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type Term = 'fall' | 'spring' | 'summer' | 'winter';

export type Grade = 'A' | 'B' | 'C' | 'D';

/** A prerequisite expression tree. Mirrors the Expressions section of data/SCHEMA.md. */
export type Expr =
	| { course: string; min_grade?: Grade }
	| { note: string }
	| { placement: string }
	| { all_of: Expr[] }
	| { one_of: Expr[] }
	| { n_of: { n: number; options: Expr[] } };

export interface CreditRange {
	min: number;
	max: number;
}

export interface Course {
	code: string;
	subject: string;
	number: string;
	title: string;
	credits: CreditRange;
	description?: string;
	prereq?: Expr | null;
	/** Strict corequisite — must be taken in the same term. */
	coreq?: Expr | null;
	/** "Pre- or corequisite" — satisfied by an earlier term OR the same term. */
	precoreq?: Expr | null;
	/** Terms the catalog says it is offered. Undefined means the catalog is silent. */
	terms?: Term[];
	attributes?: string[];
	crosslist?: string[];
	raw_prereq_text?: string;
	raw_precoreq_text?: string;
	needs_review?: boolean;
	/**
	 * ODU no longer offers this course. It stays in the catalog so a returning student's credit
	 * can still be named, but the planner will not schedule it.
	 */
	discontinued?: boolean;
}

export interface GenEdCategory {
	id: string;
	name: string;
	/** The catalog's own heading: "Skills", "Ways of Knowing", or the upper-division block. */
	group?: string;
	credits: number;
	notes?: string;
	waivable?: boolean;
	approved: string[];
	/**
	 * Rule-based satisfaction, for categories the catalog defines by a property rather than a
	 * list — the Writing Intensive requirement is any W-attributed course, not an enumerated set.
	 */
	filter?: RequirementFilter;
}

/** A rule-based requirement pool, for "any 300+ PHYS course" style requirements. */
export interface RequirementFilter {
	level_min?: number;
	level_max?: number;
	subject?: string[];
	attributes?: string[];
}

/**
 * One choice within a requirement pool. Usually a single course, but the catalog does offer
 * genuine either/or between a course and a *sequence* — "PHYS 499W or PHYS 489W & PHYS 490W".
 */
export type PoolOption = string | { all_of: string[] };

export interface Requirement {
	id: string;
	name: string;
	/** Every listed course is required. */
	all_of?: string[];
	/** Choose from this pool until `credits` (or `count`) is met. */
	one_of?: PoolOption[];
	filter?: RequirementFilter;
	credits?: number;
	count?: number;
	notes?: string;
	/** Set when this requirement group *is* a gen-ed category, so the two do not double-count. */
	gened_category?: string;
}

export interface PlanOfStudyItem {
	course?: string;
	one_of?: string[];
	placeholder?: string;
	category?: string;
	credits?: number;
}

export interface PlanOfStudyTerm {
	year: string;
	term: string;
	credits?: number;
	items: PlanOfStudyItem[];
}

export interface DoubleCount {
	course: string;
	/** Gen-ed category id this major course also satisfies. */
	satisfies: string;
}

export interface Program {
	id: string;
	name: string;
	degree: string;
	department: string;
	total_credits: number;
	requirements: Requirement[];
	double_counts?: DoubleCount[];
	plan_of_study?: PlanOfStudyTerm[];
	policies?: string[];
}

/** A Program after `normalizeProgram` has reconciled it with what the engine consumes. */
export interface NormalizedProgram extends Program {
	/** Gen-ed categories the catalog says are satisfied wholesale by completing the major. */
	categoriesSatisfiedByMajor: string[];
	/** Requirement rows with no course list, which the engine cannot track automatically. */
	untrackable: { name: string; notes?: string }[];
	/** Double counts that name both a course and a gen-ed category. */
	courseDoubleCounts: { course: string; satisfies: string }[];
}

export interface Catalog {
	courses: Map<string, Course>;
	genEd: GenEdCategory[];
	programs: Map<string, NormalizedProgram>;
	catalogYear: string;
}

// ---------------------------------------------------------------------------
// Student & plan
// ---------------------------------------------------------------------------

/**
 * Credit the student already holds: transfer, AP, dual enrollment, or courses taken at ODU.
 * `course` form grants a specific ODU course equivalency; `category` form satisfies a gen-ed
 * category outright without naming a course (how Language & Culture waivers are recorded).
 */
export interface PriorCredit {
	id: string;
	kind: 'course' | 'category';
	/**
	 * Prerequisite prose this record answers, e.g. "High school chemistry". Prose clauses cannot
	 * be checked mechanically, so declaring one here silences the advisory note rather than
	 * leaving the advisor to re-confirm it every time.
	 */
	satisfiesNotes?: string[];
	/** Id of the starting-preparation option that created this record, if any. */
	preparationId?: string;
	/** ODU course code, when kind === 'course'. */
	course?: string;
	/** Gen-ed category id, when kind === 'category'. */
	category?: string;
	/**
	 * Several categories satisfied by one thing — a transfer associate degree waives eleven of
	 * them, and eleven identical rows says less than one row naming the degree.
	 */
	categories?: string[];
	credits: number;
	grade?: Grade;
	/** Free text: "AP Physics C", "Tidewater CC PHY 241", "HS language waiver". */
	source?: string;
	note?: string;
}

export interface PlannedCourse {
	/** ODU course code, or a placeholder id for an unfilled requirement slot. */
	code: string;
	/** Set when this slot is a requirement placeholder rather than a chosen course. */
	placeholder?: { label: string; category?: string; requirementId?: string };
	credits: number;
	/** True when the autopopulate planner placed it, false when the advisor did. */
	auto?: boolean;
	locked?: boolean;
	note?: string;
}

export interface Semester {
	id: string;
	term: Term;
	year: number;
	courses: PlannedCourse[];
}

export interface Student {
	id: string;
	/** Full display name. Kept for plans exported before names were split. */
	name: string;
	firstName?: string;
	lastName?: string;
	/** Free-form, e.g. "UIN 01234567". */
	studentId?: string;
	programId: string;
	catalogYear: string;
	startTerm: Term;
	startYear: number;
	priorCredits: PriorCredit[];
	/**
	 * Courses the student is deemed to place past — the precalculus a physics major skips, for
	 * instance. These satisfy prerequisites but award NO credit, which is why they are kept
	 * apart from `priorCredits` rather than recorded as zero-credit coursework.
	 */
	placements?: string[];
	semesters: Semester[];
	settings: PlannerSettings;
	notes?: string;
	updatedAt: string;
}

export interface PlannerSettings {
	maxCreditsPerTerm: number;
	minCreditsPerTerm: number;
	includeSummers: boolean;
	summerMaxCredits: number;
	targetYears: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
	severity: IssueSeverity;
	/** Machine-readable kind, for filtering and testing. */
	kind:
		| 'prereq-unmet'
		| 'coreq-unmet'
		| 'precoreq-unmet'
		| 'term-unavailable'
		| 'overload'
		| 'underload'
		| 'duplicate-course'
		| 'unknown-course'
		| 'requirement-unmet'
		| 'credits-short'
		| 'needs-review'
		| 'policy';
	message: string;
	semesterId?: string;
	course?: string;
	requirementId?: string;
}
