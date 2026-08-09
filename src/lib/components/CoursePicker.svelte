<script lang="ts">
	import { searchCourses } from '$lib/catalog';
	import type { Course } from '$lib/types';
	import { catalog } from '$lib/catalog';

	interface Props {
		open: boolean;
		title?: string;
		/** When set, restrict the picker to this pool (a gen-ed approved list or elective pool). */
		pool?: string[];
		onselect: (course: Course) => void;
		onclose: () => void;
	}

	let { open, title = 'Add a course', pool, onselect, onclose }: Props = $props();

	let query = $state('');
	let input = $state<HTMLInputElement | null>(null);

	let poolCourses = $derived(
		pool
			? pool.map((code) => catalog.courses.get(code)).filter((c): c is Course => Boolean(c))
			: null
	);

	let results = $derived.by(() => {
		if (poolCourses) {
			const q = query.trim().toLowerCase();
			if (!q) return poolCourses.slice(0, 200);
			return poolCourses
				.filter((c) => c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
				.slice(0, 200);
		}
		return searchCourses(query);
	});

	$effect(() => {
		if (open) {
			query = '';
			queueMicrotask(() => input?.focus());
		}
	});
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 p-4 pt-20"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onclose();
		}}
	>
		<div class="w-full max-w-2xl overflow-hidden rounded-lg bg-white shadow-xl">
			<div class="border-b border-slate-100 p-3">
				<div class="mb-2 flex items-center justify-between">
					<h3 class="text-sm font-semibold text-slate-800">{title}</h3>
					<button type="button" class="text-slate-400 hover:text-slate-700" onclick={onclose}>
						✕
					</button>
				</div>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:this={input}
					bind:value={query}
					type="text"
					placeholder={pool ? 'Filter approved courses…' : 'Search by code or title, e.g. PHYS 231N'}
					class="w-full rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
					onkeydown={(e) => {
						if (e.key === 'Escape') onclose();
						if (e.key === 'Enter' && results[0]) onselect(results[0]);
					}}
				/>
			</div>

			<ul class="max-h-96 overflow-y-auto">
				{#each results as course (course.code)}
					<li>
						<button
							type="button"
							class="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-blue-50"
							onclick={() => onselect(course)}
						>
							<span class="w-24 shrink-0 font-mono text-sm font-semibold text-slate-800"
								>{course.code}</span
							>
							<span class="flex-1 truncate text-sm text-slate-600">{course.title}</span>
							<span class="shrink-0 text-xs text-slate-400">
								{course.credits.min}{course.credits.max !== course.credits.min
									? `–${course.credits.max}`
									: ''} cr
							</span>
						</button>
					</li>
				{:else}
					<li class="px-4 py-8 text-center text-sm text-slate-400">
						{query ? 'No matching courses.' : 'Start typing to search the catalog.'}
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
