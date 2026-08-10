import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

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
		// Stamped into the bundle so a long-open tab can tell how old its code is and reload
		// itself once a newer build exists. See src/lib/selfUpdate.ts.
		version: { name: new Date().toISOString(), pollInterval: 0 }
	}
};

export default config;
