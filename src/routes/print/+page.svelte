<script lang="ts">
	import { catalog, majorView, programLabel } from '$lib/catalog';
	import { roster, fullName } from '$lib/stores/roster.svelte';
	import { sortSemesters, termLabel, validatePlan } from '$lib/engine/validate';
	import type { Semester } from '$lib/types';
	import {
		genEdProgress,
		satisfiedCategoriesFrom,
		takenFrom,
		totalCredits,
		reservedByCategory,
		reservedCredits
	} from '$lib/engine/requirements';
	import { majorViewProgress } from '$lib/engine/majorView';
	import { buildKindIndex, kindOf, KIND_STYLES } from '$lib/courseKind';
	import { base } from '$app/paths';
	import { PLAN_DATA_BEGIN, PLAN_DATA_END, encodeStudent } from '$lib/exports';

	let student = $derived(roster.selected);
	let program = $derived(student ? catalog.programs.get(student.programId) : undefined);
	let semesters = $derived(student ? sortSemesters(student.semesters) : []);

	/**
	 * Group terms into academic years so Fall 2026 and Spring 2027 print side by side.
	 * Chronological order alone gets this right only by accident — it breaks as soon as a plan
	 * includes summers or starts in the spring.
	 */
	const TERM_SLOT: Record<string, number> = { fall: 0, spring: 1, summer: 2 };

	let academicYears = $derived.by(() => {
		const groups = new Map<number, (Semester | null)[]>();
		for (const sem of semesters) {
			// An academic year runs Fall YYYY → Summer YYYY+1.
			const ay = sem.term === 'fall' ? sem.year : sem.year - 1;
			if (!groups.has(ay)) groups.set(ay, [null, null, null]);
			groups.get(ay)![TERM_SLOT[sem.term] ?? 2] = sem;
		}
		return [...groups.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([year, terms]) => ({ year, terms }));
	});

	/** Only widen to three columns when the plan actually uses summer terms. */
	let hasSummer = $derived(semesters.some((s) => s.term === 'summer'));

	let planned = $derived(
		student
			? student.semesters.flatMap((s) =>
					s.courses.filter((c) => !c.placeholder).map((c) => ({ code: c.code, credits: c.credits }))
				)
			: []
	);
	let taken = $derived(student ? takenFrom(student.priorCredits, planned) : []);
	let major = $derived(program ? majorViewProgress(program, taken, catalog, majorView) : []);

	let reserved = $derived(reservedByCategory(student?.semesters ?? []));

	let gened = $derived(
		student
			? genEdProgress(
					catalog.genEd,
					taken,
					catalog.courses,
					new Set([
						...satisfiedCategoriesFrom(student.priorCredits),
						...(program?.categoriesSatisfiedByMajor ?? [])
					]),
					program?.courseDoubleCounts ?? [],
					reserved
				)
			: []
	);
	let issues = $derived(student ? validatePlan(student, catalog) : []);
	let errors = $derived(issues.filter((i) => i.severity === 'error'));

	let kindIndex = $derived(buildKindIndex(catalog));


	/** Includes credits reserved for requirements whose course is not chosen yet. */
	let placeholderCredits = $derived(reservedCredits(student?.semesters ?? []));
</script>

<div class="mx-auto max-w-4xl bg-white p-6 text-slate-900">
	<div class="no-print mb-4 flex gap-2">
		<a href="{base}/" class="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
			← Back to planner
		</a>
		<button
			type="button"
			class="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
			onclick={() => window.print()}
		>
			Print / Save as PDF
		</button>
	</div>

	{#if !student}
		<p class="text-sm text-slate-500">No student selected.</p>
	{:else}
		<!-- One compact line: the sheet's value is the plan, not the letterhead. -->
		<header class="mb-2 flex items-baseline justify-between gap-3 border-b-2 border-slate-800 pb-1">
			<h1 class="text-base font-bold">{fullName(student)}</h1>
			<p class="text-xs text-slate-600">
				{programLabel(student.programId)} · Catalog {student.catalogYear}{#if student.studentId}
					· {student.studentId}{/if} ·
				<span class="whitespace-nowrap"
					>{totalCredits(taken) + placeholderCredits}/{program?.total_credits ?? 120} cr</span
				> ·
				{new Date().toLocaleDateString()}
			</p>
		</header>

		{#if errors.length}
			<div class="mb-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-900">
				<strong>{errors.length} unresolved conflict(s):</strong>
				<ul class="list-inside list-disc">
					{#each errors as e}<li>{e.message}</li>{/each}
				</ul>
			</div>
		{/if}

		<div class="mb-3 space-y-2">
			{#each academicYears as group (group.year)}
				<!-- `items-start` matters: a grid item stretches by default, and a stretched table
				     hands the extra height to its rows — header included. The term with the fewest
				     courses gets the most, so its heading drifts down out of line with the others.
				     Summer, being shortest, drifted furthest. -->
				<div
					class="print-page grid items-start gap-3 {hasSummer ? 'grid-cols-3' : 'grid-cols-2'}"
				>
					{#each group.terms.slice(0, hasSummer ? 3 : 2) as sem}
						{#if sem}
							<table class="w-full border-collapse align-top text-[10px] leading-snug">
								<thead>
									<tr class="border-b border-slate-400">
										<th colspan="2" class="pb-0.5 text-left align-top font-bold">{termLabel(sem)}</th>
										<!-- The unit must not wrap away from its number; the column is narrow enough
										     that "15" and "cr" would otherwise land on separate lines. -->
										<th class="pb-0.5 text-right align-top font-bold whitespace-nowrap">
											{sem.courses.reduce((s, c) => s + c.credits, 0)} cr
										</th>
									</tr>
								</thead>
								<tbody>
									{#each sem.courses as c}
										{@const kind = kindOf(c.code, Boolean(c.placeholder), kindIndex)}
										<tr class="border-b border-slate-100">
											<td
												class="w-16 border-l-4 py-0 pl-1.5 font-mono font-medium {KIND_STYLES[kind]
													.accent}"
											>
												{c.placeholder ? '—' : c.code}
											</td>
											<td class="py-0">
												{c.placeholder
													? `${c.placeholder.label} (choose)`
													: (catalog.courses.get(c.code)?.title ?? '')}
											</td>
											<td class="py-0 text-right">{c.credits}</td>
										</tr>
									{:else}
										<tr
											><td colspan="3" class="py-1 text-slate-400 italic">No courses planned</td></tr
										>
									{/each}
								</tbody>
							</table>
						{:else}
							<div></div>
						{/if}
					{/each}
				</div>
			{/each}
		</div>

		<div class="grid grid-cols-2 gap-5 text-[10px] leading-snug">
			<section class="print-page">
				<h2 class="mb-0.5 border-b border-slate-400 text-xs font-bold">Major requirements</h2>
				<ul>
					{#each major as m}
						<li class="flex justify-between border-b border-slate-100 py-0">
							<span>{m.satisfied ? '☑' : '☐'} {m.name}</span>
							<span class="text-slate-500">{m.earnedCredits}/{m.requiredCredits}</span>
						</li>
					{/each}
				</ul>
			</section>
			<section class="print-page">
				<h2 class="mb-0.5 border-b border-slate-400 text-xs font-bold">General education</h2>
				<ul>
					{#each gened as g}
						<li class="flex justify-between border-b border-slate-100 py-0">
							<span>
								{g.satisfied ? (g.plannedCredits > 0 ? '◐' : '☑') : '☐'}
								{g.name}
								{#if g.plannedCredits > 0}<span class="text-slate-400">(course not chosen)</span
									>{/if}
							</span>
							<span class="text-slate-500"
								>{g.earnedCredits + g.plannedCredits}/{g.requiredCredits}</span
							>
						</li>
					{/each}
				</ul>
			</section>
		</div>


		{#if student.notes?.trim()}
			<section class="mt-3 border-t border-slate-300 pt-2">
				<h2 class="mb-0.5 text-xs font-bold">Advisor notes</h2>
				<p class="text-[10px] leading-snug whitespace-pre-line text-slate-700">{student.notes}</p>
			</section>
		{/if}

		<!--
			The plan itself, carried in the PDF's text layer so the document can be loaded back.
			Invisible on the page (1px, white) rather than hidden with `display: none`, which would
			keep it out of the PDF altogether. Screen-only viewers never see it; see app.css.
		-->
		<div class="plan-data" aria-hidden="true">
			{PLAN_DATA_BEGIN}{encodeStudent(student)}{PLAN_DATA_END}
		</div>

		<p class="mt-3 text-[9px] text-slate-400">
			Advising aid only. Verify against DegreeWorks and the official ODU catalog before
			registration.
		</p>
	{/if}
</div>
