// Checks src/misses.js, the miss chance and miss margin of D7, in Node: D7's table of what a miss can paint around a
// right shade of 128, the miss chance at every accuracy level, the margin reaching 0 at the last copy for every
// miss_margin_step, the roll's miss rate and the draw's spread with the seeded generator, and the chance a try lands
// right that the panel's time left counts.
// Run: node test/paint-hard/miss-model.mjs
import { quantize } from "../../src/shades.js";
import { draws, land_chance, margin_ranges, miss_margin, miss_percent, miss_value, rolls_miss, seeded } from "../../src/misses.js";

let failures = 0, checks = 0;
function check(name, ok, detail) {
	checks++;
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
}
const table_for = (shades) => Array.from({ length: 256 }, (_, value) => quantize(value, shades));
const within = (shades, margin, right) => {
	const ranges = margin_ranges(table_for(shades), margin);
	return [...ranges.shades.slice(ranges.lo[right], ranges.hi[right] + 1)];
};

// D7's table, around a right shade of 128.
const rows = [
	[3, 255, [0, 128, 255]],
	[3, 127, [128, 255]],
	[5, 64, [64, 128, 191]],
	[256, 255, Array.from({ length: 256 }, (_, value) => value)],
	[256, 20, Array.from({ length: 41 }, (_, k) => 108 + k)],
	[256, 0, [128]],
];
for (const [shades, margin, want] of rows) {
	const got = within(shades, margin, 128);
	check(`${shades} shades at margin ${margin}: a miss can paint ${want.length > 8 ? `${want[0]}-${want.at(-1)}` : want.join(", ")}`, JSON.stringify(got) === JSON.stringify(want), `got ${got.length > 8 ? `${got.length} values, ${got[0]}-${got.at(-1)}` : got.join(", ")}`);
}

// Every range holds the right shade itself, at every shade count and margin tried.
let missing = 0;
for (const shades of [2, 3, 4, 7, 16, 86, 200, 256]) {
	const table = table_for(shades);
	for (const margin of [0, 1, 20, 127, 255]) {
		const ranges = margin_ranges(table, margin);
		for (const right of new Set(table)) {
			const set = ranges.shades.slice(ranges.lo[right], ranges.hi[right] + 1);
			if (!set.includes(right) || [...set].some((value) => Math.abs(value - right) > margin)) missing++;
		}
	}
}
check("every miss range holds the right shade and nothing past the margin", missing === 0, `${missing} bad ranges over 8 shade counts and 5 margins`);

// The miss chance: 90% with no accuracy copies, 10 points less a copy, 0 from the 9th on.
const chances = Array.from({ length: 11 }, (_, copies) => miss_percent(copies));
check("the miss chance goes 90, 80 ... 10, 0, and stays 0", JSON.stringify(chances) === JSON.stringify([90, 80, 70, 60, 50, 40, 30, 20, 10, 0, 0]), JSON.stringify(chances));

// The margin reaches 0 at ceil(255 / step) copies, and not a copy sooner, for every step.
let wrong_steps = [];
for (let step = 1; step <= 255; step++) {
	const copies = Math.ceil(255 / step);
	if (miss_margin(copies, step) !== 0 || miss_margin(copies - 1, step) <= 0 || miss_margin(0, step) !== 255) wrong_steps.push(step);
}
check("for every miss_margin_step 1-255 the margin reaches 0 at the last copy, not one sooner", wrong_steps.length === 0, wrong_steps.length ? `wrong at ${wrong_steps.join(", ")}` : "255 steps");

// The seeded generator repeats itself, and the roll auto copy and M use misses within 4 standard deviations of each miss
// chance over a million draws: 0.20 points at 50%, 0.12 at 90% and 10%.
const a = seeded(7), b = seeded(7), c = seeded(8);
const first = Array.from({ length: 5 }, () => a()), again = Array.from({ length: 5 }, () => b()), other = Array.from({ length: 5 }, () => c());
check("a seed gives the same draws again, and another seed others", JSON.stringify(first) === JSON.stringify(again) && JSON.stringify(first) !== JSON.stringify(other) && first.every((x) => x >= 0 && x < 1), JSON.stringify(first.map((x) => x.toFixed(4))));
const off = [];
for (let copies = 0; copies <= 9; copies++) {
	const percent = miss_percent(copies), random = seeded(1000 + copies);
	let missed = 0;
	for (let n = 0; n < 1_000_000; n++) if (rolls_miss(percent, random)) missed++;
	const sd = 100 * Math.sqrt((percent / 100) * (1 - percent / 100) / 1_000_000);
	off.push({ points: Math.abs(missed / 10_000 - percent), sd });
}
check("seeded rolls miss within 4 standard deviations of the chance at every accuracy level, over a million each", off.every(({ points, sd }) => points <= 4 * sd), off.map(({ points, sd }) => `${points.toFixed(3)} (${sd ? (points / sd).toFixed(1) : 0} sd)`).join(", "));

// A miss draws each shade in its range about equally: 41 values at 256 shades and margin 20.
const ranges = margin_ranges(table_for(256), 20), random = seeded(42), counts = new Map();
for (let n = 0; n < 410_000; n++) {
	const value = miss_value(ranges, 128, random);
	counts.set(value, (counts.get(value) ?? 0) + 1);
}
const spread = [...counts.values()];
check("a miss draws each shade within the margin about equally", counts.size === 41 && Math.min(...spread) > 9_500 && Math.max(...spread) < 10_500, `${counts.size} values, ${Math.min(...spread)}-${Math.max(...spread)} draws each of 410,000`);

// The chance a try lands right, which the panel's time left counts tries by: a hit, or a miss that draws the right shade
// in every channel. 21.25% at the black-and-white start with 90% misses at margin 255, where each channel draws from 2;
// all of them at margin 0; 10% at full depth and margin 255. Then the same at the black-and-white start, measured: the
// roll and the draws a million times, for a right shade of black in every channel.
const colors_at = (shades, margin, right) => {
	const ranges = margin_ranges(table_for(shades), margin);
	return draws(ranges, right) ** 3;
};
const lands = [land_chance(90, colors_at(2, 255, 0)), land_chance(90, colors_at(256, 0, 128)), land_chance(90, colors_at(256, 255, 128)), land_chance(0, colors_at(256, 255, 128))];
const bw = margin_ranges(table_for(2), 255), roll_random = seeded(77);
let landed = 0;
for (let n = 0; n < 1_000_000; n++) {
	if (!rolls_miss(90, roll_random) || [0, 1, 2].every(() => miss_value(bw, 0, roll_random) === 0)) landed++;
}
check("a try lands right 21.25% of the time at the black-and-white start, every time at margin 0, and 10% at full depth", Math.abs(lands[0] - 0.2125) < 1e-12 && lands[1] === 1 && Math.abs(lands[2] - (0.1 + 0.9 / 256 ** 3)) < 1e-15 && lands[3] === 1 && Math.abs(landed / 1e6 - 0.2125) < 4 * Math.sqrt(0.2125 * 0.7875 / 1e6), `${lands.map((p) => p.toFixed(6)).join(", ")}; ${(landed / 1e4).toFixed(3)}% measured`);

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
