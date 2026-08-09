<script lang="ts">
	import {
		programLabel,
		programList,
		catalog,
		startingPreparation,
		preparationToRecords
	} from '$lib/catalog';
	import {
		roster,
		createStudent,
		fullName,
		sortName,
		startTermLabel,
		byStartTermThenName
	} from '$lib/stores/roster.svelte';
	import type { Student, Term } from '$lib/types';
	import Icon from './Icon.svelte';

	interface Props {
		open: boolean;
		/** False when there is no selected student: the picker is then the only sensible view. */
		dismissable?: boolean;
		onclose: () => void;
		onimport: (file: File) => void;
		onsave: (student: Student) => void;
		onedit: (student: Student) => void;
	}
	let { open, dismissable = true, onclose, onimport, onsave, onedit }: Props = $props();

	function dismiss() {
		if (dismissable) onclose();
	}

	let query = $state('');
	let creating = $state(false);
	let first = $state('');
	let last = $state('');
	let program = $state('');
	let term = $state<Term>('fall');
	let year = $state(new Date().getFullYear());
	let prepared = $state<Set<string>>(new Set());

	/** Preparation options in their configured order, split under their group headings. */
	let prepGroups = $derived.by(() => {
		const groups: { label: string; options: typeof startingPreparation }[] = [];
		for (const option of startingPreparation) {
			const label = option.group ?? '';
			const last = groups[groups.length - 1];
			if (last?.label === label) last.options.push(option);
			else groups.push({ label, options: [option] });
		}
		return groups;
	});

	let sorted = $derived([...roster.students].sort(byStartTermThenName));

	let filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return sorted;
		return sorted.filter(
			(s) =>
				sortName(s).toLowerCase().includes(q) ||
				programLabel(s.programId).toLowerCase().includes(q) ||
				startTermLabel(s).toLowerCase().includes(q)
		);
	});

	/** Cohort headings, so a term's advisees read as a group. */
	let grouped = $derived.by(() => {
		const groups: { label: string; students: Student[] }[] = [];
		for (const s of filtered) {
			const label = startTermLabel(s);
			const last = groups[groups.length - 1];
			if (last?.label === label) last.students.push(s);
			else groups.push({ label, students: [s] });
		}
		return groups;
	});

	function startCreate() {
		creating = true;
		first = '';
		last = '';
		program = programList[0]?.id ?? '';
		term = 'fall';
		year = new Date().getFullYear();
		prepared = new Set(startingPreparation.filter((o) => o.default).map((o) => o.id));
	}

	function togglePrep(id: string, on: boolean) {
		const next = new Set(prepared);
		if (on) next.add(id);
		else next.delete(id);
		prepared = next;
	}

	function create() {
		if (!last.trim() || !program) return;
		const prep = preparationToRecords(prepared, () => roster.newId());
		roster.add(
			createStudent(
				first.trim(),
				last.trim(),
				program,
				catalog.catalogYear,
				term,
				year,
				prep.priorCredits,
				prep.placements
			)
		);
		creating = false;
		onclose();
	}

	function remove(s: Student) {
		if (confirm(`Delete ${fullName(s)} and their plan? This cannot be undone.`)) {
			roster.remove(s.id);
		}
	}

	function select(id: string) {
		roster.selectedId = id;
		onclose();
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-16"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) dismiss();
		}}
	>
		<div class="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
			<header class="flex items-center justify-between border-b border-slate-100 px-4 py-3">
				<h2 class="text-sm font-semibold text-slate-800">
					Advisees <span class="font-normal text-slate-400">({roster.students.length})</span>
				</h2>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
						onclick={startCreate}
						><span class="inline-flex items-center gap-1"><Icon name="plus" />New student</span></button
					>
					<label
						class="cursor-pointer rounded border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50"
					>
						<span class="inline-flex items-center gap-1"><Icon name="upload" />Import</span>
						<input
							type="file"
							accept=".yaml,.yml"
							class="hidden"
							onchange={(e) => {
								const f = e.currentTarget.files?.[0];
								if (f) {
									onimport(f);
									onclose();
								}
								e.currentTarget.value = '';
							}}
						/>
					</label>
					{#if dismissable}
						<button
							type="button"
							class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
							aria-label="Close"
							onclick={onclose}><Icon name="close" class="h-4 w-4" /></button
						>
					{/if}
				</div>
			</header>

			{#if creating}
				<div class="border-b border-slate-100 bg-slate-50 p-4">
					<div class="grid grid-cols-2 gap-2">
						<label class="text-xs text-slate-600">
							Last name
							<!-- svelte-ignore a11y_autofocus -->
							<input
								autofocus
								bind:value={last}
								class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
								onkeydown={(e) => e.key === 'Enter' && create()}
							/>
						</label>
						<label class="text-xs text-slate-600">
							First name
							<input
								bind:value={first}
								class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
								onkeydown={(e) => e.key === 'Enter' && create()}
							/>
						</label>
						<label class="text-xs text-slate-600">
							Major
							<select
								bind:value={program}
								class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
							>
								{#each programList as p}
									<option value={p.id}>{programLabel(p.id)}</option>
								{/each}
							</select>
						</label>
						<div class="grid grid-cols-2 gap-2">
							<label class="text-xs text-slate-600">
								Start term
								<select
									bind:value={term}
									class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
								>
									<option value="fall">Fall</option>
									<option value="spring">Spring</option>
								</select>
							</label>
							<label class="text-xs text-slate-600">
								Year
								<input
									type="number"
									bind:value={year}
									class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
								/>
							</label>
						</div>
					</div>
					{#if startingPreparation.length}
						<fieldset class="mt-3 rounded border border-slate-200 bg-white p-2">
							<legend class="px-1 text-xs font-semibold text-slate-600">Already has</legend>
							<p class="mb-1 px-1 text-xs text-slate-400">
								What the student brings, so the planner is told rather than left to guess.
							</p>
							{#each prepGroups as group (group.label)}
								{#if group.label}
									<p class="mt-1.5 mb-0.5 px-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
										{group.label}
									</p>
								{/if}
								<div class="grid gap-x-4 gap-y-1 sm:grid-cols-2">
									{#each group.options as option (option.id)}
										<label class="flex items-start gap-1.5 px-1 text-xs">
											<input
												type="checkbox"
												class="mt-0.5"
												checked={prepared.has(option.id)}
												onchange={(e) => togglePrep(option.id, e.currentTarget.checked)}
											/>
											<span>
												<span class="text-slate-700">{option.label}</span>
												{#if option.detail}
													<span class="block text-slate-400">{option.detail}</span>
												{/if}
											</span>
										</label>
									{/each}
								</div>
							{/each}
						</fieldset>
					{/if}

					<div class="mt-3 flex gap-2">
						<button
							type="button"
							class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
							disabled={!last.trim()}
							onclick={create}>Create</button
						>
						<button
							type="button"
							class="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-white"
							onclick={() => (creating = false)}>Cancel</button
						>
					</div>
				</div>
			{:else}
				<div class="relative border-b border-slate-100 px-4 py-2">
					<span class="pointer-events-none absolute top-1/2 left-6 -translate-y-1/2 text-slate-400">
						<Icon name="search" class="h-4 w-4" />
					</span>
					<input
						bind:value={query}
						placeholder="Filter by name, major, or term…"
						class="w-full rounded border border-slate-300 py-1.5 pr-3 pl-8 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
					/>
				</div>
			{/if}

			<div class="flex-1 overflow-y-auto">
				{#each grouped as group (group.label)}
					<div
						class="sticky top-0 border-y border-slate-100 bg-slate-50 px-4 py-1 text-xs font-semibold text-slate-500"
					>
						{group.label}
					</div>
					{#each group.students as s (s.id)}
						<div
							class="group flex items-center hover:bg-blue-50 {roster.selectedId === s.id
								? 'bg-blue-50'
								: ''}"
						>
							<button
								type="button"
								class="flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left"
								onclick={() => select(s.id)}
							>
								<span class="flex-1 truncate text-sm font-medium text-slate-800">{sortName(s)}</span>
								<span class="w-24 shrink-0 text-xs text-slate-500">{startTermLabel(s)}</span>
								<span class="w-44 shrink-0 truncate text-xs text-slate-600"
									>{programLabel(s.programId)}</span
								>
							</button>
							<div class="flex shrink-0 items-center gap-1 pr-3 pl-1">
								<button
									type="button"
									class="rounded p-1 text-slate-300 hover:bg-white hover:text-blue-700 group-hover:text-slate-500"
									title="Save {fullName(s)} to a YAML file"
									aria-label="Save {fullName(s)}"
									onclick={() => onsave(s)}
								>
									<Icon name="download" class="h-4 w-4" />
								</button>
								<button
									type="button"
									class="rounded p-1 text-slate-300 hover:bg-white hover:text-red-600 group-hover:text-slate-500"
									title="Delete {fullName(s)}"
									aria-label="Delete {fullName(s)}"
									onclick={() => remove(s)}
								>
									<Icon name="trash" class="h-4 w-4" />
								</button>
							</div>
						</div>
					{/each}
				{:else}
					<p class="px-4 py-10 text-center text-sm text-slate-400">
						{roster.students.length
							? 'No students match that filter.'
							: 'No advisees yet. Create one, or import a saved plan.'}
					</p>
				{/each}
			</div>
		</div>
	</div>
{/if}
