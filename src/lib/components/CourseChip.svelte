<script lang="ts">
	import type { Course, Issue, PlannedCourse } from '$lib/types';
	import { drag } from '$lib/stores/dnd.svelte';
	import { describe } from '$lib/engine/expr';
	import { KIND_STYLES, type CourseKind } from '$lib/courseKind';
	import Icon from './Icon.svelte';

	interface Props {
		planned: PlannedCourse;
		course?: Course;
		semesterId: string;
		issues: Issue[];
		kind: CourseKind;
		onremove: () => void;
		onchoose?: () => void;
		ontogglelock: () => void;
		/** Opens the action sheet — the only route to these actions on a touch device. */
		onactivate: () => void;
	}

	let {
		planned,
		course,
		semesterId,
		issues,
		kind,
		onremove,
		onchoose,
		ontogglelock,
		onactivate
	}: Props = $props();

	let hasError = $derived(issues.some((i) => i.severity === 'error'));
	let hasWarning = $derived(issues.some((i) => i.severity === 'warning'));

	// Status owns the background, course type owns the left stripe. Keeping them on separate
	// channels means a red "prereq unmet" chip never becomes unreadable just because the course
	// also happens to be a lab science.
	let tone = $derived(
		hasError
			? 'border-red-300 bg-red-50'
			: hasWarning
				? 'border-amber-300 bg-amber-50'
				: planned.placeholder
					? 'border-dashed border-slate-300 bg-slate-50/80'
					: 'border-slate-200 bg-white'
	);

	let accent = $derived(KIND_STYLES[kind].accent);

	let el = $state<HTMLDivElement | null>(null);
	let suppressClick = $state(false);

	let label = $derived(planned.placeholder ? planned.placeholder.label : planned.code);

	let tooltip = $derived(
		[
			course?.title,
			course?.prereq ? `Prereq: ${describe(course.prereq)}` : null,
			course?.precoreq ? `Pre/coreq: ${describe(course.precoreq)}` : null,
			...issues.map((i) => `${i.severity.toUpperCase()}: ${i.message}`)
		]
			.filter(Boolean)
			.join('\n')
	);
</script>

<div
	bind:this={el}
	class="group relative touch-manipulation rounded-md border border-l-4 px-2 py-2 text-sm shadow-sm transition sm:py-1.5 {tone} {accent} chip-grab"
	draggable="true"
	role="button"
	tabindex="0"
	aria-label="{label} — drag to move between terms"
	title={tooltip}
	ondragstart={(e) => {
		drag.start(semesterId, planned.code, label, el?.offsetHeight ?? 44);
		e.dataTransfer?.setData('text/plain', planned.code);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}}
	ondragend={() => {
		// A drag that ends over a drop target already committed the move; suppress the click
		// the browser fires afterwards so the sheet does not open on top of it.
		suppressClick = true;
		drag.end();
	}}
	onclick={() => {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		onactivate();
	}}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onactivate();
		}
	}}
>
	<div class="flex items-start gap-1.5">
		<div class="min-w-0 flex-1">
			{#if planned.placeholder}
				<button
					type="button"
					class="block w-full text-left font-medium text-slate-600 italic hover:text-blue-700 hover:underline"
					onclick={(e) => {
						e.stopPropagation();
						onchoose?.();
					}}
				>
					{planned.placeholder.label}
				</button>
				<div class="text-xs text-slate-400">click to choose a course</div>
			{:else}
				<div class="font-semibold text-slate-800">{planned.code}</div>
				<div class="truncate text-xs text-slate-500">{course?.title ?? 'Not in catalog'}</div>
			{/if}
		</div>
		<div class="flex shrink-0 flex-col items-end gap-0.5">
			<span class="rounded bg-slate-100 px-1 text-xs font-medium text-slate-600"
				>{planned.credits}</span
			>
		</div>
	</div>

	{#if hasError || hasWarning}
		<div class="mt-1 text-xs {hasError ? 'text-red-700' : 'text-amber-700'}">
			{issues.find((i) => i.severity === (hasError ? 'error' : 'warning'))?.message}
		</div>
	{/if}

	<div
		class="no-print absolute -top-2 -right-2 hidden gap-1 group-hover:flex"
	>
		<button
			type="button"
			class="rounded-full border border-slate-300 bg-white p-1 text-slate-500 shadow-sm hover:bg-slate-50"
			title={planned.locked ? 'Unlock (planner may move it)' : 'Lock to this term'}
			onclick={(e) => {
				e.stopPropagation();
				ontogglelock();
			}}
		>
			<Icon name={planned.locked ? 'lock' : 'unlock'} class="h-3 w-3" />
		</button>
		<button
			type="button"
			class="rounded-full border border-slate-300 bg-white p-1 text-slate-500 shadow-sm hover:bg-red-50 hover:text-red-700"
			title="Remove"
			onclick={(e) => {
				e.stopPropagation();
				onremove();
			}}
		>
			<Icon name="close" class="h-3 w-3" />
		</button>
	</div>
</div>
