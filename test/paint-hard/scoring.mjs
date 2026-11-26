// Checks src/scoring.js, the score task 7.1 moved out of calculate_similarity(), in Node against the loop it replaced
// (scoring-reference.mjs, the client's at d5bd9d7). Each of the five bundled goals is scored against white, black, the
// goal itself, the goal inverted, the goal rounded to 2, 3, 16 and 128 shades, a canvas auto copy left partly done with
// misses, the 5x5 and half starts, a canvas wider and taller than the goal, and two sizes that aren't multiples of 16,
// with no seed and at 0.1.0, 0.4.0 and 1.1.0. Each case reads the canvas over the area it shares with the goal and
// walks the goal as read whole, at the goal's own width, as the page does, and must give the reference's send units, a
// similarity within 1e-9 points of it, and the views the reference showed: the Similarity view where it showed, and the
// Difference view byte for byte.
// Run: node test/paint-hard/scoring.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { L1, RMS, SIGNED, formula_for, pixel_score, score_area, score_row, scored_area, similarity_of } from "../../src/scoring.js";
import { margin_ranges, miss_value, rolls_miss, seeded } from "../../src/misses.js";
import { quantize } from "../../src/shades.js";
import { decodePNG } from "./png.mjs";
import { reference_pixel_score, reference_similarity, send_units, visible_differences } from "./scoring-reference.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failures = 0, checks = 0;
function check(name, ok, detail) {
	checks++;
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// What version_below() in src/archipelago.js says of each version at 0.2.0 and 0.5.0: true for both with no seed.
// scoring.e2e.mjs checks that the page picks the formula from them so.
const VERSIONS = { "no seed": [true, true], "0.1.0": [true, true], "0.4.0": [false, true], "1.1.0": [false, false] };
const GOALS = ["450x800", "600x800", "800x450", "800x600", "800x800"];

// A canvas of w x h, its pixels from fill(x, y) as [r, g, b], opaque.
function canvas_of(w, h, fill) {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
		const [r, g, b] = fill(x, y);
		data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
	}
	return { w, h, data };
}

// getImageData(0, 0, w, h) on an image of iw x ih: pixels past its edges read as transparent black.
function read(image, iw, ih, w, h) {
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < Math.min(h, ih); y++) out.set(image.subarray(y * iw * 4, (y * iw + Math.min(w, iw)) * 4), y * w * 4);
	return out;
}

// putImageData(area, 0, 0) on a view of vw x vh.
function put(view, vw, vh, area, w, h) {
	for (let y = 0; y < Math.min(h, vh); y++) view.set(area.subarray(y * w * 4, (y * w + Math.min(w, vw)) * 4), y * vw * 4);
}

// What calculate_similarity() does with a canvas and the goal, minus the canvas calls: the canvas read over the area
// they share, the goal as read whole, which score_area() walks at the goal's own width (the goal here is always the
// goal canvas's size, so the area never passes it), the score, the score again with no view (as when neither shows),
// and each view as it shows at the goal's size, the Similarity view cleared and the Difference view the goal before the
// area goes on.
function page_scores(canvas, goal, final_width, final_height, formula) {
	const [w, h] = scored_area(canvas.w, canvas.h, final_width, final_height);
	const canvas_read = read(canvas.data, canvas.w, canvas.h, w, h);
	const sim_area = new Uint8ClampedArray(w * h * 4), diff_area = new Uint8ClampedArray(w * h * 4);
	const sum = score_area(formula, canvas_read, goal.data, w, h, sim_area, diff_area, goal.w);
	const hidden_sum = score_area(formula, canvas_read, goal.data, w, h, null, null, goal.w);
	const sim = new Uint8ClampedArray(final_width * final_height * 4);
	put(sim, final_width, final_height, sim_area, w, h);
	const diff = read(goal.data, goal.w, goal.h, final_width, final_height);
	put(diff, final_width, final_height, diff_area, w, h);
	return { similarity: similarity_of(sum, final_width, final_height), hidden: similarity_of(hidden_sum, final_width, final_height), sim, diff };
}

// The canvases each goal is scored against.
function canvases_for(goal) {
	const { w, h, data } = goal;
	const at = (x, y) => (y * w + x) * 4;
	const goal_px = (x, y) => [data[at(x, y)], data[at(x, y) + 1], data[at(x, y) + 2]];
	const rounded = (shades) => (x, y) => goal_px(x, y).map((v) => quantize(v, shades));
	// Auto copy partway through its first pass at 16 shades: 45% of the canvas in scan order, 60% of it missed within a
	// margin of 48, the rest still white.
	const table = Array.from({ length: 256 }, (_, v) => quantize(v, 16)), ranges = margin_ranges(table, 48);
	const random = seeded(7), painted = Math.floor(w * h * 0.45);
	const missed = (x, y) => {
		if (y * w + x >= painted) return [255, 255, 255];
		const right = goal_px(x, y).map((v) => table[v]);
		return rolls_miss(60, random) ? right.map((v) => miss_value(ranges, v, random)) : right;
	};
	const noise = seeded(11);
	return [
		["white", canvas_of(w, h, () => [255, 255, 255])],
		["black", canvas_of(w, h, () => [0, 0, 0])],
		["the goal", canvas_of(w, h, goal_px)],
		["the goal inverted", canvas_of(w, h, (x, y) => goal_px(x, y).map((v) => 255 - v))],
		...[2, 3, 16, 128].map((shades) => [`the goal at ${shades} shades`, canvas_of(w, h, rounded(shades))]),
		["auto copy partway with misses", canvas_of(w, h, missed)],
		["the 5x5 start", canvas_of(5, 5, rounded(2))],
		["the half start", canvas_of(Math.floor(w / 2), Math.floor(h / 2), rounded(3))],
		["wider and taller than the goal", canvas_of(w + 37, h + 21, (x, y) => (x < w && y < h ? rounded(16)(x, y) : [noise() * 256, noise() * 256, noise() * 256]))],
		["333x217", canvas_of(333, 217, rounded(128))],
		[`${w - 7}x${h - 9}`, canvas_of(w - 7, h - 9, (x, y) => (x * 7 + y * 3) % 5 ? rounded(16)(x, y) : [255, 255, 255])],
	];
}

// The pixel formulas: the old auto copy's score to the bit from 0.5.0, and score_row() adding up pixel_score() to the bit.
let unlike = 0;
for (let dr = -255; dr <= 255; dr += 3) for (let dg = -255; dg <= 255; dg += 5) for (let db = -255; db <= 255; db += 7) {
	if (!Object.is(pixel_score(SIGNED, dr, dg, db), reference_pixel_score(dr, dg, db))) unlike++;
}
check("from 0.5.0, a pixel's score is auto copy's old 2(1 - sqrt(...)/255) - 1 to the bit", unlike === 0, `${unlike} of 1,354,948 channel differences score otherwise`);
check("the version picks the L1 score with no seed and before 0.2.0, root-mean-square to 0.4.x, and 2p - 1 from 0.5.0", formula_for(...VERSIONS["no seed"]) === L1 && formula_for(...VERSIONS["0.1.0"]) === L1 && formula_for(...VERSIONS["0.4.0"]) === RMS && formula_for(...VERSIONS["1.1.0"]) === SIGNED);

const decoded = GOALS.map((name) => {
	const { w, h, rgba } = decodePNG(path.join(ROOT, "images", "archipelago", `${name}.png`));
	return { name, w, h, data: new Uint8ClampedArray(rgba.buffer) };
});
{
	const goal = decoded[3], canvas = canvases_for(goal).find(([name]) => name === "auto copy partway with misses")[1];
	let rows_unlike = 0;
	for (const formula of [L1, RMS, SIGNED]) for (let y = 0; y < goal.h; y++) {
		let sum = 0;
		for (let x = 0, i = y * goal.w * 4; x < goal.w; x++, i += 4) sum += pixel_score(formula, canvas.data[i] - goal.data[i], canvas.data[i + 1] - goal.data[i + 1], canvas.data[i + 2] - goal.data[i + 2]);
		if (!Object.is(sum, score_row(formula, canvas.data, y * goal.w * 4, goal.data, y * goal.w * 4, goal.w))) rows_unlike++;
	}
	check("a rescore's row sums are the sums of the pixel scores auto copy and M add, to the bit, in each formula", rows_unlike === 0, `${rows_unlike} of ${3 * goal.h} rows differ`);
}

// Every goal, canvas and version against the reference.
let worst = 0;
for (const goal of decoded) {
	const cases = canvases_for(goal);
	const failed = { units: [], sums: [], hidden: [], sim: [], diff: [] };
	for (const [name, canvas] of cases) for (const [version, [b2, b5]] of Object.entries(VERSIONS)) {
		const want = reference_similarity(canvas.data, canvas.w, canvas.h, read(goal.data, goal.w, goal.h, goal.w, goal.h), goal.w, goal.h, b2, b5);
		const got = page_scores(canvas, goal, goal.w, goal.h, formula_for(b2, b5));
		const label = `${name} at ${version}`;
		const gap = Math.abs(got.similarity - want.similarity);
		worst = Math.max(worst, gap);
		if (send_units(got.similarity) !== send_units(want.similarity)) failed.units.push(`${label}: ${got.similarity} vs ${want.similarity}`);
		if (!(gap <= 1e-9)) failed.sums.push(`${label}: off by ${gap}`);
		if (!Object.is(got.hidden, got.similarity)) failed.hidden.push(label);
		const sim = visible_differences(got.sim, want.sim);
		if (sim) failed.sim.push(`${label}: ${sim} pixels`);
		let diff = 0;
		for (let i = 0; i < want.diff.length; i++) if (got.diff[i] !== want.diff[i]) diff++;
		if (diff || got.diff.length !== want.diff.length) failed.diff.push(`${label}: ${diff} bytes`);
	}
	const n = cases.length * Object.keys(VERSIONS).length;
	const say = (list) => (list.length ? list.slice(0, 3).join("; ") : `${n} cases`);
	check(`${goal.name}: the reference's send units on every canvas and version`, failed.units.length === 0, say(failed.units));
	check(`${goal.name}: similarities within 1e-9 points of the reference's`, failed.sums.length === 0, say(failed.sums));
	check(`${goal.name}: the same similarity with no view worked out`, failed.hidden.length === 0, say(failed.hidden));
	check(`${goal.name}: the Similarity view shows what the reference's showed`, failed.sim.length === 0, say(failed.sim));
	check(`${goal.name}: the Difference view is the reference's byte for byte`, failed.diff.length === 0, say(failed.diff));
}
console.log(`worst similarity difference from the reference: ${worst.toExponential(2)} points`);

// How much less JS a rescore runs at 800x600 with no view showing: the reference loop against the new one, on the goal
// against the canvas auto copy left partway. Printed only; scoring.e2e.mjs times it in the page.
{
	const goal = decoded[3], canvas = canvases_for(goal).find(([name]) => name === "auto copy partway with misses")[1];
	const median = (f) => { f(); const t = []; for (let k = 0; k < 7; k++) { const a = performance.now(); f(); t.push(performance.now() - a); } return t.sort((a, b) => a - b)[3]; };
	const old_ms = median(() => reference_similarity(canvas.data, goal.w, goal.h, goal.data, goal.w, goal.h, false, false));
	const new_ms = median(() => score_area(SIGNED, canvas.data, goal.data, goal.w, goal.h));
	console.log(`800x600 in Node: the old loop ${old_ms.toFixed(1)} ms, the new score with no view ${new_ms.toFixed(1)} ms`);
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
