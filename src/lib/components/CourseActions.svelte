<script lang="ts">
	import type { Catalog, PlannedCourse, Semester } from '$lib/types';
	import { sortSemesters, termLabel } from '$lib/engine/validate';
	import { describe } from '$lib/engine/expr';
	import Icon from './Icon.svelte';

	interface Props {
		/** The course under action, with the term it currently sits in. */
		target: { course: PlannedCourse; semesterId: string } | null;
		semesters: Semester[];
		catalog: Catalog;
		onmove: (toSemesterId: string) => void;
		onremove: () => void;
		ontogglelock: () => void;
		onchoose: () => void;
		onclose: () => void;
	}

	let {
		target,
		semesters,
		catalog,
		onmove,
		onremove,
		ontogglelock,
		onchoose,
		onclose
	}: Props = $props();

	let planned = $derived(target?.course);
	let title = $derived(
		planned?.placeholder ? planned.placeholder.label : (planned?.code ?? '')
	);
	let subtitle = $derived(
		planned && !planned.placeholder ? (catalog.courses.get(planned.code)?.title ?? '') : ''
	);
	let ordered = $derived(sortSemesters(semesters));

	/** The catalog entry behind the chip; absent for an unfilled requirement slot. */
	let course = $derived(planned && !planned.placeholder ? catalog.courses.get(planned.code) : undefined);

	/**
	 * The catalog's own wording where we have it, rather than the parsed tree read back out.
	 * If the two ever disagree, the catalog is right — and `needs_review` says so explicitly.
	 */
	let facts = $derived.by(() => {
		if (!course) return [] as { label: string; value: string }[];
		const out: { label: string; value: string }[] = [];
		if (course.terms?.length) out.push({ label: 'Offered', value: course.terms.join(', ') });
		const prereq = course.raw_prereq_text ?? describe(course.prereq);
		if (prereq) out.push({ label: 'Prerequisites', value: prereq });
		const precoreq = course.raw_precoreq_text ?? describe(course.precoreq);
		if (precoreq) out.push({ label: 'Pre- or corequisite', value: precoreq });
		const coreq = describe(course.coreq);
		if (coreq) out.push({ label: 'Corequisite', value: coreq });
		if (course.attributes?.includes('W')) out.push({ label: 'Attributes', value: 'Writing intensive' });
		return out;
	});
</script>

<!--
	What a course opens into: the catalog entry — when it runs, what it needs, what it covers —
	and everything you can do with it from here.

	It is also the only route to those actions on a phone. Touch has no drag-and-drop:
	`dragstart` and friends never fire there, and the hover-only chip buttons are equally
	unreachable, so without this a course could not be moved, locked, or removed at all.
-->
{#if target && planned}
	<div
		class="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onclose();
		}}
	>
		<div
			class="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-sm sm:rounded-xl"
		>
			<header class="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
				<div class="min-w-0">
					<h2 class="truncate text-sm font-semibold text-slate-800">{title}</h2>
					{#if subtitle}
						<p class="truncate text-xs text-slate-500">{subtitle}</p>
					{/if}
					<p class="text-xs text-slate-400">{planned.credits} credits</p>
				</div>
				<button
					type="button"
					class="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
					aria-label="Close"
					onclick={onclose}><Icon name="close" class="h-4 w-4" /></button
				>
			</header>

			{#if course}
				<div class="max-h-64 overflow-y-auto border-b border-slate-100 px-4 py-3">
					<dl class="space-y-1.5 text-xs">
						{#each facts as fact (fact.label)}
							<div class="flex gap-2">
								<dt class="w-32 shrink-0 font-medium text-slate-500">{fact.label}</dt>
								<dd class="min-w-0 flex-1 text-slate-700">{fact.value}</dd>
							</div>
						{/each}
					</dl>

					{#if course.needs_review}
						<p class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
							The importer could not fully parse this course's prerequisites, so what the app
							enforces may be incomplete. The wording above is the catalog's.
						</p>
					{/if}
					{#if course.discontinued}
						<p class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
							ODU no longer offers this course.
						</p>
					{/if}

					{#if course.description}
						<p class="mt-2 text-xs leading-relaxed text-slate-600">{course.description}</p>
					{/if}
				</div>
			{/if}

			<div class="flex flex-col gap-1 border-b border-slate-100 p-2">
				{#if planned.placeholder}
					<button
						type="button"
						class="flex items-center gap-2 rounded px-3 py-2.5 text-left text-sm text-blue-700 hover:bg-blue-50"
						onclick={onchoose}
					>
						<Icon name="search" />Choose a course
					</button>
				{/if}
				<button
					type="button"
					class="flex items-center gap-2 rounded px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
					onclick={ontogglelock}
				>
					<Icon name={planned.locked ? 'unlock' : 'lock'} />
					{planned.locked ? 'Unlock — the planner may move it' : 'Lock to this term'}
				</button>
				<button
					type="button"
					class="flex items-center gap-2 rounded px-3 py-2.5 text-left text-sm text-red-700 hover:bg-red-50"
					onclick={onremove}
				>
					<Icon name="trash" />Remove from plan
				</button>
			</div>

			<p class="px-4 pt-2 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
				Move to
			</p>
			<ul class="min-h-0 flex-1 overflow-y-auto pb-2">
				{#each ordered as sem (sem.id)}
					{@const credits = sem.courses.reduce((s, c) => s + c.credits, 0)}
					{@const here = sem.id === target.semesterId}
					<li>
						<button
							type="button"
							class="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent"
							disabled={here}
							onclick={() => onmove(sem.id)}
						>
							<span class={here ? 'text-slate-400' : 'text-slate-700'}>
								{termLabel(sem)}{here ? ' — current term' : ''}
							</span>
							<span class="text-xs text-slate-400">
								{credits} cr{here ? '' : ` → ${credits + planned.credits}`}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
