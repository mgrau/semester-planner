<script lang="ts">
	import { catalog, programList, genEdById, majorView, programLabel } from '$lib/catalog';
	import {
		roster,
		buildEmptySemesters,
		fullName,
		startTermLabel,
		shortTermLabel
	} from '$lib/stores/roster.svelte';
	import { validatePlan, sortSemesters, termLabel } from '$lib/engine/validate';
	import { generatePlan } from '$lib/engine/planner';
	import {
		genEdProgress,
		takenFrom,
		satisfiedCategoriesFrom,
		totalCredits,
		reservedByCategory,
		reservedCredits,
		creditsOf
	} from '$lib/engine/requirements';
	import { majorViewProgress } from '$lib/engine/majorView';
	import type { Course, PlannedCourse, Semester, Student, Term } from '$lib/types';
	import SemesterCard from '$lib/components/SemesterCard.svelte';
	import RequirementsPanel from '$lib/components/RequirementsPanel.svelte';
	import CoursePicker from '$lib/components/CoursePicker.svelte';
	import PriorCreditsPanel from '$lib/components/PriorCreditsPanel.svelte';
	import StudentPicker from '$lib/components/StudentPicker.svelte';
	import StudentEditor from '$lib/components/StudentEditor.svelte';
	import CourseActions from '$lib/components/CourseActions.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/components/Icon.svelte';
	import {
		planToTsv,
		studentToYaml,
		studentFromYaml,
		copyPlanToClipboard,
		download,
		slugify
	} from '$lib/exports';
	import { buildKindIndex, kindOf, legendFor, KIND_STYLES } from '$lib/courseKind';
	import { base } from '$app/paths';

	let student = $derived(roster.selected);
	let program = $derived(student ? catalog.programs.get(student.programId) : undefined);

	// --- derived analysis ---------------------------------------------------
	let issues = $derived(student ? validatePlan(student, catalog) : []);

	let plannedCourses = $derived(
		student
			? student.semesters.flatMap((s) =>
					s.courses.filter((c) => !c.placeholder).map((c) => ({ code: c.code, credits: c.credits }))
				)
			: []
	);

	let taken = $derived(student ? takenFrom(student.priorCredits, plannedCourses) : []);

	let majorProgress = $derived(
		program ? majorViewProgress(program, taken, catalog, majorView) : []
	);

	// The catalog states some gen-ed categories are covered wholesale by the major (Mathematics
	// and Nature of Science, for the physics degrees). Fold those in alongside anything the
	// student already satisfied through prior credit.
	let satisfiedCats = $derived(
		student
			? new Set([
					...satisfiedCategoriesFrom(student.priorCredits),
					...(program?.categoriesSatisfiedByMajor ?? [])
				])
			: new Set<string>()
	);

	let reserved = $derived(reservedByCategory(student?.semesters ?? []));

	let genedProgress = $derived(
		student
			? genEdProgress(
					catalog.genEd,
					taken,
					catalog.courses,
					satisfiedCats,
					program?.courseDoubleCounts ?? [],
					reserved
				)
			: []
	);

	let kindIndex = $derived(buildKindIndex(program, catalog));

	let legend = $derived(
		legendFor(
			(student?.semesters ?? []).flatMap((s) =>
				s.courses.map((c) => kindOf(c.code, Boolean(c.placeholder), kindIndex))
			)
		)
	);

	/**
	 * Credits the plan accounts for, including slots reserved for a requirement whose course is
	 * not chosen yet. An advisor asking "are we at 120?" means allocated, not merely named — a
	 * plan with every requirement booked should read 120/120, not 87/120.
	 */
	let placeholderCredits = $derived(reservedCredits(student?.semesters ?? []));
	let creditTotal = $derived(totalCredits(taken) + placeholderCredits);
	let errorCount = $derived(issues.filter((i) => i.severity === 'error').length);
	let warnCount = $derived(issues.filter((i) => i.severity === 'warning').length);

	// --- UI state -----------------------------------------------------------
	let pickerOpen = $state(false);
	let pickerTarget = $state<{ semesterId: string; replaceCode?: string } | null>(null);
	let pickerPool = $state<string[] | undefined>(undefined);
	let pickerTitle = $state('Add a course');
	let showSettings = $state(false);
	/** Mobile-only disclosure; the pane is always shown at desktop width. */
	let showNotes = $state(false);
	/** Course whose action sheet is open — the touch route to move/lock/remove. */
	let actionTarget = $state<{ course: PlannedCourse; semesterId: string } | null>(null);
	let showPicker = $state(false);
	/** The student open in the edit dialog, from either the left pane or the roster list. */
	let editing = $state<Student | null>(null);
	let planNotes = $state<string[]>([]);
	let unplaced = $state<{ code: string; reason: string }[]>([]);
	let showPlanNotes = $state(true);

	function touch() {
		roster.update(() => {});
	}

	// --- plan mutations -----------------------------------------------------
	/**
	 * Move a course to `index` within the target term. The index comes from the drop preview,
	 * so where the gap opened is where the course lands — including reordering inside one term.
	 */
	function moveCourse(fromId: string, toId: string, code: string, index: number) {
		if (!student) return;
		roster.update((s) => {
			const from = s.semesters.find((x) => x.id === fromId);
			const to = s.semesters.find((x) => x.id === toId);
			if (!from || !to) return;
			const idx = from.courses.findIndex((c) => c.code === code);
			if (idx < 0) return;
			const [moved] = from.courses.splice(idx, 1);
			moved.auto = false;
			to.courses.splice(Math.max(0, Math.min(index, to.courses.length)), 0, moved);
		});
	}

	function removeCourse(semesterId: string, code: string) {
		roster.update((s) => {
			const sem = s.semesters.find((x) => x.id === semesterId);
			if (sem) sem.courses = sem.courses.filter((c) => c.code !== code);
		});
	}

	function toggleLock(semesterId: string, code: string) {
		roster.update((s) => {
			const c = s.semesters.find((x) => x.id === semesterId)?.courses.find((c) => c.code === code);
			if (c) c.locked = !c.locked;
		});
	}

	function openActions(semesterId: string, code: string) {
		const course = student?.semesters
			.find((s) => s.id === semesterId)
			?.courses.find((c) => c.code === code);
		if (course) actionTarget = { course, semesterId };
	}

	/** Append to the end of the target term; the sheet has no notion of position. */
	function moveViaSheet(toSemesterId: string) {
		const t = actionTarget;
		if (!t) return;
		const to = student?.semesters.find((s) => s.id === toSemesterId);
		moveCourse(t.semesterId, toSemesterId, t.course.code, to?.courses.length ?? 0);
		actionTarget = null;
	}

	function openPicker(semesterId: string, replaceCode?: string) {
		pickerTarget = { semesterId, replaceCode };
		pickerPool = undefined;
		pickerTitle = 'Add a course';
		if (replaceCode && student) {
			const sem = student.semesters.find((x) => x.id === semesterId);
			const slot = sem?.courses.find((c) => c.code === replaceCode);
			const catId = slot?.placeholder?.category;
			if (catId) {
				const cat = genEdById.get(catId);
				pickerPool = cat?.approved;
				pickerTitle = `Choose a course for ${cat?.name ?? catId}`;
			}
		}
		pickerOpen = true;
	}

	function pickCourse(course: Course) {
		if (!pickerTarget) return;
		const { semesterId, replaceCode } = pickerTarget;
		roster.update((s) => {
			const sem = s.semesters.find((x) => x.id === semesterId);
			if (!sem) return;
			const entry = {
				code: course.code,
				credits: creditsOf(course),
				auto: false
			};
			if (replaceCode) {
				const i = sem.courses.findIndex((c) => c.code === replaceCode);
				if (i >= 0) sem.courses[i] = entry;
				else sem.courses.push(entry);
			} else {
				if (!sem.courses.some((c) => c.code === course.code)) sem.courses.push(entry);
			}
		});
		pickerOpen = false;
		pickerTarget = null;
	}

	function addSemester() {
		roster.update((s) => {
			const sorted = sortSemesters(s.semesters);
			const last = sorted[sorted.length - 1];
			let term: Term = 'fall';
			let year = new Date().getFullYear();
			if (last) {
				if (last.term === 'fall') {
					term = 'spring';
					year = last.year + 1;
				} else if (last.term === 'spring') {
					term = s.settings.includeSummers ? 'summer' : 'fall';
					year = last.year;
				} else {
					term = 'fall';
					year = last.year;
				}
			}
			const id = `${term}-${year}`;
			if (!s.semesters.some((x) => x.id === id)) s.semesters.push({ id, term, year, courses: [] });
		});
	}

	function deleteSemester(id: string) {
		roster.update((s) => {
			s.semesters = s.semesters.filter((x) => x.id !== id);
		});
	}

	function autoPopulate() {
		if (!student || !program) return;
		const result = generatePlan({
			program,
			catalog,
			settings: student.settings,
			startTerm: student.startTerm,
			startYear: student.startYear,
			priorCredits: student.priorCredits,
			placements: student.placements ?? [],
			locked: student.semesters
		});
		planNotes = result.notes;
		unplaced = result.unplaced;
		showPlanNotes = true;
		// Auto-populate only writes the schedule. It never edits the student's credit or
		// placement record — those are the advisor's constraints, and a planner that quietly
		// grants a student credit it needed is a planner you cannot trust. Anything it had to
		// assume is reported in the notes banner instead.
		roster.update((s) => {
			s.semesters = result.semesters;
		});
	}

	function clearPlan() {
		roster.update((s) => {
			for (const sem of s.semesters) sem.courses = sem.courses.filter((c) => c.locked);
		});
		planNotes = [];
		unplaced = [];
	}

	function resetSemesters() {
		roster.update((s) => {
			s.semesters = buildEmptySemesters(
				s.startTerm,
				s.startYear,
				s.settings.targetYears,
				s.settings.includeSummers
			);
		});
	}

	// --- roster -------------------------------------------------------------
	async function importStudent(file: File) {
		try {
			const s = studentFromYaml(await file.text());
			s.id = roster.newId();
			roster.upsert(s);
		} catch (e) {
			alert(`Could not import that file: ${(e as Error).message}`);
		}
	}

	/** Save any student's full record, re-importable into this app. */
	function exportStudentFile(target: Student | null = student) {
		if (!target) return;
		download(`${slugify(fullName(target))}-student.yaml`, studentToYaml(target), 'text/yaml');
	}
	function exportTsv() {
		if (!student) return;
		download(`${slugify(fullName(student))}-plan.tsv`, planToTsv(student, catalog), 'text/tab-separated-values');
	}
	async function copyForSheets() {
		if (!student) return;
		try {
			await copyPlanToClipboard(student, catalog, kindIndex);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard permission can be refused; the .tsv download is the fallback path.
			alert('Could not write to the clipboard. Use the .tsv button instead.');
		}
	}
	let copied = $state(false);
	let showExports = $state(false);

	/** One definition, rendered as a menu on a phone and as a button row where there is room. */
	let exportActions = $derived([
		{
			label: copied ? 'Copied to clipboard' : 'Copy for Sheets',
			short: copied ? 'Copied' : 'Copy for Sheets',
			icon: (copied ? 'check' : 'clipboard') as IconName,
			run: copyForSheets
		},
		{ label: 'Download .tsv', short: '.tsv', icon: 'table' as IconName, run: exportTsv },
		{
			label: 'Save student (.yaml)',
			short: '.yaml',
			icon: 'download' as IconName,
			title: 'Full record, re-importable into this app',
			run: () => exportStudentFile(student)
		},
		{
			label: 'Print / PDF',
			short: 'Print / PDF',
			icon: 'printer' as IconName,
			href: `${base}/print`
		}
	] as {
		label: string;
		short: string;
		icon: IconName;
		title?: string;
		run?: () => void;
		href?: string;
	}[]);

	let sortedSemesters = $derived(student ? sortSemesters(student.semesters) : []);
</script>

<div class="min-h-screen">
	<!-- Sticky so the student, credit count and status badge stay in view while a long plan
	     scrolls on a phone. Below the modal layers, above the page content. -->
	<header
		class="no-print sticky top-0 z-40 border-b border-slate-200 bg-[var(--color-odu-blue)] text-white"
	>
		<div class="mx-auto flex max-w-[1800px] items-center gap-2 px-3 py-2 sm:gap-4 sm:px-4 sm:py-2.5">
			<!-- The full title and catalog year are context, not identity; on a phone the student
			     and the credit count are what matter, so the chrome gives way first. -->
			<!-- The title yields space to the student, who is the more useful thing to see. -->
			<h1 class="shrink-0 text-sm font-semibold sm:text-base">
				<span class="hidden md:inline">ODU Semester Planner</span>
				<span class="hidden sm:inline md:hidden">ODU Planner</span>
				<span class="sm:hidden">ODU</span>
			</h1>
			<span class="hidden shrink-0 rounded bg-white/10 px-2 py-0.5 text-xs lg:inline">
				Catalog {catalog.catalogYear}
			</span>
			{#if student}
				<!-- The student's identity lives here rather than in a side panel: it is the one
				     thing every pane is about, and the header is the only chrome that never
				     collapses. Detail sheds as width shrinks — the major goes first, then the term
				     contracts to "Fa26" — but the name never does. -->
				<div class="flex min-w-0 items-center gap-1.5">
					<button
						type="button"
						class="min-w-0 truncate text-left text-sm font-medium text-white/95 hover:text-white"
						title="Switch advisee"
						onclick={() => (showPicker = true)}
					>
						{fullName(student)}
					</button>

					<span class="shrink-0 text-white/40">·</span>
					<span class="shrink-0 text-xs text-white/75">
						<span class="hidden sm:inline">{startTermLabel(student)}</span>
						<span class="sm:hidden">{shortTermLabel(student)}</span>
					</span>

					<span class="hidden shrink-0 text-white/40 md:inline">·</span>
					<span class="hidden shrink-0 truncate text-xs text-white/75 md:inline">
						{programLabel(student.programId)}
					</span>

					<button
						type="button"
						class="shrink-0 rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
						title="Edit name, major, or start term"
						aria-label="Edit student"
						onclick={() => (editing = student)}><Icon name="pencil" /></button
					>
					<button
						type="button"
						class="shrink-0 rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
						title="Switch to another advisee"
						aria-label="Switch advisee"
						onclick={() => (showPicker = true)}><Icon name="switch" /></button
					>
				</div>
			{/if}
			<div class="flex-1"></div>
			{#if student}
				<span
					class="shrink-0 text-xs whitespace-nowrap text-white/70"
					title={placeholderCredits
						? `${totalCredits(taken)} in named courses + ${placeholderCredits} reserved for requirements not yet chosen`
						: 'credits in named courses'}
				>
					{creditTotal}/{program?.total_credits ?? 120}<span class="hidden sm:inline"> credits</span
					>{placeholderCredits ? ` (${placeholderCredits} res.)` : ''}
				</span>
				{#if errorCount}
					<span class="shrink-0 rounded bg-red-500 px-2 py-0.5 text-xs font-medium">
						{errorCount}<span class="hidden sm:inline">
							error{errorCount === 1 ? '' : 's'}</span
						>
					</span>
				{/if}
				{#if warnCount}
					<span class="shrink-0 rounded bg-amber-400 px-2 py-0.5 text-xs font-medium text-amber-950">
						{warnCount}<span class="hidden sm:inline">
							warning{warnCount === 1 ? '' : 's'}</span
						>
					</span>
				{/if}
				{#if !errorCount && !warnCount}
					<span class="shrink-0 rounded bg-emerald-500 px-2 py-0.5 text-xs font-medium">
						<span class="hidden sm:inline">No issues</span><span class="sm:hidden">OK</span>
					</span>
				{/if}
			{/if}
		</div>
	</header>

	{#if programList.length === 0}
		<div class="mx-auto max-w-2xl p-8">
			<div class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
				<strong>No degree programs loaded.</strong> Run the scrapers in <code>scripts/</code> to
				populate <code>data/programs/</code>, then reload.
			</div>
		</div>
	{:else}
		<div class="mx-auto grid max-w-[1800px] gap-3 p-3 sm:gap-4 sm:p-4 lg:grid-cols-[260px_1fr_320px]">
			<!-- Student, settings, earned credit, notes ---------------------------- -->
			<!-- `contents` below lg lets these sections become grid children in their own right,
			     so the plan can come first on a phone without rendering the DOM twice. -->
			<aside
				class="no-print contents lg:order-1 lg:flex lg:min-w-0 lg:flex-col lg:gap-3 lg:sticky lg:top-4 lg:h-[calc(100vh-5.5rem)] lg:self-start"
			>
				{#if student}
					<section
						class="order-6 min-w-0 shrink-0 rounded-lg border border-slate-200 bg-white shadow-sm lg:order-none"
					>
						<button
							type="button"
							class="flex w-full items-center justify-between px-3 py-2.5 text-sm font-semibold text-slate-800"
							onclick={() => (showSettings = !showSettings)}
						>
							Plan settings
						<Icon name={showSettings ? 'chevron-down' : 'chevron-right'} class="h-4 w-4 text-slate-400" />
						</button>
						{#if showSettings}
							<div class="space-y-2 border-t border-slate-100 p-3 text-xs">
								<div class="grid grid-cols-2 gap-2">
									<label class="block">
										<span class="text-slate-600">Max credits/term</span>
										<input
											type="number"
											class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
											value={student.settings.maxCreditsPerTerm}
											onchange={(e) =>
												roster.update((s) => (s.settings.maxCreditsPerTerm = +e.currentTarget.value))}
										/>
									</label>
									<label class="block">
										<span class="text-slate-600">Target years</span>
										<input
											type="number"
											class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
											value={student.settings.targetYears}
											onchange={(e) =>
												roster.update((s) => (s.settings.targetYears = +e.currentTarget.value))}
										/>
									</label>
								</div>
								<label class="flex items-center gap-2">
									<input
										type="checkbox"
										checked={student.settings.includeSummers}
										onchange={(e) =>
											roster.update((s) => (s.settings.includeSummers = e.currentTarget.checked))}
									/>
									<span class="text-slate-600">Show summer terms</span>
								</label>
								<button
									type="button"
									class="w-full rounded border border-slate-300 py-1 hover:bg-slate-50"
									onclick={resetSemesters}>Rebuild empty terms</button
								>
							</div>
						{/if}
					</section>

					<div class="order-7 min-w-0 lg:order-none lg:min-h-0 lg:shrink-0 lg:overflow-y-auto">
						<PriorCreditsPanel {student} onchange={touch} />
					</div>

					<!-- Notes sit at the bottom of the desktop column and take the remaining height;
					     on a phone they collapse to a header that still shows the count. Called notes
					     rather than conflicts because most entries are advisory — a placement to
					     confirm, a light term — and only the red ones actually block a plan. -->
					{@const noteTone = errorCount
						? 'bg-red-100 text-red-700'
						: warnCount
							? 'bg-amber-100 text-amber-800'
							: 'bg-emerald-100 text-emerald-700'}
					<section
						class="order-4 min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm lg:order-none lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
					>
						<button
							type="button"
							class="flex w-full items-center justify-between border-b border-slate-100 px-3 py-2.5 lg:hidden"
							aria-expanded={showNotes}
							onclick={() => (showNotes = !showNotes)}
						>
							<h3 class="text-sm font-semibold text-slate-800">Notes</h3>
							<span class="flex items-center gap-2">
								<span class="rounded px-1.5 py-0.5 text-xs font-medium {noteTone}">
									{issues.length || 'none'}
								</span>
								<Icon
									name={showNotes ? 'chevron-down' : 'chevron-right'}
									class="h-4 w-4 text-slate-400"
								/>
							</span>
						</button>

						<header
							class="hidden shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2 lg:flex"
						>
							<h3 class="text-sm font-semibold text-slate-800">Notes</h3>
							<span class="rounded px-1.5 text-xs font-medium {noteTone}">
								{issues.length || 'none'}
							</span>
						</header>

						<ul
							class="divide-y divide-slate-50 lg:min-h-0 lg:flex-1 lg:overflow-y-auto {showNotes
								? ''
								: 'hidden lg:block'}"
						>
							{#each issues as issue}
								<li class="flex items-start gap-1.5 px-3 py-1.5 text-xs">
									<span
										class="mt-0.5 shrink-0 {issue.severity === 'error'
											? 'text-red-600'
											: issue.severity === 'warning'
												? 'text-amber-600'
												: 'text-slate-400'}"
									>
										<Icon
											name={issue.severity === 'error'
												? 'error'
												: issue.severity === 'warning'
													? 'warning'
													: 'info'}
										/>
									</span>
									<span class="text-slate-700">{issue.message}</span>
								</li>
							{:else}
								<li class="px-3 py-4 text-center text-xs text-slate-400">
									Nothing to flag.
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</aside>

			<!-- Plan grid --------------------------------------------------------- -->
			<!-- Two rows of four fill the viewport, so a standard 4-year plan needs no page
			     scroll; a longer plan scrolls inside this column only. -->
			<main
				class="order-1 flex min-w-0 flex-col lg:order-2 lg:sticky lg:top-4 lg:h-[calc(100vh-5.5rem)] lg:self-start"
			>
				{#if !student}
					<div class="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
						<p class="text-sm text-slate-400">Choose an advisee to start planning.</p>
					</div>
				{:else}
					<!-- @container, not a viewport breakpoint: what matters is how much room this column
					     has, which is also tight on a small laptop with three columns showing. Below
					     ~30rem the labels drop and the buttons stand on their icons. -->
					<div class="@container no-print mb-3 shrink-0">
						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
								title="Auto-populate plan"
								aria-label="Auto-populate plan"
								onclick={autoPopulate}
								><Icon name="wand" /><span class="hidden @min-[30rem]:inline">Auto-populate</span></button
							>
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
								title="Clear the plan, keeping locked courses"
								aria-label="Clear the plan, keeping locked courses"
								onclick={clearPlan}
								><Icon name="eraser" /><span class="hidden @min-[30rem]:inline">Clear</span></button
							>
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
								title="Add a term"
								aria-label="Add a term"
								onclick={addSemester}
								><Icon name="plus" /><span class="hidden @min-[30rem]:inline">Term</span></button
							>

							<div class="flex-1"></div>

							<!-- Six export buttons crowd a phone off the screen. They collapse into one menu
							     below `sm`, and stay laid out flat where there is room for them. -->
							<div class="relative sm:hidden">
								<button
									type="button"
									class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
									title="Export and print"
									aria-label="Export and print"
									aria-expanded={showExports}
									onclick={() => (showExports = !showExports)}
									><Icon name="download" /><span class="hidden @min-[30rem]:inline">Export</span><Icon
										name="chevron-down"
										class="h-3 w-3"
									/></button
								>
								{#if showExports}
									<div
										class="absolute right-0 z-30 mt-1 w-52 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
									>
										{#each exportActions as action (action.label)}
											{#if action.href}
												<a
													href={action.href}
													class="flex items-center gap-2 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
													onclick={() => (showExports = false)}
												>
													<Icon name={action.icon} />{action.label}
												</a>
											{:else}
												<button
													type="button"
													class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
													onclick={() => {
														action.run?.();
														showExports = false;
													}}
												>
													<Icon name={action.icon} />{action.label}
												</button>
											{/if}
										{/each}
									</div>
								{/if}
							</div>

							<div class="hidden flex-wrap items-center gap-2 sm:flex">
								{#each exportActions as action (action.label)}
									{#if action.href}
										<a
											href={action.href}
											class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
											><Icon name={action.icon} />{action.short}</a
										>
									{:else}
										<button
											type="button"
											class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
											title={action.title}
											onclick={action.run}><Icon name={action.icon} />{action.short}</button
										>
									{/if}
								{/each}
							</div>
						</div>
					</div>

					{#if (planNotes.length || unplaced.length) && showPlanNotes}
						<div
							class="no-print relative mb-3 max-h-40 shrink-0 overflow-y-auto rounded-lg border border-amber-300 bg-amber-50 p-3 pr-9 text-sm"
						>
							<button
								type="button"
								class="absolute top-2 right-2 rounded p-1 text-amber-500 hover:bg-amber-100 hover:text-amber-800"
								title="Dismiss"
								aria-label="Dismiss planner notes"
								onclick={() => (showPlanNotes = false)}
							>
								<Icon name="close" class="h-4 w-4" />
							</button>
							{#each planNotes as n}
								<p class="flex items-start gap-1.5 text-amber-900">
									<span class="mt-0.5 shrink-0 text-amber-600"><Icon name="info" /></span>
									{n}
								</p>
							{/each}
							{#if unplaced.length}
								<p class="mt-1 flex items-start gap-1.5 font-medium text-amber-900">
									<span class="mt-0.5 shrink-0 text-amber-600"><Icon name="warning" /></span>
									Could not place {unplaced.length} item(s):
								</p>
								<ul class="mt-0.5 list-inside list-disc pl-5 text-xs text-amber-800">
									{#each unplaced as u}
										<li><span class="font-mono">{u.code}</span> — {u.reason}</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}

					{#if legend.length}
						<div class="mb-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
							{#each legend as k}
								<span class="flex items-center gap-1.5 text-xs text-slate-500">
									<span class="h-2.5 w-2.5 rounded-sm {KIND_STYLES[k].swatch}"></span>
									{KIND_STYLES[k].label}
								</span>
							{/each}
						</div>
					{/if}

					<div class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
						<div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
						{#each sortedSemesters as sem (sem.id)}
							<SemesterCard
								semester={sem}
								{catalog}
								{issues}
								maxCredits={sem.term === 'summer'
									? student.settings.summerMaxCredits
									: student.settings.maxCreditsPerTerm}
								{kindIndex}
								onmove={moveCourse}
								onremove={removeCourse}
								onadd={(id) => openPicker(id)}
								onchoose={(id, code) => openPicker(id, code)}
								ontogglelock={toggleLock}
								onactivate={openActions}
								ondelete={deleteSemester}
							/>
							{/each}
						</div>
					</div>
				{/if}
			</main>

			<!-- Requirement checker ------------------------------------------------ -->
			<!-- Sticky full-height column: the two panes divide the viewport and scroll
			     independently, so requirements stay visible while the plan grid scrolls. -->
			<aside
				class="contents lg:order-3 lg:flex lg:min-w-0 lg:flex-col lg:gap-3 lg:sticky lg:top-4 lg:h-[calc(100vh-5.5rem)] lg:self-start"
			>
				{#if student && program}
					<div class="order-2 min-w-0 lg:order-none lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
						<RequirementsPanel
							title="Major requirements"
							subtitle={programLabel(student.programId)}
							items={majorProgress}
							onedit={() => (editing = student)}
							fill
							collapsible
						/>
					</div>
					<div class="order-3 min-w-0 lg:order-none lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
						<RequirementsPanel title="General education" items={genedProgress} fill collapsible />
					</div>
				{/if}
			</aside>
		</div>
	{/if}
</div>

<StudentPicker
	open={showPicker || !student}
	dismissable={Boolean(student)}
	onclose={() => (showPicker = false)}
	onimport={importStudent}
	onsave={(s) => exportStudentFile(s)}
	onedit={(s) => (editing = s)}
/>

<StudentEditor student={editing} onclose={() => (editing = null)} />

<CourseActions
	target={actionTarget}
	semesters={student?.semesters ?? []}
	{catalog}
	onmove={moveViaSheet}
	onremove={() => {
		if (actionTarget) removeCourse(actionTarget.semesterId, actionTarget.course.code);
		actionTarget = null;
	}}
	ontogglelock={() => {
		if (actionTarget) toggleLock(actionTarget.semesterId, actionTarget.course.code);
		actionTarget = null;
	}}
	onchoose={() => {
		if (actionTarget) openPicker(actionTarget.semesterId, actionTarget.course.code);
		actionTarget = null;
	}}
	onclose={() => (actionTarget = null)}
/>

<CoursePicker
	open={pickerOpen}
	title={pickerTitle}
	pool={pickerPool}
	onselect={pickCourse}
	onclose={() => {
		pickerOpen = false;
		pickerTarget = null;
	}}
/>
