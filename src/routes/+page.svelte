<script lang="ts">
	import { catalog, programList, genEdById, majorView, programLabel } from '$lib/catalog';
	import {
		roster,
		buildEmptySemesters,
		fullName,
		startTermLabel
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
	import type { Course, Semester, Student, Term } from '$lib/types';
	import SemesterCard from '$lib/components/SemesterCard.svelte';
	import RequirementsPanel from '$lib/components/RequirementsPanel.svelte';
	import CoursePicker from '$lib/components/CoursePicker.svelte';
	import PriorCreditsPanel from '$lib/components/PriorCreditsPanel.svelte';
	import StudentPicker from '$lib/components/StudentPicker.svelte';
	import StudentEditor from '$lib/components/StudentEditor.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import {
		planToTsv,
		planToYaml,
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

	function exportYaml() {
		if (!student) return;
		download(`${slugify(fullName(student))}-plan.yaml`, planToYaml(student, catalog), 'text/yaml');
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

	let sortedSemesters = $derived(student ? sortSemesters(student.semesters) : []);
</script>

<div class="min-h-screen">
	<header class="no-print border-b border-slate-200 bg-[var(--color-odu-blue)] text-white">
		<div class="mx-auto flex max-w-[1800px] items-center gap-4 px-4 py-2.5">
			<h1 class="text-base font-semibold">ODU Semester Planner</h1>
			<span class="rounded bg-white/10 px-2 py-0.5 text-xs">Catalog {catalog.catalogYear}</span>
			{#if student}
				<span class="text-sm text-white/90">
					· {fullName(student)}
					<span class="text-white/50">({programLabel(student.programId)})</span>
				</span>
			{/if}
			<div class="flex-1"></div>
			{#if student}
				<span class="text-xs text-white/70" title={placeholderCredits
					? `${totalCredits(taken)} in named courses + ${placeholderCredits} reserved for requirements not yet chosen`
					: 'credits in named courses'}>
					{creditTotal} / {program?.total_credits ?? 120} credits{placeholderCredits
						? ` (${placeholderCredits} reserved)`
						: ''}
				</span>
				{#if errorCount}
					<span class="rounded bg-red-500 px-2 py-0.5 text-xs font-medium">{errorCount} error{errorCount === 1 ? '' : 's'}</span>
				{/if}
				{#if warnCount}
					<span class="rounded bg-amber-400 px-2 py-0.5 text-xs font-medium text-amber-950">{warnCount} warning{warnCount === 1 ? '' : 's'}</span>
				{/if}
				{#if !errorCount && !warnCount}
					<span class="rounded bg-emerald-500 px-2 py-0.5 text-xs font-medium">No conflicts</span>
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
		<div class="mx-auto grid max-w-[1800px] gap-4 p-4 lg:grid-cols-[260px_1fr_320px]">
			<!-- Student, settings, earned credit, conflicts ------------------------- -->
			<aside class="no-print flex flex-col gap-3 lg:sticky lg:top-4 lg:h-[calc(100vh-5.5rem)] lg:self-start">
				<section class="shrink-0 rounded-lg border border-slate-200 bg-white shadow-sm">
					{#if student}
						<div class="flex items-start justify-between gap-2 px-3 py-2.5">
							<div class="min-w-0">
								<h2 class="truncate text-sm font-semibold text-slate-800">{fullName(student)}</h2>
								<p class="text-xs text-slate-500">
									{programLabel(student.programId)} · {startTermLabel(student)}
								</p>
								{#if student.studentId}
									<p class="text-xs text-slate-400">{student.studentId}</p>
								{/if}
							</div>
							<div class="flex shrink-0 gap-1">
								<button
									type="button"
									class="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
									title="Edit name, major, or start term"
									onclick={() => (editing = student)}><Icon name="pencil" />Edit</button
								>
								<button
									type="button"
									class="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
									title="Switch to another advisee"
									onclick={() => (showPicker = true)}><Icon name="switch" />Switch</button
								>
							</div>
						</div>
					{:else}
						<div class="px-3 py-4 text-center">
							<p class="mb-2 text-xs text-slate-500">No advisee selected.</p>
							<button
								type="button"
								class="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
								onclick={() => (showPicker = true)}><Icon name="user" />Choose a student</button
							>
						</div>
					{/if}
				</section>

				{#if student}
					<section class="shrink-0 rounded-lg border border-slate-200 bg-white shadow-sm">
						<button
							type="button"
							class="flex w-full items-center justify-between px-3 py-2 text-sm font-semibold text-slate-800"
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

					<div class="min-h-0 shrink-0 overflow-y-auto">
						<PriorCreditsPanel {student} onchange={touch} />
					</div>

					<!-- Conflicts sit at the bottom of the column and take the remaining height. -->
					<section
						class="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200 bg-white shadow-sm"
					>
						<header
							class="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2"
						>
							<h3 class="text-sm font-semibold text-slate-800">Conflicts</h3>
							<span
								class="rounded px-1.5 text-xs font-medium {errorCount
									? 'bg-red-100 text-red-700'
									: warnCount
										? 'bg-amber-100 text-amber-800'
										: 'bg-emerald-100 text-emerald-700'}"
							>
								{issues.length || 'none'}
							</span>
						</header>
						<ul class="min-h-0 flex-1 divide-y divide-slate-50 overflow-y-auto">
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
									No prerequisite or credit-load conflicts.
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</aside>

			<!-- Plan grid --------------------------------------------------------- -->
			<!-- Two rows of four fill the viewport, so a standard 4-year plan needs no page
			     scroll; a longer plan scrolls inside this column only. -->
			<main class="flex flex-col lg:sticky lg:top-4 lg:h-[calc(100vh-5.5rem)] lg:self-start">
				{#if !student}
					<div class="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
						<p class="text-sm text-slate-400">Choose an advisee to start planning.</p>
					</div>
				{:else}
					<div class="no-print mb-3 flex shrink-0 flex-wrap items-center gap-2">
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
							onclick={autoPopulate}><Icon name="wand" />Auto-populate plan</button
						>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
							onclick={clearPlan}><Icon name="eraser" />Clear (keep locked)</button
						>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
							onclick={addSemester}><Icon name="plus" />Term</button
						>
						<div class="flex-1"></div>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
							onclick={copyForSheets}><Icon name={copied ? 'check' : 'clipboard'} />{copied ? 'Copied' : 'Copy for Sheets'}</button
						>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
							onclick={exportTsv}><Icon name="table" />.tsv</button
						>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
							onclick={exportYaml}><Icon name="download" />.yaml</button
						>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
							onclick={() => exportStudentFile(student)}
							title="Full record, re-importable into this app"><Icon name="download" />Save student</button
						>
						<a
							href="{base}/print"
							class="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
							><Icon name="printer" />Print / PDF</a
						>
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

					<div class="min-h-0 flex-1 overflow-y-auto pr-1">
						<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
			<aside class="flex flex-col gap-3 lg:sticky lg:top-4 lg:h-[calc(100vh-5.5rem)] lg:self-start">
				{#if student && program}
					<RequirementsPanel title="Major requirements" items={majorProgress} fill />
					<RequirementsPanel title="General education" items={genedProgress} fill />
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
