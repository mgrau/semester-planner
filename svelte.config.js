import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Unix seconds at which this build was made, stamped into the bundle so a long-open tab can tell
 * how old its code is and reload itself once a newer build exists. See src/lib/selfUpdate.ts.
 *
 * It has to be the SAME value every time this config is evaluated. SvelteKit loads it more than
 * once per build, and a stamp that changed between those passes left the client convinced it was
 * already out of date — which sends it down a reload path that expects server data an SSR-less
 * SPA never has, and the app died before it could mount. Writing it back to the environment keeps
 * later evaluations on the first value; the deploy workflow sets it outright.
 */
process.env.BUILD_STAMP ||= String(Math.floor(Date.now() / 1000));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Static SPA: plans live in the browser, so there is nothing to render on a server.
		adapter: adapter({ fallback: 'index.html' }),
		prerender: { entries: [] },
		// A GitHub project page is served from /<repo>/, so the app has to know its prefix.
		// Set by the deploy workflow; empty for local dev and for a user/organisation site.
		paths: { base: process.env.BASE_PATH ?? '' },
		// Checked on demand rather than polled; see startSelfUpdate.
		version: { name: process.env.BUILD_STAMP, pollInterval: 0 }
	}
};

export default config;
