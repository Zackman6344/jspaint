// The client's calculate_similarity() as it was at d5bd9d7, before task 7.1, kept as the reference the new scoring is
// checked against: by test/paint-hard/scoring.mjs in Node, and by scoring.e2e.mjs in the page on the page's own reads.
// The loop is copied as it was; only its inputs are arrays here, where it read the canvases itself. `canvas` is a read of
// the whole canvas, and `goal` a read of the goal canvas at the goal's full size, as the old loop took them. It returns
// the similarity and both views at the goal's size, as the old loop put them.
// Nothing here needs a browser, and nothing outside test/ imports it.

export function reference_similarity(canvas, canvas_width, canvas_height, goal, final_width, final_height, before_0_2_0, before_0_5_0) {
	var s = 0;
	var main_canvas = { width: canvas_width, height: canvas_height };
	var main_pixels = { data: canvas };
	var goal_pixels = { data: new Uint8ClampedArray(goal) }; // a copy, as getImageData() gave one: the loop writes the Difference view into it
	var sim_pixels = { data: new Uint8ClampedArray(final_width * final_height * 4) };
	var diff_pixels = goal_pixels;
	for (var x = 0; x < final_width; x++) {
		for (var y = 0; y < final_height; y++) {
			var goal_offset = (x + y * final_width) * 4;
			if (x < main_canvas.width && y < main_canvas.height) {
				var main_offset = (x + y * main_canvas.width) * 4;
				var pixel_similarity = 0;
				if (before_0_2_0) {
					pixel_similarity = 1 - (Math.abs(main_pixels.data[main_offset] - goal_pixels.data[goal_offset]) +
						Math.abs(main_pixels.data[main_offset + 1] - goal_pixels.data[goal_offset + 1]) +
						Math.abs(main_pixels.data[main_offset + 2] - goal_pixels.data[goal_offset + 2])) / 765;
				}
				else {
					pixel_similarity = 1 - Math.sqrt(((main_pixels.data[main_offset] - goal_pixels.data[goal_offset]) ** 2 +
						(main_pixels.data[main_offset + 1] - goal_pixels.data[goal_offset + 1]) ** 2 +
						(main_pixels.data[main_offset + 2] - goal_pixels.data[goal_offset + 2]) ** 2) / 3) / 255;
				}
				sim_pixels.data[goal_offset] = sim_pixels.data[goal_offset + 1] = sim_pixels.data[goal_offset + 2] = 255 * pixel_similarity;
				sim_pixels.data[goal_offset + 3] = 255;
				diff_pixels.data[goal_offset] = 128 + goal_pixels.data[goal_offset] - main_pixels.data[main_offset];
				diff_pixels.data[goal_offset + 1] = 128 + goal_pixels.data[goal_offset + 1] - main_pixels.data[main_offset + 1];
				diff_pixels.data[goal_offset + 2] = 128 + goal_pixels.data[goal_offset + 2] - main_pixels.data[main_offset + 2];
				if (!before_0_5_0) pixel_similarity = 2 * pixel_similarity - 1;
				s += pixel_similarity;
			}
			else {
				if (before_0_5_0)
					sim_pixels.data[goal_offset] = sim_pixels.data[goal_offset + 1] = sim_pixels.data[goal_offset + 2] = 0;
				else
					sim_pixels.data[goal_offset] = sim_pixels.data[goal_offset + 1] = sim_pixels.data[goal_offset + 2] = 128;
			}
		}
	}
	s *= 100 / (final_width * final_height);
	return { similarity: s, sim: sim_pixels.data, diff: diff_pixels.data };
}

// Auto copy's and M's score for a pixel they paint, as src/auto-copy.js had it at d5bd9d7: the 0.5.0+ score only.
export function reference_pixel_score(dr, dg, db) {
	return 2 * (1 - Math.sqrt((dr ** 2 + dg ** 2 + db ** 2) / 3) / 255) - 1;
}

// What a view shows: a pixel with alpha 0 shows nothing, whatever its color bytes, and a canvas reads it back as 0,0,0,0.
// Returns how many pixels of two views of one size show differently.
export function visible_differences(a, b) {
	let differ = 0;
	for (let i = 0; i < a.length; i += 4) {
		if (a[i + 3] !== b[i + 3] || (a[i + 3] && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]))) differ++;
	}
	return differ;
}

/** Checks are sent in units of 0.0001%, as send() in src/archipelago.js counts them. */
export const send_units = (similarity) => Math.floor(similarity * 10000 + 1e-7);
