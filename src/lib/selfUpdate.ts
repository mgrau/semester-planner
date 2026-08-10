import { browser, version } from '$app/environment';
import { updated } from '$app/state';

/**
 * Reload the app when the code running in the tab has gone stale.
 *
 * Advisors leave this open for days at a time, so a tab can easily be running a build from before
 * the last few fixes. Once the loaded code passes MAX_AGE the app starts asking whether a newer
 * one has been deployed, and reloads if so. Plans are written to localStorage on every change, so
 * a reload costs nothing — except anything typed into an open dialog, which is why the caller
 * says when it is a bad moment.
 *
 * There is no reload loop to worry about: a reload gets code with a fresh build stamp, and if the
 * deployed version is the same as the running one nothing happens at all.
 */

/** How old the running code may get before it starts looking for a newer deploy. */
export const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** How often to look again while the tab sits open. */
const RECHECK_MS = 60 * 60 * 1000;

/**
 * `version` is stamped at build time in svelte.config.js, as Unix seconds. A stamp that is not a
 * plain number means the app was built without one, so treat it as new rather than reloading on
 * every check.
 */
export function isStale(buildStamp: string, now: number, maxAge = MAX_AGE_MS): boolean {
	if (!/^\d+$/.test(buildStamp)) return false;
	return now - Number(buildStamp) * 1000 > maxAge;
}

/**
 * Begin watching. `canReloadNow` reports whether the advisor is in the middle of something that a
 * reload would interrupt; a bad moment defers to the next check rather than cancelling.
 * Returns a function that stops the watch.
 */
export function startSelfUpdate(canReloadNow: () => boolean = () => true): () => void {
	if (!browser) return () => {};

	let reloading = false;

	async function check() {
		if (reloading) return;
		if (!isStale(version, Date.now())) return;
		if (!canReloadNow()) return;
		// Compares the deployed build stamp against this one; false means we are already current.
		if (await updated.check()) {
			reloading = true;
			location.reload();
		}
	}

	function onVisible() {
		if (document.visibilityState === 'visible') void check();
	}

	void check();
	document.addEventListener('visibilitychange', onVisible);
	const timer = setInterval(() => void check(), RECHECK_MS);

	return () => {
		document.removeEventListener('visibilitychange', onVisible);
		clearInterval(timer);
	};
}
