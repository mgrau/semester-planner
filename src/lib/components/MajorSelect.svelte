<script lang="ts">
	import { programLabel, programList } from '$lib/catalog';
	import Icon from './Icon.svelte';

	interface Props {
		value: string;
		onchange: (programId: string) => void;
	}
	let { value, onchange }: Props = $props();

	let open = $state(false);
	let query = $state('');
	let input = $state<HTMLInputElement | null>(null);

	let matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const all = programList.map((p) => ({ id: p.id, label: programLabel(p.id) }));
		if (!q) return all;
		return all.filter((p) => p.label.toLowerCase().includes(q));
	});

	function start() {
		open = true;
		query = '';
		queueMicrotask(() => {
			input?.focus();
			input?.select();
		});
	}

	function pick(id: string) {
		open = false;
		if (id !== value) onchange(id);
	}
</script>

<!--
	The major reads as text until you click it, then becomes a filter box over the programs.
	Switching majors is a thing advisors do while comparing plans, and a dropdown you can type
	into beats hunting through a dialog for a select.
-->
{#if open}
	<div
		class="relative"
		onfocusout={(e) => {
			// Closing on blur would fire before a click on an option registers; checking whether
			// focus stayed inside the widget keeps the option clickable.
			if (!e.currentTarget.contains(e.relatedTarget as Node | null)) open = false;
		}}
	>
		<input
			bind:this={input}
			bind:value={query}
			placeholder="Filter majors…"
			aria-label="Filter majors"
			class="w-full rounded border border-blue-500 px-1.5 py-0.5 text-xs outline-none"
			onkeydown={(e) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					open = false;
				}
				if (e.key === 'Enter' && matches[0]) pick(matches[0].id);
			}}
		/>
		<ul
			class="absolute right-0 left-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
		>
			{#each matches as m (m.id)}
				<li>
					<button
						type="button"
						class="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-blue-50 {m.id ===
						value
							? 'font-semibold text-blue-700'
							: 'text-slate-700'}"
						onclick={() => pick(m.id)}
					>
						{m.label}
						{#if m.id === value}<Icon name="check" class="h-3 w-3 shrink-0" />{/if}
					</button>
				</li>
			{:else}
				<li class="px-2 py-2 text-xs text-slate-400">No major matches that.</li>
			{/each}
		</ul>
	</div>
{:else}
	<button
		type="button"
		class="group flex min-w-0 items-center gap-1 text-xs text-slate-500 hover:text-blue-700"
		title="Change the major"
		onclick={start}
	>
		<span class="truncate">{programLabel(value)}</span>
		<Icon name="pencil" class="h-3 w-3 shrink-0 text-slate-400 group-hover:text-blue-700" />
	</button>
{/if}
