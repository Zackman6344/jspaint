// Pain-T's similarity score (task 7.1 of the fork's ROADMAP.md), with nothing that needs a browser, so
// test/paint-hard/scoring.mjs can check it in Node against the loop it replaced. calculate_similarity() in functions.js
// scores the canvas through it, and auto copy and M score each pixel they paint through it, so the running total and a
// full rescore use one formula.
// A seed's version picks the formula: the L1 score before 0.2.0 and on a page with no seed, the root-mean-square score
// from 0.2.0, and from 0.5.0 that score stretched from 0..1 to -1..1. Pixels are RGBA bytes, the canvas's and the goal's.

export const L1 = "l1", RMS = "rms", SIGNED = "signed";

/** The formula for a seed, from whether its version is below 0.2.0 and below 0.5.0, as version_below() reads it. */
export function formula_for(before_0_2_0, before_0_5_0) {
	return before_0_2_0 ? L1 : before_0_5_0 ? RMS : SIGNED;
}

/** A pixel's likeness to the goal's, from 0 to 1, from the canvas minus the goal in each channel. The Similarity view shows it. */
export function likeness(formula, dr, dg, db) {
	if (formula === L1) return 1 - (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 765;
	return 1 - Math.sqrt((dr * dr + dg * dg + db * db) / 3) / 255;
}

/** A pixel's score: its likeness, and from 0.5.0 on 2 × likeness − 1, from the canvas minus the goal in each channel. */
export function pixel_score(formula, dr, dg, db) {
	const p = likeness(formula, dr, dg, db);
	return formula === SIGNED ? 2 * p - 1 : p;
}

/**
 * The sum of the scores of `width` pixels in a row: the canvas's from byte `canvas_at` of `canvas`, the goal's from byte
 * `goal_at` of `goal`. Each formula has its own loop, with pixel_score()'s arithmetic written out.
 */
export function score_row(formula, canvas, canvas_at, goal, goal_at, width) {
	let sum = 0;
	const end = canvas_at + width * 4;
	if (formula === L1) {
		for (let i = canvas_at, j = goal_at; i < end; i += 4, j += 4) {
			sum += 1 - (Math.abs(canvas[i] - goal[j]) + Math.abs(canvas[i + 1] - goal[j + 1]) + Math.abs(canvas[i + 2] - goal[j + 2])) / 765;
		}
	} else if (formula === RMS) {
		for (let i = canvas_at, j = goal_at; i < end; i += 4, j += 4) {
			const dr = canvas[i] - goal[j], dg = canvas[i + 1] - goal[j + 1], db = canvas[i + 2] - goal[j + 2];
			sum += 1 - Math.sqrt((dr * dr + dg * dg + db * db) / 3) / 255;
		}
	} else {
		for (let i = canvas_at, j = goal_at; i < end; i += 4, j += 4) {
			const dr = canvas[i] - goal[j], dg = canvas[i + 1] - goal[j + 1], db = canvas[i + 2] - goal[j + 2];
			sum += 2 * (1 - Math.sqrt((dr * dr + dg * dg + db * db) / 3) / 255) - 1;
		}
	}
	return sum;
}

/** Writes the Similarity view over a row into `out` from byte `out_at`: each pixel's likeness as a gray level, opaque. */
export function similarity_row(formula, canvas, canvas_at, goal, goal_at, width, out, out_at) {
	for (let x = 0, i = canvas_at, j = goal_at, o = out_at; x < width; x++, i += 4, j += 4, o += 4) {
		out[o] = out[o + 1] = out[o + 2] = 255 * likeness(formula, canvas[i] - goal[j], canvas[i + 1] - goal[j + 1], canvas[i + 2] - goal[j + 2]);
		out[o + 3] = 255;
	}
}

/** Writes the Difference view over a row into `out` from byte `out_at`: 128 plus the goal minus the canvas in each channel, with the goal's alpha. */
export function difference_row(canvas, canvas_at, goal, goal_at, width, out, out_at) {
	for (let x = 0, i = canvas_at, j = goal_at, o = out_at; x < width; x++, i += 4, j += 4, o += 4) {
		out[o] = 128 + goal[j] - canvas[i];
		out[o + 1] = 128 + goal[j + 1] - canvas[i + 1];
		out[o + 2] = 128 + goal[j + 2] - canvas[i + 2];
		out[o + 3] = goal[j + 3];
	}
}

/** The area a rescore scores, from the top-left: as wide and as tall as both the canvas and the goal. */
export function scored_area(canvas_width, canvas_height, goal_width, goal_height) {
	return [Math.min(canvas_width, goal_width), Math.min(canvas_height, goal_height)];
}

/**
 * Scores a read of the canvas over a `width` × `height` area from the top-left against a read of the goal from its
 * top-left, `goal_width` pixels a row (the area's own width when the goal was read over the area), row by row with a
 * subtotal a row. Fills each view given, a Uint8ClampedArray of the area, as it goes. Returns the sum of the pixel scores.
 */
export function score_area(formula, canvas, goal, width, height, similarity_view = null, difference_view = null, goal_width = width) {
	let sum = 0;
	for (let y = 0, at = 0, goal_at = 0, step = width * 4, goal_step = goal_width * 4; y < height; y++, at += step, goal_at += goal_step) {
		sum += score_row(formula, canvas, at, goal, goal_at, width);
		if (similarity_view) similarity_row(formula, canvas, at, goal, goal_at, width, similarity_view, at);
		if (difference_view) difference_row(canvas, at, goal, goal_at, width, difference_view, at);
	}
	return sum;
}

/** The similarity in percent that a sum of pixel scores makes over a goal of `goal_width` × `goal_height`. */
export function similarity_of(sum, goal_width, goal_height) {
	return sum * (100 / (goal_width * goal_height));
}
