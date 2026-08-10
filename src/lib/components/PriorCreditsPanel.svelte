<script lang="ts">
	import { catalog } from '$lib/catalog';
	import { parseTranscript, type ParsedRow } from '$lib/engine/transcript';
	import type { PriorCredit, Student } from '$lib/types';
	import { roster } from '$lib/stores/roster.svelte';
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

	function addCategory(categoryId: string) {
		if (!categoryId) return;
		const cat = catalog.genEd.find((c) => c.id === categoryId);
		student.priorCredits.push({
			id: roster.newId(),
			kind: 'category',
			category: categoryId,
			credits: cat?.credits ?? 3,
			source: 'Satisfied by prior credit'
		});
		onchange();
	}

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

	function label(p: PriorCredit): string {
		if (p.kind === 'category') {
			return catalog.genEd.find((c) => c.id === p.category)?.name ?? (p.category ?? '');
		}
		return p.course ?? '';
	}
</script>

<section class="rounded-lg border border-slate-200 bg-white shadow-sm">
	<header class="flex items-center justify-between border-b border-slate-100 px-3 py-2">
		<h3 class="text-sm font-semibold text-slate-800">Credit already earned</h3>
		<button
			type="button"
			class="no-print rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
			onclick={() => (showImport = !showImport)}
		>
			<span class="inline-flex items-center gap-1"><Icon name="clipboard" />Paste transcript</span>
		</button>
	</header>

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

	<ul class="divide-y divide-slate-50">
		{#each student.priorCredits as p (p.id)}
			<li class="flex items-center gap-2 px-3 py-1.5 text-sm">
				<span class="flex-1 truncate">
					<span class="font-medium {p.kind === 'category' ? 'text-emerald-700' : ''}">
						{label(p)}
					</span>
					{#if p.kind === 'category'}<span class="text-xs text-slate-400"> (requirement waived)</span
						>{/if}
					<span class="text-xs text-slate-400">
						· {p.credits} cr{p.grade ? ` · ${p.grade}` : ''}{p.source ? ` · ${p.source}` : ''}
					</span>
				</span>
				<button
					type="button"
					class="no-print text-xs text-slate-300 hover:text-red-600"
					aria-label="Remove"
					onclick={() => remove(p.id)}><Icon name="close" /></button
				>
			</li>
		{:else}
			<li class="px-3 py-3 text-xs text-slate-400">
				Nothing recorded. Add transfer, AP, or dual-enrollment credit so the planner can skip it.
			</li>
		{/each}
	</ul>

	<!-- Placement satisfies prerequisites but awards nothing, so it is kept visibly apart from
	     earned credit rather than listed as a zero-credit course. -->
	<div class="border-t border-slate-100 bg-slate-50 px-3 py-2">
		<p class="mb-1 text-xs font-semibold text-slate-500">Placed past (no credit)</p>
		{#if student.placements?.length}
			<ul class="mb-1 flex flex-wrap gap-1">
				{#each student.placements as code (code)}
					<li
						class="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-600"
					>
						{code}
						<button
							type="button"
							class="text-slate-300 hover:text-red-600"
							aria-label="Remove placement {code}"
							onclick={() => removePlacement(code)}><Icon name="close" class="h-3 w-3" /></button
						>
					</li>
			{/each}
			</ul>
		{/if}
		<div class="no-print flex gap-1">
			<input
				bind:value={newPlacement}
				placeholder="MATH 163"
				aria-label="Course the student places past"
				class="w-full min-w-0 flex-1 rounded border border-slate-300 px-2 py-0.5 text-xs uppercase sm:w-28 sm:flex-none"
				onkeydown={(e) => e.key === 'Enter' && addPlacement()}
			/>
			<button
				type="button"
				class="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-white disabled:opacity-40"
				disabled={!newPlacement.trim()}
				onclick={addPlacement}
			>
				<span class="inline-flex items-center gap-1"><Icon name="plus" />Placement</span>
			</button>
		</div>
	</div>

	<div class="no-print space-y-2 border-t border-slate-100 p-3">
		<div>
			<div class="flex gap-1">
				<input
					bind:value={newCode}
					placeholder="MATH 211"
					class="w-full min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs uppercase sm:w-28 sm:flex-none"
					onkeydown={(e) => e.key === 'Enter' && addCourse()}
				/>
				<input
					bind:value={creditOverride}
					type="number"
					min="0"
					max="12"
					placeholder={matched ? String(matched.credits.min) : 'cr'}
					title="Leave blank to use the catalog credit hours"
					class="w-14 rounded border border-slate-300 px-2 py-1 text-xs"
				/>
				<button
					type="button"
					class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
					disabled={!normalizedCode}
					onclick={addCourse}
					><span class="inline-flex items-center gap-1"><Icon name="plus" />Add</span></button
				>
			</div>
			<!-- Credits come from the catalog; the field is an override for transfer work that
			     does not carry the ODU credit hours. -->
			{#if normalizedCode && matched}
				<p class="mt-0.5 text-xs text-slate-500">
					{matched.title} · {effectiveCredits} cr{creditOverride.trim() !== ''
						? ' (overridden)'
						: ' from catalog'}
				</p>
			{:else if normalizedCode}
				<p class="mt-0.5 text-xs text-amber-700">
					Not in the catalog — set the credit hours yourself ({effectiveCredits} cr assumed).
				</p>
			{/if}
		</div>
		<select
			class="w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-600"
			onchange={(e) => {
				addCategory(e.currentTarget.value);
				e.currentTarget.value = '';
			}}
		>
			<option value="">Mark a requirement satisfied (e.g. Language &amp; Culture)…</option>
			{#each catalog.genEd as cat}
				<option value={cat.id}>{cat.name}</option>
			{/each}
		</select>
	</div>
</section>
