<script lang="ts">
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import type { Catalog, Issue, PlannedCourse, Semester } from '$lib/types';
	import { drag } from '$lib/stores/dnd.svelte';
	import { termLabel } from '$lib/engine/validate';
	import { kindOf, type CourseKind } from '$lib/courseKind';
	import CourseChip from './CourseChip.svelte';
	import Icon from './Icon.svelte';

	interface Props {
		semester: Semester;
		catalog: Catalog;
		issues: Issue[];
		maxCredits: number;
		kindIndex: Map<string, CourseKind>;
		onmove: (from: string, to: string, code: string, index: number) => void;
		onremove: (semesterId: string, code: string) => void;
		onadd: (semesterId: string) => void;
		onchoose: (semesterId: string, code: string) => void;
		ontogglelock: (semesterId: string, code: string) => void;
		onactivate: (semesterId: string, code: string) => void;
		ondelete: (semesterId: string) => void;
	}

	let {
		semester,
		catalog,
		issues,
		maxCredits,
		kindIndex,
		onmove,
		onremove,
		onadd,
		onchoose,
		ontogglelock,
		onactivate,
		ondelete
	}: Props = $props();

	/**
	 * The chip being dragged stays mounted but hidden, rather than being removed from the list.
	 * Unmounting the drag source mid-gesture can suppress `dragend` in some browsers, which
	 * would strand the drag state if the user dropped outside any term.
	 */
	function isDragged(c: PlannedCourse): boolean {
		return drag.hideSource && c.code === drag.code && drag.fromSemesterId === semester.id;
	}

	/** The list as the advisor sees it mid-drag — the hidden source excluded. */
	let visible = $derived(semester.courses.filter((c) => !isDragged(c)));

	let showGap = $derived(drag.active && drag.overSemesterId === semester.id);

	let gapIndex = $derived(Math.min(drag.overIndex ?? visible.length, visible.length));

	type Entry =
		| { key: string; gap: true }
		| { key: string; gap: false; course: PlannedCourse; hidden: boolean };

	/**
	 * Render the *pending* arrangement rather than the committed one: that is what makes the
	 * other courses slide out of the way while the pointer is still moving. The gap is placed
	 * by counting visible chips, so the hidden source never shifts it.
	 */
	let entries = $derived.by<Entry[]>(() => {
		const out: Entry[] = [];
		let seen = 0;
		let placed = false;
		const maybeGap = () => {
			if (showGap && !placed && seen === gapIndex) {
				out.push({ key: '__gap__', gap: true });
				placed = true;
			}
		};
		for (const c of semester.courses) {
			if (isDragged(c)) {
				out.push({ key: c.code, gap: false, course: c, hidden: true });
				continue;
			}
			maybeGap();
			out.push({ key: c.code, gap: false, course: c, hidden: false });
			seen++;
		}
		maybeGap();
		return out;
	});

	let credits = $derived(semester.courses.reduce((s, c) => s + c.credits, 0));
	/** What the term would carry if the drop happened here — the number the advisor is aiming at. */
	let previewCredits = $derived(
		showGap && drag.fromSemesterId !== semester.id
			? visible.reduce((s, c) => s + c.credits, 0) + creditsOfDragged()
			: credits
	);

	function creditsOfDragged(): number {
		if (!drag.code) return 0;
		const known = catalog.courses.get(drag.code);
		return known?.credits.min ?? 3;
	}

	let termIssues = $derived(issues.filter((i) => i.semesterId === semester.id && !i.course));

	let loadTone = $derived(
		previewCredits > maxCredits
			? 'text-red-700 bg-red-100'
			: previewCredits === 0
				? 'text-slate-400 bg-slate-100'
				: 'text-slate-700 bg-slate-100'
	);

	/** How many chips sit above the pointer — that is where the course would land. */
	function indexFor(clientY: number): number {
		const mids = drag.geometry.get(semester.id) ?? [];
		let i = 0;
		while (i < mids.length && clientY > mids[i]) i++;
		return i;
	}

	function drop(e: DragEvent) {
		e.preventDefault();
		if (drag.code && drag.fromSemesterId) {
			onmove(drag.fromSemesterId, semester.id, drag.code, gapIndex);
		}
		drag.end();
	}
</script>

<div
	class="print-page flex min-h-32 flex-col rounded-lg border bg-white shadow-sm transition-colors sm:min-h-56 {showGap
		? 'border-blue-400 ring-1 ring-blue-300'
		: 'border-slate-200'}"
	role="list"
	ondragover={(e) => {
		e.preventDefault();
		// Wait for the geometry snapshot; hit-testing an unsettled layout is what caused the
		// courses to bounce between positions.
		if (drag.active && drag.ready) drag.hoverAt(semester.id, indexFor(e.clientY));
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}}
	ondrop={drop}
>
	<header class="flex items-center justify-between border-b border-slate-100 px-3 py-2">
		<h3 class="text-sm font-semibold text-slate-800">{termLabel(semester)}</h3>
		<div class="flex items-center gap-1">
			<span class="rounded px-1.5 py-0.5 text-xs font-semibold {loadTone}">
				{previewCredits} cr
			</span>
			<button
				type="button"
				class="no-print rounded px-1 text-xs text-slate-300 hover:text-red-600"
				title="Remove this term"
				aria-label="Remove {termLabel(semester)}"
				onclick={() => ondelete(semester.id)}><Icon name="close" /></button
			>
		</div>
	</header>

	<div class="flex flex-1 flex-col gap-1.5 p-2" data-semester-list={semester.id}>
		{#each entries as entry (entry.key)}
			<div
				role="listitem"
				data-chip={entry.gap || entry.hidden ? '0' : '1'}
				class:hidden={!entry.gap && entry.hidden}
				animate:flip={{ duration: 180, easing: cubicOut }}
			>
				{#if entry.gap}
					<div
						class="flex items-center rounded-md border-2 border-dashed border-blue-400 bg-blue-50 px-2 text-xs font-medium text-blue-700"
						style="height: {drag.height}px"
					>
						{drag.label || drag.code}
					</div>
				{:else}
					<CourseChip
						planned={entry.course}
						course={catalog.courses.get(entry.course.code)}
						kind={kindOf(entry.course.code, Boolean(entry.course.placeholder), kindIndex)}
						semesterId={semester.id}
						issues={issues.filter(
							(i) => i.semesterId === semester.id && i.course === entry.course.code
						)}
						onremove={() => onremove(semester.id, entry.course.code)}
						onchoose={() => onchoose(semester.id, entry.course.code)}
						ontogglelock={() => ontogglelock(semester.id, entry.course.code)}
						onactivate={() => onactivate(semester.id, entry.course.code)}
					/>
				{/if}
			</div>
		{/each}

		{#if entries.length === 0}
			<p class="px-1 py-3 text-center text-xs text-slate-400">Drag a course here, or click Add.</p>
		{/if}
	</div>

	{#if termIssues.length}
		<div class="border-t border-slate-100 px-3 py-1.5">
			{#each termIssues as issue}
				<p class="text-xs {issue.severity === 'warning' ? 'text-amber-700' : 'text-slate-500'}">
					{issue.message}
				</p>
			{/each}
		</div>
	{/if}

	<button
		type="button"
		class="no-print border-t border-slate-100 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-blue-700"
		onclick={() => onadd(semester.id)}
	>
		<span class="inline-flex items-center gap-1"><Icon name="plus" />Add course</span>
	</button>
</div>
