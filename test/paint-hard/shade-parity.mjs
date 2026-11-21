// Checks src/shades.js against the vectors the APWorld writes (worlds/paint_hard/test/shade_vectors.json there,
// copied here). Every shade count from 2 to 256 must round all 256 channel values exactly as rules.py does.
// Run: node test/paint-hard/shade-parity.mjs
import { readFileSync } from "node:fs";
import { quantize, worst_error } from "../../src/shades.js";

const vectors = JSON.parse(readFileSync(new URL("shade_vectors.json", import.meta.url), "utf8"));
let failures = 0;
for (const [key, [sum, digest, error]] of Object.entries(vectors.quantize)) {
	const shades = Number(key);
	let got_sum = 0, got_digest = 0;
	for (let value = 0; value < 256; value++) {
		const shade = quantize(value, shades);
		got_sum += shade;
		got_digest = (Math.imul(got_digest, 31) + shade) >>> 0;
	}
	const got_error = worst_error(shades);
	if (got_sum !== sum || got_digest !== digest || got_error !== error) {
		failures++;
		console.error(`${shades} shades: got ${got_sum}/${got_digest}/${got_error}, want ${sum}/${digest}/${error}`);
	}
}
const checked = Object.keys(vectors.quantize).length;
console.log(failures ? `${failures} of ${checked} shade counts differ from rules.py` : `all ${checked} shade counts match rules.py`);
process.exit(failures ? 1 : 0);
