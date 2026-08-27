<script lang="ts">
	import type { ImportSummary } from '$lib/import/bannerPlus';
	import { programLabel } from '$lib/catalog';
	import Icon from './Icon.svelte';

	interface Props {
		/** The summary of what would happen, or null when there is nothing to confirm. */
		summary: ImportSummary | null;
		/** Set instead when the link could not be used at all. */
		error: string | null;
		onconfirm: () => void;
		onclose: () => void;
	}
	let { summary, error, onconfirm, onclose }: Props = $props();

	/** "three weeks ago" — a stale link is worth noticing before its contents are applied. */
	function age(iso: string | undefined): string {
		if (!iso) return '';
		const then = Date.parse(iso);
		if (Number.isNaN(then)) return '';
		const days = Math.floor((Date.now() - then) / 86_400_000);
		if (days <= 0) return 'today';
		if (days === 1) return 'yesterday';
		if (days < 31) return `${days} days ago`;
		const months = Math.round(days / 30);
		return months === 1 ? 'a month ago' : `${months} months ago`;
	}
</script>

{#if summary || error}
	<div
		class="fixed inset-0 z-60 flex items-end justify-center bg-slate-900/40 sm:items-start sm:p-4 sm:pt-20"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onclose();
		}}
	>
		<div
			class="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-md sm:rounded-lg"
		>
			<header class="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
				<h2 class="text-sm font-semibold text-slate-800">
					{error ? 'Cannot import that link' : summary!.action === 'create' ? 'Add this advisee?' : 'Update this advisee?'}
				</h2>
				<button
					type="button"
					class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
					aria-label="Close"
					onclick={onclose}><Icon name="close" class="h-4 w-4" /></button
				>
			</header>

			<div class="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs text-slate-600">
				{#if error}
					<p class="text-slate-700">{error}</p>
				{:else if summary}
					{@const s = summary}
					<p class="text-sm font-medium text-slate-800">{s.name}</p>
					<p class="text-slate-500">
						UIN {s.uin}{#if s.generated}&nbsp;· read from Banner {age(s.generated)}{/if}
					</p>

					<dl class="mt-3 space-y-1">
						<div class="flex justify-between gap-3">
							<dt>Terms</dt>
							<dd class="text-right text-slate-800">
								{s.terms.length > 1
									? `${s.terms[0]} – ${s.terms[s.terms.length - 1]}`
									: s.terms[0]}
								<span class="text-slate-400">({s.terms.length})</span>
							</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt>Courses</dt>
							<dd class="text-slate-800">
								{s.courseCount - s.withdrawnCount}
								{#if s.withdrawnCount}
									<span class="text-slate-400">
										({s.withdrawnCount} withdrawn, not imported)</span
									>
								{/if}
							</dd>
						</div>
						{#if s.action === 'create' && s.programId}
							<div class="flex justify-between gap-3">
								<dt>Major</dt>
								<dd class="text-slate-800">{programLabel(s.programId)}</dd>
							</div>
						{/if}
						{#if s.action === 'update'}
							{#if s.addedTerms.length}
								<div class="flex justify-between gap-3">
									<dt>Terms added</dt>
									<dd class="text-right text-slate-800">{s.addedTerms.join(', ')}</dd>
								</div>
							{/if}
							{#if s.keptCourses}
								<div class="flex justify-between gap-3">
									<dt>Your own entries kept</dt>
									<dd class="text-slate-800">{s.keptCourses}</dd>
								</div>
							{/if}
							{#if s.untouchedTerms}
								<div class="flex justify-between gap-3">
									<dt>Planned terms left alone</dt>
									<dd class="text-slate-800">{s.untouchedTerms}</dd>
								</div>
							{/if}
						{/if}
					</dl>

					{#if s.action === 'update'}
						<p class="mt-3 rounded bg-slate-50 px-2.5 py-2 text-slate-500">
							Registration records replace the ones a previous import wrote. Notes, earned credit,
							placements and every term after {s.terms[s.terms.length - 1]} are untouched.
						</p>
					{/if}

					{#if s.conflicts.length}
						<!-- Banner's major and admit term seed a new record; on an existing one they are a
						     suggestion, since an advisor who changed the program did so for a reason. -->
						<div class="mt-3 rounded border border-amber-300 bg-amber-50 p-2.5 text-amber-900">
							<p class="font-medium">Banner disagrees with what is stored — not changed:</p>
							<ul class="mt-1 space-y-0.5">
								{#each s.conflicts as c (c.field)}
									<li>
										{c.field}: <span class="font-medium">{c.stored}</span> here, Banner says
										<span class="font-medium"
											>{c.field === 'Major' ? programLabel(c.incoming) : c.incoming}</span
										>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if s.programUnmapped}
						<p class="mt-3 rounded border border-amber-300 bg-amber-50 p-2.5 text-amber-900">
							Banner's major does not match a program this planner knows, so none was chosen. Pick
							one in the requirements panel after importing.
						</p>
					{/if}

					{#if s.unknownCourses.length}
						<p class="mt-3 rounded border border-slate-200 bg-slate-50 p-2.5">
							Not in the {new Date().getFullYear()} catalog, imported as-is:
							<span class="text-slate-700">{s.unknownCourses.join(', ')}</span>
						</p>
					{/if}
				{/if}
			</div>

			<footer class="flex shrink-0 gap-2 border-t border-slate-100 px-4 py-3">
				{#if summary && !error}
					<button
						type="button"
						class="flex-1 rounded bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
						onclick={onconfirm}
						>{summary.action === 'create' ? 'Add advisee' : 'Update advisee'}</button
					>
				{/if}
				<button
					type="button"
					class="flex-1 rounded border border-slate-300 py-1.5 text-xs hover:bg-slate-50"
					onclick={onclose}>{error ? 'Close' : 'Cancel'}</button
				>
			</footer>
		</div>
	</div>
{/if}
