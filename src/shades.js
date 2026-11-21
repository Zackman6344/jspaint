// Pain-T color depth. Each channel has a number of evenly spaced shades from 0 to 255, read from the
// shade_counts table in slot_data. Halves round up, exactly as quantize() in the APWorld's rules.py does:
// test/paint-hard/shade-parity.mjs checks the two against vectors the APWorld writes.

/** The nearest of `shades` evenly spaced values from 0 to 255. */
export function quantize(value, shades) {
	const index = Math.floor(value * (shades - 1) / 255 + 0.5);
	return Math.floor(index * 255 / (shades - 1) + 0.5);
}

/** The furthest any channel value can be from its nearest shade. */
export function worst_error(shades) {
	let worst = 0;
	for (let value = 0; value < 256; value++) worst = Math.max(worst, Math.abs(value - quantize(value, shades)));
	return worst;
}
