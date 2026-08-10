<script lang="ts">
	import { catalog } from '$lib/catalog';
	import Icon from './Icon.svelte';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	const REPO = 'https://github.com/mgrau/semester-planner';
</script>

<!--
	Short on purpose. It covers the things that are not guessable from the interface — what the
	colours mean, why some slots have no course in them, and where the data comes from — rather
	than restating what the buttons say.
-->
{#if open}
	<div
		class="fixed inset-0 z-60 flex items-stretch justify-center bg-slate-900/40 sm:items-start sm:p-4 sm:pt-16"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onclose();
		}}
	>
		<div
			class="flex h-full w-full flex-col overflow-hidden bg-white shadow-xl sm:h-auto sm:max-h-[85vh] sm:max-w-lg sm:rounded-lg"
		>
			<header
				class="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3"
			>
				<h2 class="text-sm font-semibold text-slate-800">How this works</h2>
				<button
					type="button"
					class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
					aria-label="Close"
					onclick={onclose}><Icon name="close" class="h-4 w-4" /></button
				>
			</header>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm text-slate-700">
				<section>
					<h3 class="mb-1 font-semibold text-slate-800">Building a plan</h3>
					<p class="text-slate-600">
						Record what the student already brings under <strong>Credit already earned</strong> —
						transfer coursework, a waived requirement, or a course they place past. Then
						<strong>Auto-populate</strong> lays out the remaining terms.
					</p>
					<p class="mt-1 text-slate-600">
						The planner schedules the course with the longest chain of prerequisites behind it
						first, so the maths sequence starts before the physics that depends on it. Drag a
						course to move it, or click it to open its catalog entry and move it from there.
						<strong>Lock</strong> a course to pin it where you put it — re-running Auto-populate works
						around locked courses.
					</p>
				</section>

				<section>
					<h3 class="mb-1 font-semibold text-slate-800">Dashed slots</h3>
					<p class="text-slate-600">
						A dashed slot reserves credits for a requirement without choosing the course. The app
						knows the student owes three credits of Human Creativity; it does not know which course
						they want. Click one to pick from that category's approved list.
					</p>
				</section>

				<section>
					<h3 class="mb-1 font-semibold text-slate-800">Colours</h3>
					<p class="text-slate-600">
						The stripe on each course is its subject, not the requirement it fills: physics,
						mathematics, lab science, computing, general education, elective. A red or amber
						background means something in <strong>Notes</strong> concerns that course.
					</p>
				</section>

				<section>
					<h3 class="mb-1 font-semibold text-slate-800">What to check yourself</h3>
					<p class="text-slate-600">
						Course data is scraped from the ODU catalog ({catalog.catalogYear}), and some
						prerequisites are written as prose the importer cannot fully interpret. Those courses
						say so in <strong>Notes</strong>. Term availability is recorded by hand where the
						catalog omits it. Treat this as an advising aid and confirm against DegreeWorks and the
						catalog before registration.
					</p>
				</section>

				<section>
					<h3 class="mb-1 font-semibold text-slate-800">Where plans live</h3>
					<p class="text-slate-600">
						In this browser, on this machine — there is no server. Use <strong>.yaml</strong> to move
						a student to another machine or to keep a copy; a printed PDF carries the plan too, and
						can be loaded back with <strong>Import</strong> — or by dropping the file anywhere on
						the page.
					</p>
				</section>
			</div>

			<footer class="shrink-0 border-t border-slate-100 px-4 py-3">
				<a
					href={REPO}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline"
				>
					<Icon name="switch" />Source code and issues on GitHub
				</a>
			</footer>
		</div>
	</div>
{/if}
