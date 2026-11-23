// Pain-T's misses and miss margin (D5, D7 of the fork's ROADMAP.md), with nothing that needs a browser, so
// test/paint-hard/miss-model.mjs can check them in Node.
// Auto copy and M miss 90% of the pixels they paint at the start, and each Progressive Auto Copy Accuracy takes off 10
// points. A miss paints, in each channel, a shade you can paint now within the miss margin of the right one, drawn
// evenly, so drawing the right shade in every channel lands right anyway. The margin starts at 255, and each Progressive
// Miss Margin lowers it by the seed's miss_margin_step, to 0 at the last copy.

export const ACCURACY_ITEMS = 9;
export const START_MISS_PERCENT = 90;
export const START_MARGIN = 255;

/** The miss chance in percent with `copies` Progressive Auto Copy Accuracy. */
export function miss_percent(copies) {
	return Math.max(0, START_MISS_PERCENT - 10 * Math.min(copies, ACCURACY_ITEMS));
}

/** The miss margin with `copies` Progressive Miss Margin at `step` levels a copy. */
export function miss_margin(copies, step) {
	return Math.max(0, START_MARGIN - step * copies);
}

/**
 * For one channel's rounding table (the shade each of 0-255 rounds to): the shades it paints, in order, and for each
 * value the first and last index of the shades within `margin` of it.
 */
export function margin_ranges(table, margin) {
	const shades = Uint8Array.from(new Set(table)).sort();
	const lo = new Int16Array(256), hi = new Int16Array(256);
	for (let value = 0; value < 256; value++) {
		let first = 0, last = shades.length - 1;
		while (first < last && shades[first] < value - margin) first++;
		while (last > first && shades[last] > value + margin) last--;
		lo[value] = first;
		hi[value] = last;
	}
	return { shades, lo, hi };
}

/** Whether a paint misses, at a miss chance of `percent`, from one draw. */
export function rolls_miss(percent, random) {
	return percent > 0 && random() * 100 < percent;
}

/** A missed channel: one of the shades within the margin of the right one, `right` itself among them. */
export function miss_value(ranges, right, random) {
	const first = ranges.lo[right], last = ranges.hi[right];
	return ranges.shades[first + Math.floor(random() * (last - first + 1))];
}

/** How many shades a miss can draw in a channel whose right shade is `right`: the right one among them. */
export function draws(ranges, right) {
	return ranges.hi[right] - ranges.lo[right] + 1;
}

/**
 * The chance one try paints a pixel right, at a miss chance of `percent`: a hit, or a miss that draws the right shade in
 * every channel, one of `colors` colors it draws evenly. A color that ties the right one in score lands too, and isn't
 * counted, so this is a little low where shades sit evenly either side of the goal.
 */
export function land_chance(percent, colors) {
	return 1 - percent / 100 + percent / 100 / colors;
}

/** A small seeded generator (mulberry32), so tests can repeat a run's misses. Returns numbers in [0, 1). */
export function seeded(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
