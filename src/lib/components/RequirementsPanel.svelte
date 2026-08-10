<script lang="ts">
	import type { Progress } from '$lib/engine/requirements';
	import Icon from './Icon.svelte';

	interface Props {
		title: string;
		items: Progress[];
		onpick?: (requirementId: string) => void;
		/** Stretch to the available height and scroll internally, instead of growing the page. */
		fill?: boolean;
		/** Collapse to a tappable header below `lg`. Always open on a wide screen. */
		collapsible?: boolean;
	}

	let { title, items, onpick, fill = false, collapsible = false }: Props = $props();

	let done = $derived(items.filter((i) => i.satisfied).length);

	/** Only consulted below `lg`; the pane is always shown at desktop width. */
	let isOpen = $state(false);

	/** Which row has its detail popover open. Catalog prose is long; only one at a time. */
	let openDetail = $state<string | null>(null);
</script>

<section
	class="rounded-lg border border-slate-200 bg-white shadow-sm {fill
		? 'lg:flex lg:min-h-0 lg:flex-1 lg:flex-col'
		: ''}"
>
	{#if collapsible}
		<!-- Below `lg` the header doubles as the disclosure control; the count stays visible so a
		     closed pane still says how much is left. -->
		<button
			type="button"
			class="flex w-full shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2.5 lg:hidden"
			aria-expanded={isOpen}
			onclick={() => (isOpen = !isOpen)}
		>
			<h3 class="text-sm font-semibold text-slate-800">{title}</h3>
			<span class="flex items-center gap-2">
				<span class="text-xs text-slate-500">{done}/{items.length} met</span>
				<Icon name={isOpen ? 'chevron-down' : 'chevron-right'} class="h-4 w-4 text-slate-400" />
			</span>
		</button>
	{/if}

	<header
		class="shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2 {collapsible
			? 'hidden lg:flex'
			: 'flex'}"
	>
		<h3 class="text-sm font-semibold text-slate-800">{title}</h3>
		<span class="text-xs text-slate-500">{done}/{items.length} met</span>
	</header>

	<ul
		class="divide-y divide-slate-50 {fill ? 'lg:min-h-0 lg:flex-1 lg:overflow-y-auto' : ''} {collapsible &&
		!isOpen
			? 'hidden lg:block'
			: ''}"
	>
		{#each items as item, i (item.id)}
			{@const total = item.requiredCredits || 1}
			{@const earnedPct = Math.min(100, (item.earnedCredits / total) * 100)}
			{@const reservedPct = Math.min(100 - earnedPct, (item.plannedCredits / total) * 100)}
			{@const reservedOnly = item.satisfied && item.plannedCredits > 0}
			{@const showSection = item.section && item.section !== items[i - 1]?.section}

			{#if showSection}
				<li class="bg-slate-50 px-3 py-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
					{item.section}
				</li>
			{/if}

			<li class="relative px-3 py-2">
				<div class="flex items-baseline justify-between gap-2">
					<span
						class="flex items-start gap-1.5 text-sm {item.satisfied
							? 'text-slate-500'
							: 'font-medium text-slate-800'}"
					>
						<span
							class="mt-0.5 shrink-0 {item.satisfied
								? reservedOnly
									? 'text-amber-500'
									: 'text-emerald-600'
								: 'text-slate-300'}"
						>
							<Icon name={item.satisfied ? (reservedOnly ? 'half' : 'check') : 'circle'} />
						</span>
						{item.name}
					</span>
					<span class="flex shrink-0 items-center gap-1">
						{#if item.notes}
							<button
								type="button"
								class="no-print rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-blue-700"
								title="Catalog details"
								onclick={() => (openDetail = openDetail === item.id ? null : item.id)}
							>
								<span class="inline-flex items-center gap-0.5"><Icon name="info" class="h-3 w-3" />more</span>
							</button>
						{/if}
						<span class="text-xs text-slate-500">
							{item.earnedCredits + item.plannedCredits}/{item.requiredCredits} cr
						</span>
					</span>
				</div>

				<div class="mt-1 flex h-1 w-full overflow-hidden rounded bg-slate-100">
					<div
						class="h-full {item.satisfied && !reservedOnly ? 'bg-emerald-500' : 'bg-blue-500'}"
						style="width: {earnedPct}%"
					></div>
					<!-- Reserved-but-unchosen credits read as striped, never as solid progress. -->
					<div
						class="h-full bg-amber-400/50 bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,rgba(255,255,255,.7)_2px,rgba(255,255,255,.7)_4px)]"
						style="width: {reservedPct}%"
					></div>
				</div>

				{#if item.plannedCredits > 0}
					<p class="mt-1 text-xs text-amber-700">
						{item.plannedCredits} cr reserved — course not chosen yet
					</p>
				{/if}
				{#if item.assigned.length}
					<p class="mt-1 text-xs text-slate-500">{item.assigned.join(', ')}</p>
				{/if}
				{#if !item.satisfied && item.missing.length}
					<p class="mt-1 text-xs text-slate-600">
						Needs: <span class="font-medium">{item.missing.join(', ')}</span>
					</p>
				{/if}
				{#if !item.satisfied && !item.missing.length && item.options?.length}
					<button
						type="button"
						class="no-print mt-1 text-xs text-blue-700 hover:underline"
						onclick={() => onpick?.(item.id)}
					>
						Choose from {item.options.length} approved courses →
					</button>
				{/if}

				{#if openDetail === item.id && item.notes}
					<!-- Popover, not inline: the catalog text is often several paragraphs. -->
					<div
						class="absolute right-2 left-2 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white p-3 text-xs whitespace-pre-line text-slate-600 shadow-lg sm:left-auto sm:w-80"
					>
						<div class="mb-1 flex items-start justify-between gap-2">
							<span class="font-semibold text-slate-800">{item.name}</span>
							<button
								type="button"
								class="shrink-0 text-slate-400 hover:text-slate-700"
								onclick={() => (openDetail = null)}><Icon name="close" /></button
							>
						</div>
						{item.notes}
						{#if item.options?.length}
							<p class="mt-2 border-t border-slate-100 pt-2 text-slate-500">
								<span class="font-medium">Approved:</span>
								{item.options.slice(0, 40).join(', ')}{item.options.length > 40
									? `, +${item.options.length - 40} more`
									: ''}
							</p>
						{/if}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
</section>
