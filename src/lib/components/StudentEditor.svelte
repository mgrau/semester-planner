<script lang="ts">
	import { programLabel, programList } from '$lib/catalog';
	import { roster, fullName } from '$lib/stores/roster.svelte';
	import type { Student, Term } from '$lib/types';
	import Icon from './Icon.svelte';

	interface Props {
		/** The student being edited, or null when the dialog is closed. */
		student: Student | null;
		/** Rebuilds the term grid from the start term — destructive, so it lives behind a confirm. */
		onrebuild: () => void;
		onclose: () => void;
	}
	let { student, onrebuild, onclose }: Props = $props();

	/** Edits apply immediately; the dialog is a place to make them, not a transaction. */
	function edit(fn: (s: Student) => void) {
		if (student) roster.updateStudent(student.id, fn);
	}
</script>

{#if student}
	<div
		class="fixed inset-0 z-60 flex items-end justify-center bg-slate-900/40 sm:items-start sm:p-4 sm:pt-24"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onclose();
		}}
	>
		<div class="max-h-[90vh] w-full overflow-y-auto rounded-t-xl bg-white shadow-xl sm:max-w-sm sm:rounded-lg">
			<header class="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
				<h2 class="text-sm font-semibold text-slate-800">Edit {fullName(student)}</h2>
				<button
					type="button"
					class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
					aria-label="Close"
					onclick={onclose}><Icon name="close" class="h-4 w-4" /></button
				>
			</header>

			<div class="space-y-2 p-4 text-xs">
				<div class="grid grid-cols-2 gap-2">
					<label class="block">
						<span class="text-slate-600">First name</span>
						<!-- svelte-ignore a11y_autofocus -->
						<input
							autofocus
							class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
							value={student.firstName ?? ''}
							onchange={(e) => edit((s) => (s.firstName = e.currentTarget.value))}
						/>
					</label>
					<label class="block">
						<span class="text-slate-600">Last name</span>
						<input
							class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
							value={student.lastName ?? ''}
							onchange={(e) => edit((s) => (s.lastName = e.currentTarget.value))}
						/>
					</label>
				</div>

				<label class="block">
					<span class="text-slate-600">Student ID</span>
					<input
						class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
						placeholder="UIN"
						value={student.studentId ?? ''}
						onchange={(e) => edit((s) => (s.studentId = e.currentTarget.value))}
					/>
				</label>

				<label class="block">
					<span class="text-slate-600">Major</span>
					<select
						class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
						value={student.programId}
						onchange={(e) => edit((s) => (s.programId = e.currentTarget.value))}
					>
						{#each programList as p}
							<option value={p.id}>{programLabel(p.id)}</option>
						{/each}
					</select>
				</label>

				<div class="grid grid-cols-2 gap-2">
					<label class="block">
						<span class="text-slate-600">Start term</span>
						<select
							class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
							value={student.startTerm}
							onchange={(e) => edit((s) => (s.startTerm = e.currentTarget.value as Term))}
						>
							<option value="fall">Fall</option>
							<option value="spring">Spring</option>
						</select>
					</label>
					<label class="block">
						<span class="text-slate-600">Start year</span>
						<input
							type="number"
							class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
							value={student.startYear}
							onchange={(e) => edit((s) => (s.startYear = +e.currentTarget.value))}
						/>
					</label>
				</div>

				<!-- The planner's constraints live here rather than in a pane of their own: they
				     are set once when a student is created and rarely touched after. -->
				<fieldset class="mt-1 rounded border border-slate-200 p-2">
					<legend class="px-1 text-slate-600">Planning</legend>
					<div class="grid grid-cols-2 gap-2">
						<label class="block">
							<span class="text-slate-600">Max credits/term</span>
							<input
								type="number"
								class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
								value={student.settings.maxCreditsPerTerm}
								onchange={(e) => edit((s) => (s.settings.maxCreditsPerTerm = +e.currentTarget.value))}
							/>
						</label>
						<label class="block">
							<span class="text-slate-600">Target years</span>
							<input
								type="number"
								class="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
								value={student.settings.targetYears}
								onchange={(e) => edit((s) => (s.settings.targetYears = +e.currentTarget.value))}
							/>
						</label>
					</div>
					<!-- Changing the start term does not rewrite an existing plan on its own; that is
					     this button, which is deliberate because it discards placed courses. -->
					<button
						type="button"
						class="mt-2 w-full rounded border border-slate-300 py-1 hover:bg-slate-50"
						onclick={() => {
							if (
								confirm('Rebuild the terms from the start term? Courses already placed are removed.')
							)
								onrebuild();
						}}>Rebuild empty terms</button
					>
				</fieldset>

				<button
					type="button"
					class="mt-1 w-full rounded bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
					onclick={onclose}>Done</button
				>
			</div>
		</div>
	</div>
{/if}
