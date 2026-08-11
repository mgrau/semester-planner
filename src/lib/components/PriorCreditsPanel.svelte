<script lang="ts">
	import { catalog, associateDegreeCategories, associateDegreeLabel } from '$lib/catalog';
	import { parseTranscript, type ParsedRow } from '$lib/engine/transcript';
	import type { Student } from '$lib/types';
	import { roster } from '$lib/stores/roster.svelte';
	import {
		courseworkCredits,
		describePriorCredit,
		groupOf
	} from '$lib/priorCredits';
	import Icon from './Icon.svelte';

	interface Props {
		student: Student;
		onchange: () => void;
	}
	let { student, onchange }: Props = $props();

	let showImport = $state(false);
	let pasteText = $state('');
	let parsed = $state<ParsedRow[] | null>(null);
	let skipped = $state<string[]>([]);
	let accepted = $state<Set<string>>(new Set());

	let newCode = $state('');
	/** Blank means "use the catalog value" — only an override needs typing. */
	let creditOverride = $state<string>('');

	let normalizedCode = $derived(newCode.trim().toUpperCase().replace(/\s+/g, ' '));
	let matched = $derived(catalog.courses.get(normalizedCode));
	let effectiveCredits = $derived(
		creditOverride.trim() !== ''
			? Number(creditOverride)
			: (matched?.credits.min ?? 3)
	);

	function addCourse() {
		if (!normalizedCode) return;
		student.priorCredits.push({
			id: roster.newId(),
			kind: 'course',
			course: normalizedCode,
			credits: effectiveCredits,
			source: 'Entered manually'
		});
		newCode = '';
		creditOverride = '';
		onchange();
	}

	function satisfy(categoryId: string, source: string) {
		if (student.priorCredits.some((p) => p.category === categoryId)) return;
		const cat = catalog.genEd.find((c) => c.id === categoryId);
		student.priorCredits.push({
			id: roster.newId(),
			kind: 'category',
			category: categoryId,
			credits: cat?.credits ?? 3,
			source
		});
	}

	function addCategory(value: string) {
		if (!value) return;
		if (value === ASSOCIATE_DEGREE) {
			// One record naming the degree, not one per category: what the advisor recorded is
			// "they hold an associate degree", and eleven identical rows would bury the rest.
			student.priorCredits.push({
				id: roster.newId(),
				kind: 'category',
				categories: associateDegreeCategories.map((c) => c.id),
				credits: 0,
				source: associateDegreeLabel
			});
		} else {
			satisfy(value, 'Satisfied by prior credit');
		}
		onchange();
	}

	const ASSOCIATE_DEGREE = '__associate_degree__';

	/** Every category already covered, whether recorded singly or as part of a block waiver. */
	let satisfiedIds = $derived(
		new Set(
			student.priorCredits.flatMap((p) => p.categories ?? (p.category ? [p.category] : []))
		)
	);

	let associateDegreeApplied = $derived(
		associateDegreeCategories.every((c) => satisfiedIds.has(c.id))
	);

	function remove(id: string) {
		student.priorCredits = student.priorCredits.filter((p) => p.id !== id);
		onchange();
	}

	function removePlacement(code: string) {
		student.placements = (student.placements ?? []).filter((c) => c !== code);
		onchange();
	}

	let newPlacement = $state('');

	function addPlacement() {
		const code = newPlacement.trim().toUpperCase().replace(/\s+/g, ' ');
		if (!code) return;
		if (!(student.placements ?? []).includes(code)) {
			student.placements = [...(student.placements ?? []), code];
		}
		newPlacement = '';
		onchange();
	}

	function runParse() {
		const result = parseTranscript(pasteText, catalog);
		parsed = result.rows;
		skipped = result.skipped;
		accepted = new Set(result.rows.map((r) => r.course));
	}

	function commitImport() {
		if (!parsed) return;
		const existing = new Set(student.priorCredits.map((p) => p.course));
		for (const row of parsed) {
			if (!accepted.has(row.course) || existing.has(row.course)) continue;
			student.priorCredits.push({
				id: roster.newId(),
				kind: 'course',
				course: row.course,
				credits: row.credits,
				grade: row.grade,
				source: row.term ? `Imported (${row.term})` : 'Imported'
			});
		}
		parsed = null;
		pasteText = '';
		showImport = false;
		onchange();
	}

	let coursework = $derived(student.priorCredits.filter((p) => groupOf(p) === 'coursework'));
	let satisfied = $derived(student.priorCredits.filter((p) => groupOf(p) === 'satisfied'));
	let earned = $derived(courseworkCredits(student.priorCredits));

	let view = $derived((p: (typeof student.priorCredits)[number]) =>
		describePriorCredit(p, catalog.genEd, catalog.courses)
	);

	/** Categories not already recorded, so the picker never offers a duplicate. */
	let availableCategories = $derived(catalog.genEd.filter((c) => !satisfiedIds.has(c.id)));
</script>

<!-- The heading stays put and everything under it scrolls, so a student with a transcript's
     worth of transfer credit cannot push the panes below off the screen. -->
<section
	class="rounded-lg border border-slate-200 bg-white shadow-sm lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
>
	<header
		class="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2"
	>
		<h3 class="text-sm font-semibold text-slate-800">Credit Earned</h3>
		<button
			type="button"
			class="no-print rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
			onclick={() => (showImport = !showImport)}
		>
			<span class="inline-flex items-center gap-1"><Icon name="clipboard" />Paste transcript</span>
		</button>
	</header>

	<div class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
	{#if showImport}
		<div class="border-b border-slate-100 bg-slate-50 p-3">
			{#if !parsed}
				<p class="mb-1 text-xs text-slate-500">
					Paste from DegreeWorks or an unofficial transcript. Every row is shown for your review
					before anything is added.
				</p>
				<textarea
					bind:value={pasteText}
					rows="6"
					placeholder="PHYS 231N  University Physics I   4.0   A&#10;MATH 211   Calculus I            4.0   B"
					class="w-full rounded border border-slate-300 p-2 font-mono text-xs"
				></textarea>
				<div class="mt-2 flex gap-2">
					<button
						type="button"
						class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
						disabled={!pasteText.trim()}
						onclick={runParse}>Parse</button
					>
					<button
						type="button"
						class="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-white"
						onclick={() => (showImport = false)}>Cancel</button
					>
				</div>
			{:else}
				<p class="mb-2 text-xs font-medium text-slate-700">
					Found {parsed.length} course{parsed.length === 1 ? '' : 's'} — uncheck anything wrong.
				</p>
				<ul class="max-h-56 overflow-y-auto rounded border border-slate-200 bg-white">
					{#each parsed as row (row.course)}
						<li class="flex items-start gap-2 border-b border-slate-50 px-2 py-1.5 text-xs">
							<input
								type="checkbox"
								class="mt-0.5"
								checked={accepted.has(row.course)}
								onchange={(e) => {
									const next = new Set(accepted);
									if (e.currentTarget.checked) next.add(row.course);
									else next.delete(row.course);
									accepted = next;
								}}
							/>
							<div class="min-w-0 flex-1">
								<span class="font-mono font-semibold">{row.course}</span>
								<span class="text-slate-500"> {row.title ?? ''}</span>
								<span class="text-slate-400"> · {row.credits} cr{row.grade ? ` · ${row.grade}` : ''}</span>
								{#if row.warning}
									<p class="text-amber-700">{row.warning}</p>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
				{#if skipped.length}
					<details class="mt-2 text-xs text-slate-500">
						<summary class="cursor-pointer">{skipped.length} line(s) skipped</summary>
						<ul class="mt-1 font-mono">
							{#each skipped as s}<li class="truncate">{s}</li>{/each}
						</ul>
					</details>
				{/if}
				<div class="mt-2 flex gap-2">
					<button
						type="button"
						class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
						onclick={commitImport}>Add {accepted.size} course(s)</button
					>
					<button
						type="button"
						class="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-white"
						onclick={() => (parsed = null)}>Back</button
					>
				</div>
			{/if}
		</div>
	{/if}

	<!--
		Three sections rather than one list, because three unlike things were sharing it: credit
		that counts toward the degree, requirements met without coursework, and prerequisites
		placed past. Each keeps its own add control directly beneath it, so the control that adds
		a thing sits with the things it adds.
	-->

	{#snippet row(name: string, detail: string, credits: string, onremove: () => void)}
		<li class="flex items-baseline gap-2 px-3 py-1.5">
			<span class="min-w-0 flex-1">
				<span class="block truncate text-sm font-medium text-slate-800">{name}</span>
				{#if detail}
					<span class="block truncate text-xs text-slate-400">{detail}</span>
				{/if}
			</span>
			{#if credits}
				<span class="shrink-0 text-xs text-slate-500">{credits}</span>
			{/if}
			<button
				type="button"
				class="no-print shrink-0 text-slate-300 hover:text-red-600"
				aria-label="Remove {name}"
				onclick={onremove}><Icon name="close" /></button
			>
		</li>
	{/snippet}

	{#snippet groupHeader(title: string, trailing: string)}
		<div class="flex items-baseline justify-between bg-slate-50 px-3 py-1">
			<span class="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</span>
			{#if trailing}<span class="text-xs text-slate-400">{trailing}</span>{/if}
		</div>
	{/snippet}

	<!-- Coursework ------------------------------------------------------------------ -->
	{@render groupHeader('Coursework', earned ? `${earned} cr` : '')}
	<ul class="divide-y divide-slate-50">
		{#each coursework as p (p.id)}
			{@const v = view(p)}
			{@render row(v.name, v.detail, v.credits, () => remove(p.id))}
		{/each}
	</ul>
	<div class="no-print px-3 py-2">
		<div class="flex gap-1">
			<input
				bind:value={newCode}
				placeholder="MATH 211"
				aria-label="Course code"
				class="w-full min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs uppercase"
				onkeydown={(e) => e.key === 'Enter' && addCourse()}
			/>
			<input
				bind:value={creditOverride}
				type="number"
				min="0"
				max="12"
				placeholder={matched ? String(matched.credits.min) : 'cr'}
				aria-label="Credit hours"
				title="Leave blank to use the catalog credit hours"
				class="w-14 shrink-0 rounded border border-slate-300 px-2 py-1 text-xs"
			/>
			<button
				type="button"
				class="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
				disabled={!normalizedCode}
				onclick={addCourse}
				><span class="inline-flex items-center gap-1"><Icon name="plus" />Add</span></button
			>
		</div>
		<!-- Credits come from the catalog; the field is an override for transfer work that does
		     not carry the ODU hours. -->
		{#if normalizedCode && matched}
			<p class="mt-1 text-xs text-slate-500">
				{matched.title} · {effectiveCredits} cr{creditOverride.trim() !== ''
					? ' (overridden)'
					: ' from catalog'}
			</p>
		{:else if normalizedCode}
			<p class="mt-1 text-xs text-amber-700">
				Not in the catalog — set the credit hours yourself ({effectiveCredits} cr assumed).
			</p>
		{/if}
	</div>

	<!-- Satisfied without coursework -------------------------------------------------- -->
	{@render groupHeader('Satisfied without coursework', '')}
	<ul class="divide-y divide-slate-50">
		{#each satisfied as p (p.id)}
			{@const v = view(p)}
			{@render row(v.name, v.detail, v.credits, () => remove(p.id))}
		{/each}
	</ul>
	<div class="no-print px-3 py-2">
		<select
			class="w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-600"
			aria-label="Mark a requirement satisfied"
			onchange={(e) => {
				addCategory(e.currentTarget.value);
				e.currentTarget.value = '';
			}}
		>
			<option value="">Mark a requirement satisfied…</option>
			{#if !associateDegreeApplied}
				<option value={ASSOCIATE_DEGREE}>
					{associateDegreeLabel} — waives {associateDegreeCategories.length} categories
				</option>
			{/if}
			{#each availableCategories as cat (cat.id)}
				<option value={cat.id}>{cat.name}</option>
			{/each}
		</select>
	</div>

	<!-- Placed past ------------------------------------------------------------------- -->
	<!-- Placement satisfies a prerequisite and awards nothing, so it is kept apart from earned
	     credit rather than listed as a zero-credit course. -->
	{@render groupHeader('Placed past', 'no credit')}
	{#if student.placements?.length}
		<ul class="flex flex-wrap gap-1 px-3 py-2">
			{#each student.placements as code (code)}
				<li
					class="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600"
				>
					{code}
					<button
						type="button"
						class="no-print text-slate-300 hover:text-red-600"
						aria-label="Remove placement {code}"
						onclick={() => removePlacement(code)}><Icon name="close" class="h-3 w-3" /></button
					>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="no-print flex gap-1 px-3 py-2">
		<input
			bind:value={newPlacement}
			placeholder="MATH 163"
			aria-label="Course the student places past"
			class="w-full min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs uppercase"
			onkeydown={(e) => e.key === 'Enter' && addPlacement()}
		/>
		<button
			type="button"
			class="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
			disabled={!newPlacement.trim()}
			onclick={addPlacement}
			><span class="inline-flex items-center gap-1"><Icon name="plus" />Add</span></button
		>
		</div>
	</div>
</section>
