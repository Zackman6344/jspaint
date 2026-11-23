// End-to-end test for misses, the miss margin, passes and pass orders (D7, D23 of the fork's ROADMAP, Phase 4). It stands
// in for a game with fake_session() as auto-copy.e2e.mjs does, on a 100x100 canvas of the same goal unless a check says
// otherwise, and seeds auto copy's and M's draws, so each run misses the same pixels. At 14 speed copies auto copy paints
// 16,384 pixels a second, so a pass over the canvas takes about a second.
// Usage: node test/paint-hard/misses.e2e.mjs [--headful]. Set BROWSER_PATH if Chrome isn't in its default folder.
import { check, evaluate, finish, open_paint, page_errors, sleep } from "./harness.mjs";

const color_items = (count) => {
	const items = [];
	for (const channel of ["Red", "Green", "Blue"]) for (let k = 0; k < count; k++) items.push(`Progressive Color Depth (${channel})`);
	return items;
};
const FULL_COLOR = color_items(254);
const copies = (name, n) => Array(n).fill(name);
const SPEED = copies("Progressive Auto Copy Speed", 14);
const SURE = copies("Progressive Auto Copy Accuracy", 9); // never misses
const SLOT = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 14, overclock_seconds: 2, miss_margin_step: 1, version: "1.0.0", trap_blacklist: [] };
const LADDER_SLOT = { ...SLOT, ladders: true };
const LADDERS = ["Progressive Pick Color", "Progressive Difference Mode", "Progressive Similarity Mode"];
const SIDE = 100;
const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;

// The game's slot data and items, on a SIDE x SIDE canvas (or the size given), in the game named (one game unless named).
const game = (items, slot = SLOT, size = SIDE, name = "test") => evaluate(async (slot, items, size, name) => {
	const { fake_session } = await import("/src/archipelago.js");
	const { resize_canvas_without_saving_dimensions } = await import("/src/functions.js");
	fake_session(slot, ["Magnifier", "Brush", ...items], name);
	if (main_canvas.width !== size || main_canvas.height !== size) resize_canvas_without_saving_dimensions(size, size);
}, slot, items, size, name);
// The goal auto-copy.e2e.mjs draws: no pixel is white.
const standard_goal = () => evaluate(() => {
	const { width, height } = goal_canvas;
	const image = goal_ctx.createImageData(width, height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * width + x) * 4);
	goal_ctx.putImageData(image, 0, 0);
});
// A goal in bands of rows across the top left: [[the row a band ends before, its color], ...].
const banded_goal = (bands, side = SIDE) => evaluate((bands, side) => {
	const image = goal_ctx.getImageData(0, 0, side, side);
	for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) image.data.set(bands.find(([until]) => y < until)[1], (y * side + x) * 4);
	goal_ctx.putImageData(image, 0, 0);
}, bands, side);
const whiten = () => evaluate(() => { main_ctx.fillStyle = "#fff"; main_ctx.fillRect(0, 0, main_canvas.width, main_canvas.height); });
const hook = (name, ...args) => evaluate((name, args) => window.paint_hard_auto_copy[name](...args), name, args);
const shift_m = () => evaluate(() => { for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true })); });
const open_panel = () => evaluate(async () => {
	(await import("/src/functions.js")).set_magnification(1);
	(await import("/src/auto-copy.js")).show_auto_copy_panel(); // opens the panel without starting
});
// Closing the panel drops auto copy's run, so the next check starts a new one rather than resuming a paused pass.
const reopen_panel = async () => {
	await evaluate(() => document.querySelector(".auto-copy-panel .window-close-button")?.click());
	await sleep(100);
	await open_panel();
};
// The panel's lines: its state, the pixels left, speed, top speed, misses, Overclock, switches and the button.
const panel_lines = () => evaluate(() => [...(document.querySelector(".auto-copy-panel .window-content")?.children ?? [])].map((element) => element.textContent));
const panel_state = async () => (await panel_lines())[0] ?? null;
const panel_button = (pattern) => evaluate((source) => {
	const button = [...document.querySelectorAll(".auto-copy-panel button")].find((b) => new RegExp(source).test(b.textContent));
	return button?.textContent ?? null;
}, pattern.source);
const click_panel_button = (pattern) => evaluate((source) => [...document.querySelectorAll(".auto-copy-panel button")].find((b) => new RegExp(source).test(b.textContent)).click(), pattern.source);
// Waits until auto copy stops: a pass ends, or the canvas is done. `each` sees every pass on the way.
async function wait_stopped(timeout = 20000, each = null) {
	const start = Date.now();
	let pass = null;
	while (Date.now() - start < timeout) {
		await sleep(100);
		pass = await hook("pass");
		if (!pass.running) break;
		await each?.(pass);
	}
	return { ...pass, state: await panel_state(), seconds: (Date.now() - start) / 1000 };
}
// Starts auto copy (or the next pass) and waits until it stops.
async function run(timeout = 20000) {
	await shift_m();
	return wait_stopped(timeout);
}
const rolled = async () => (await hook("miss_stats")).auto.rolled;
const canvas_px = (x, y) => evaluate((x, y) => Array.from(main_ctx.getImageData(x, y, 1, 1).data), x, y);
const similarity = () => evaluate(async () => (await import("/src/functions.js")).calculate_similarity());
const count_color = (x, y, w, h, rgb) => evaluate((x, y, w, h, rgb) => {
	const d = main_ctx.getImageData(x, y, w, h).data;
	let n = 0;
	for (let i = 0; i < d.length; i += 4) if (d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) n++;
	return n;
}, x, y, w, h, rgb);
// A stroke of your own: one undo step, as Paint's tools make. Paint's send() throws without a server, after the step.
const own_stroke = (x, y, w, h, color) => evaluate(async (x, y, w, h, color) => {
	const { undoable } = await import("/src/functions.js");
	try { undoable({ name: "Brush" }, () => { main_ctx.fillStyle = color; main_ctx.fillRect(x, y, w, h); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
}, x, y, w, h, color);
// Presses M over canvas pixel (x, y), and gives back the status line after it.
const press_m = (x, y) => evaluate((x, y) => new Promise((resolve) => {
	const rect = main_canvas.getBoundingClientRect();
	dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + (x + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true }));
	for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "m", code: "KeyM", bubbles: true }));
	setTimeout(() => resolve($status_text.text()), 250);
}), x, y);
// Counts the canvas against the goal, in the page: pixels painted exactly the goal's color, pixels off the best shade,
// and the most any channel of a pixel is off its right shade.
const tally = () => evaluate(() => {
	const [red, green, blue] = window.paint_hard_auto_copy.rounding_tables();
	const { width, height } = main_canvas, canvas = main_ctx.getImageData(0, 0, width, height).data, goal = goal_ctx.getImageData(0, 0, width, height).data;
	let exact = 0, off = 0, widest = 0, white = 0;
	for (let i = 0; i < canvas.length; i += 4) {
		const right = [red[goal[i]], green[goal[i + 1]], blue[goal[i + 2]]];
		const wrong = [0, 1, 2].map((c) => Math.abs(canvas[i + c] - right[c]));
		if (canvas[i] === goal[i] && canvas[i + 1] === goal[i + 1] && canvas[i + 2] === goal[i + 2]) exact++;
		if (wrong.some(Boolean)) off++;
		if (canvas[i] === 255 && canvas[i + 1] === 255 && canvas[i + 2] === 255) white++;
		widest = Math.max(widest, ...wrong);
	}
	return { exact, off, widest, white, pixels: width * height };
});

try {
	await open_paint(ready);
	await evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("pain-t-")) localStorage.removeItem(key); });
	await standard_goal();
	await game([...FULL_COLOR, ...SPEED]);
	await open_panel();
	check("the page reads canvases back exactly here, so no read noise is found", (await hook("read_noise")) === null, String(await hook("read_noise")));
	const start_line = (await panel_lines())[4];
	check("with no accuracy or margin items, auto copy misses 90% of pixels at margin 255, has no Loop, and the panel says so", (await hook("miss_chance")) === 90 && (await hook("miss_margin")) === 255 && !(await hook("loop")) && start_line === "Misses 90% of pixels: a miss paints a shade within 255 of the right one.", JSON.stringify({ chance: await hook("miss_chance"), margin: await hook("miss_margin"), loop: await hook("loop"), line: start_line }));

	// One pass over 10,000 pixels: the pixels left wrong are the misses, within 1 point of the miss chance. At margin 255
	// and full depth a miss lands right once in 16.8 million.
	const measure = async (accuracy, seed) => {
		await game([...FULL_COLOR, ...SPEED, ...copies("Progressive Auto Copy Accuracy", accuracy)]);
		await hook("seed_random", seed);
		const pass = await run();
		const { off } = await tally(), stats = await hook("miss_stats"), lines = await panel_lines();
		return { chance: await hook("miss_chance"), off, left: await hook("pixels_left"), ...stats.auto, pass, misses_line: lines[4], button: lines[7] };
	};
	await whiten();
	const r0 = await measure(0, 100);
	check("one pass over 10,000 pixels leaves 90% wrong with no accuracy items, within 1 point", r0.chance === 90 && Math.abs(r0.off / 100 - 90) <= 1 && r0.off === r0.missed && r0.rolled === SIDE * SIDE, `${r0.off} wrong, ${r0.missed} of ${r0.rolled} rolls missed`);
	check("a run is one pass: it stops with the pass, says how many are still off, and its button starts pass 2", r0.pass.ended && !r0.pass.running && r0.pass.number === 1 && r0.left === r0.off && new RegExp(`^Pass 1 done: ${r0.off.toLocaleString()} pixels still off\\.$`).test(r0.pass.state) && r0.button === "Start pass 2", `${JSON.stringify(r0.pass)}; ${r0.left} left; button "${r0.button}"`);
	// The next pass paints the pixels the first missed, each once, and no others.
	const r0b = await measure(0, 7);
	check("Start begins pass 2 at the top, and it tries each pixel still off once", r0b.pass.number === 2 && r0b.rolled === r0.off && r0b.off === r0b.missed, `pass ${r0b.pass.number}: ${r0b.rolled} tried of ${r0.off} off, ${r0b.off} wrong after`);
	await whiten();
	const r8 = await measure(8, 108);
	check("...10% with 8 Progressive Auto Copy Accuracy, and the panel says so", r8.chance === 10 && Math.abs(r8.off / 100 - 10) <= 1 && r8.off === r8.missed && r8.rolled === SIDE * SIDE && r8.misses_line === "Misses 10% of pixels: a miss paints a shade within 255 of the right one.", `${r8.off} wrong, ${r8.missed} of ${r8.rolled} rolls missed; "${r8.misses_line}"`);
	await whiten();
	const r9 = await measure(9, 109);
	check("...and none with all 9", r9.chance === 0 && r9.off === 0 && r9.missed === 0 && r9.pass.done && r9.misses_line === "Never misses.", `${r9.off} wrong, ${r9.missed} missed, ${r9.pass.done ? "done" : "not done"}; "${r9.misses_line}"`);

	// Margin 0, with all 255 Progressive Miss Margin at step 1: a miss can only paint the right shade.
	await game([...FULL_COLOR, ...SPEED, ...copies("Progressive Miss Margin", 255)]);
	await whiten();
	await hook("seed_random", 3);
	const flat = await run(), flat_tally = await tally(), flat_stats = await hook("miss_stats"), flat_line = (await panel_lines())[4];
	check("at margin 0 no pixel comes out wrong, though 90% of the rolls missed, and the panel says why", (await hook("miss_margin")) === 0 && flat_tally.off === 0 && Math.abs(flat_stats.auto.missed / 100 - 90) <= 1 && flat.done && flat_line === "Misses 90% of pixels, but at margin 0 a miss paints the right shade anyway.", `${flat_tally.off} wrong, ${flat_stats.auto.missed} of ${flat_stats.auto.rolled} missed; "${flat_line}"`);

	// Margin 1, with 254 copies: every wrong pixel is one level off in each channel at most, it counts as still off, and
	// the next pass paints it again.
	await game([...FULL_COLOR, ...SPEED, ...copies("Progressive Miss Margin", 254)]);
	await whiten();
	await hook("seed_random", 4);
	const thin = await run(), thin_tally = await tally(), thin_left = await hook("pixels_left");
	await hook("seed_random", 5);
	const thin2 = await run(), thin2_stats = await hook("miss_stats");
	check("at margin 1 a miss lands one level off at most, counts as still off, and the next pass tries it again", (await hook("miss_margin")) === 1 && thin_tally.widest === 1 && thin_tally.off > 8000 && thin_left === thin_tally.off && thin.ended && thin2_stats.auto.rolled === thin_tally.off, `${thin_tally.off} off, widest ${thin_tally.widest}, ${thin_left} still off; pass 2 tried ${thin2_stats.auto.rolled}`);

	// The time left counts the tries a pixel should take: about 10 at 90% misses and margin 255, where a miss almost never
	// draws right, and 1 at margin 0, where every miss does. 10,000 pixels at 8 a second.
	const time_left_at = async (margin_copies) => {
		await game([...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 3), ...copies("Progressive Miss Margin", margin_copies)]);
		await whiten();
		await shift_m();
		await sleep(300);
		await shift_m();
		return (await panel_lines())[1];
	};
	await reopen_panel();
	const wide_time = await time_left_at(0), flat_time = await time_left_at(255);
	check("the time left counts the tries a pixel takes at the miss chance: 10 a pixel at margin 255, 1 at margin 0", /^(10,000|9,9\d\d) pixels left, about 3 h 2\d min\.$/.test(wide_time) && /^(10,000|9,9\d\d) pixels left, about 2[01] min\.$/.test(flat_time), `"${wide_time}" / "${flat_time}"`);
	await reopen_panel();

	// A color item reopens the pixels a new shade beats, and only those; a run that was done repaints those and leaves the
	// rest as they were, though some aren't a 4-shade color: shade sets aren't nested, and they score as well.
	await game([...color_items(1), ...SPEED, ...SURE]); // 3 shades
	await whiten();
	const at3 = await run();
	const shades3 = await evaluate(() => [...new Set(window.paint_hard_auto_copy.rounding_tables()[0])].length);
	const sim3 = await similarity();
	await evaluate(() => { window.__before_4 = main_ctx.getImageData(0, 0, 100, 100).data.slice(); });
	await game([...color_items(2), ...SPEED, ...SURE]); // 4 shades
	const better = await evaluate(() => {
		const [red, green, blue] = window.paint_hard_auto_copy.rounding_tables();
		const { width, height } = main_canvas, canvas = main_ctx.getImageData(0, 0, width, height).data, goal = goal_ctx.getImageData(0, 0, width, height).data;
		let n = 0;
		for (let i = 0; i < canvas.length; i += 4) {
			const now = (canvas[i] - goal[i]) ** 2 + (canvas[i + 1] - goal[i + 1]) ** 2 + (canvas[i + 2] - goal[i + 2]) ** 2;
			const best = (red[goal[i]] - goal[i]) ** 2 + (green[goal[i + 1]] - goal[i + 1]) ** 2 + (blue[goal[i + 2]] - goal[i + 2]) ** 2;
			if (now > best) n++;
		}
		return n;
	});
	const reopened_left = await hook("pixels_left");
	const at4 = await run(), at4_left = await hook("pixels_left"), sim4 = await similarity();
	const changed = await evaluate(() => {
		const before = window.__before_4, after = main_ctx.getImageData(0, 0, 100, 100).data;
		let n = 0;
		for (let i = 0; i < after.length; i += 4) if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) n++;
		return n;
	});
	check("a color item reopens exactly the pixels a new shade beats, and a run repaints those and no others", at3.done && shades3 === 3 && better > 0 && better < SIDE * SIDE && reopened_left === better && at4.done && at4_left === 0 && changed === better && sim4 >= sim3, `done at 3 shades; ${better} beaten at 4, ${reopened_left} counted still off; then ${at4.done ? "done" : "not done"} with ${at4_left} still off, ${changed} pixels changed, similarity ${sim3.toFixed(6)} to ${sim4.toFixed(6)}`);

	// A canvas finished at 200 shades turns exact once every color item is in, since the test compares scores, not ±1.
	await game([...color_items(198), ...SPEED, ...SURE]); // 200 shades
	await whiten();
	const at200 = await run(), at200_tally = await tally();
	await game([...FULL_COLOR, ...SPEED, ...SURE]);
	const full_left = await hook("pixels_left");
	const at256 = await run(), at256_tally = await tally();
	check("a canvas finished at 200 shades turns exact once the last color items arrive", at200.done && at200_tally.exact < at200_tally.pixels && full_left === at200_tally.pixels - at200_tally.exact && at256.done && at256_tally.exact === at256_tally.pixels, `${at200_tally.exact} of ${at200_tally.pixels} exact at 200 shades, ${full_left} still off at 256, then ${at256_tally.exact} exact`);

	// M judges a pixel by the same exact test: at full depth it repaints a pixel one level off, and at 4 shades it leaves a
	// pixel painted at 3 shades that no 4-shade color beats (128 against 85 and 170, for a goal of 128).
	await whiten();
	const one_off_goal = await evaluate(() => {
		const goal = goal_ctx.getImageData(10, 10, 1, 1).data;
		main_ctx.putImageData(new ImageData(Uint8ClampedArray.from([goal[0] ^ 1, goal[1], goal[2], 255]), 1, 1), 10, 10);
		return Array.from(goal);
	});
	const one_off_status = await press_m(10, 10), one_off_after = await canvas_px(10, 10);
	await game([...color_items(2), ...SPEED, ...SURE]); // 4 shades: 0, 85, 170, 255
	await evaluate(() => {
		window.__goal_px = goal_ctx.getImageData(12, 12, 1, 1);
		const gray = new ImageData(Uint8ClampedArray.from([128, 128, 128, 255]), 1, 1);
		goal_ctx.putImageData(gray, 12, 12);
		main_ctx.putImageData(gray, 12, 12);
	});
	const kept_status = await press_m(12, 12), kept_after = await canvas_px(12, 12);
	await evaluate(() => goal_ctx.putImageData(window.__goal_px, 12, 12));
	check("M repaints a pixel one level off at full depth, and leaves a 3-shade 128 that no 4-shade color beats", one_off_after.slice(0, 3).join() === one_off_goal.slice(0, 3).join() && one_off_status === "Copied 10,10 from the goal." && kept_after.slice(0, 3).join() === "128,128,128" && kept_status === "Already matches the goal.", `goal ${one_off_goal.slice(0, 3)}, after M ${one_off_after.slice(0, 3)}: "${one_off_status}"; the 128 pixel after M ${kept_after.slice(0, 3)}: "${kept_status}"`);

	// The running total stays a full rescore's, with misses, while a pass runs at 1,024 pixels a second. Between counts of
	// the pixels left, every 2 s, the panel's count falls by the pixels painted right, not by every paint.
	await game([...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 10)]);
	await whiten();
	await hook("seed_random", 9);
	await shift_m();
	await sleep(1500);
	const totals = await evaluate(async () => {
		const { calculate_similarity } = await import("/src/functions.js");
		const shown = document.querySelector(".auto-copy-panel .window-content")?.children[1].textContent ?? "";
		return { running: window.paint_hard_auto_copy.similarity(), full: calculate_similarity(), shown: Number((shown.match(/^([\d,]+) pixels? left/) ?? [, "NaN"])[1].replace(/,/g, "")), left: window.paint_hard_auto_copy.pixels_left(), tried: window.paint_hard_auto_copy.miss_stats().auto.rolled };
	});
	await shift_m();
	check("with misses the running total stays a full rescore's", totals.running !== null && Math.abs(totals.running - totals.full) < 1e-9, JSON.stringify(totals));
	check("...and between counts the panel's pixels left falls by the pixels painted right, not by every paint", totals.shown === totals.left && totals.tried > 500 && SIDE * SIDE - totals.left < totals.tried / 2, JSON.stringify(totals));

	// A new goal is copied from at once: save-goal drops the goal auto copy keeps, rather than waiting for the next count.
	await game([...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 10), ...SURE]);
	await whiten();
	await shift_m();
	await sleep(300);
	const fresh = await evaluate(async () => {
		const { $G } = await import("/src/helpers.js");
		const saved = goal_ctx.getImageData(0, 0, 100, 100);
		goal_ctx.fillStyle = "rgb(10, 200, 30)";
		goal_ctx.fillRect(0, 0, 100, 100);
		$G.triggerHandler("save-goal");
		await new Promise((resolve) => setTimeout(resolve, 400));
		const d = main_ctx.getImageData(0, 0, 100, 100).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i] === 10 && d[i + 1] === 200 && d[i + 2] === 30) n++;
		goal_ctx.putImageData(saved, 0, 0);
		$G.triggerHandler("save-goal");
		return n;
	});
	await shift_m();
	check("a new goal is copied from at once, not after the next count", fresh > 150, `${fresh} pixels of the new goal's color in the 400 ms after it, at 1,024 a second`);

	// M misses as auto copy does (D6): hold-M copies of 100 pixels at 90%, drawn from M's own seeded source.
	await game([...FULL_COLOR, ...SPEED]);
	await whiten();
	await hook("seed_random", 11);
	const m_result = await evaluate(() => new Promise((resolve) => {
		// M's own path, as copy_pending runs it: queue a row of pixels and let the allowance paint them.
		const { x, y } = { x: 0, y: 50 };
		const rect = main_canvas.getBoundingClientRect(), at = (px) => ({ clientX: rect.left + (px + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true });
		dispatchEvent(new PointerEvent("pointermove", at(x)));
		dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true }));
		for (let px = 1; px < 100; px++) dispatchEvent(new PointerEvent("pointermove", at(px)));
		setTimeout(() => {
			dispatchEvent(new KeyboardEvent("keyup", { key: "m", code: "KeyM", bubbles: true }));
			setTimeout(() => resolve({ stats: window.paint_hard_auto_copy.miss_stats().m, status: $status_text.text() }), 300);
		}, 400);
	}));
	check("M misses as auto copy does, and says how many", m_result.stats.rolled >= 90 && Math.abs(m_result.stats.missed / m_result.stats.rolled - 0.9) < 0.1 && /of them missed/.test(m_result.status), `${m_result.stats.missed} of ${m_result.stats.rolled} missed; "${m_result.status}"`);

	// M alongside auto copy (the second Progressive Similarity Mode), both at 90%: M's pixels go into auto copy's step and
	// its once-a-second sends, and the running total stays a full rescore's.
	await game([...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 10), ...LADDERS, "Progressive Similarity Mode"], LADDER_SLOT);
	await whiten();
	await hook("seed_random", 21);
	await shift_m();
	await sleep(600);
	const along = await evaluate(() => new Promise((resolve) => {
		const rect = main_canvas.getBoundingClientRect(), y = 80;
		const at = (px) => ({ clientX: rect.left + (px + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true });
		dispatchEvent(new PointerEvent("pointermove", at(0)));
		dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true }));
		for (let px = 1; px < 100; px++) dispatchEvent(new PointerEvent("pointermove", at(px)));
		setTimeout(() => {
			dispatchEvent(new KeyboardEvent("keyup", { key: "m", code: "KeyM", bubbles: true }));
			setTimeout(async () => {
				const { calculate_similarity } = await import("/src/functions.js");
				const running = window.paint_hard_auto_copy.similarity(), state = document.querySelector(".auto-copy-panel .window-content")?.children[0].textContent;
				resolve({ running, full: calculate_similarity(), m: window.paint_hard_auto_copy.miss_stats().m, state });
			}, 150);
		}, 300);
	}));
	await shift_m();
	check("M alongside auto copy, both missing, keeps the running total a full rescore's", along.m.missed > 50 && /^Copying/.test(along.state ?? "") && Math.abs(along.running - along.full) < 1e-9, JSON.stringify(along));

	// Auto Copy Loop starts each next pass by itself, until nothing is left: a new run on a 30x30 canvas at 90% misses.
	await reopen_panel();
	await game([...FULL_COLOR, ...SPEED, "Auto Copy Loop"], SLOT, 30);
	await whiten();
	await hook("seed_random", 12);
	await shift_m();
	let copying_line = null;
	const looped = await wait_stopped(30000, async (pass) => { if (pass.number > 1 && !copying_line) copying_line = await panel_state(); });
	const looped_stats = await hook("miss_stats");
	check("with Auto Copy Loop a run goes on pass after pass until the canvas is done, and the panel names the pass", (await hook("loop")) && looped.done && looped.number > 10 && looped.state === "Done: your canvas matches the goal." && /^Copying, pass \d+\.$/.test(copying_line ?? ""), `done after ${looped.number} passes and ${looped_stats.auto.rolled} tries in ${looped.seconds.toFixed(1)} s; "${copying_line}"`);

	// With Loop on, a finished run starts again by itself once a color item reopens pixels.
	await game([...color_items(1), ...SPEED, "Auto Copy Loop", ...SURE], SLOT, 30);
	await whiten();
	const loop_done = await run();
	const reopen_from = await rolled();
	await game([...color_items(2), ...SPEED, "Auto Copy Loop", ...SURE], SLOT, 30);
	const reopened_at_loop = await hook("pixels_left");
	let restarted = null; // auto copy painted again by itself, and finished
	for (let i = 0; i < 100 && !restarted; i++) {
		await sleep(100);
		const pass = await hook("pass"), tried = await rolled();
		if (tried > reopen_from && !pass.running && pass.done) restarted = { pass, tried: tried - reopen_from };
	}
	check("with Loop on, a finished run starts again by itself when a color item reopens pixels", loop_done.done && reopened_at_loop > 0 && !!restarted && (await hook("pixels_left")) === 0, `${reopened_at_loop} reopened; ${restarted ? `started again, tried ${restarted.tried}, done` : "stayed stopped"}, ${await hook("pixels_left")} left`);

	// The restart is the game's. Your own stroke doesn't start a finished run again, nor does an item that reopens no pixel
	// though the stroke left some off: a filler, or a color item that beats nothing painted. The goal's top left is
	// (10, 10, 10) here, black at 2 shades and at 3. A DeathLink reset does start it, and so does a trap, though not
	// before 3 s after it, so Ctrl+Z can still walk back past it.
	const S30 = { ...SLOT, start_width: 30, start_height: 30 };
	const LOOP_ITEMS = [...SPEED, ...SURE, "Auto Copy Loop"];
	await banded_goal([[30, [10, 10, 10, 255]]], 30);
	await game(LOOP_ITEMS, S30, 30); // 2 shades
	await whiten();
	const dark = await run();
	await own_stroke(0, 0, 10, 10, "#fff");
	const from_stroke = await rolled();
	await sleep(2500); // a recount
	await game([...LOOP_ITEMS, "Overclock"], S30, 30);
	await sleep(2500);
	await game([...color_items(1), ...LOOP_ITEMS, "Overclock"], S30, 30); // 3 shades
	await sleep(6000); // past a recount and the 3 s a run Loop starts again waits before it paints
	const stroke_kept = { running: (await hook("pass")).running, tried: (await rolled()) - from_stroke, white: await count_color(0, 0, 10, 10, [255, 255, 255]), left: await hook("pixels_left"), state: await panel_state() };
	check("your own stroke on a finished canvas stays, through a filler and a color item that reopen nothing", dark.done && !stroke_kept.running && stroke_kept.tried === 0 && stroke_kept.white === 100 && stroke_kept.left === 100 && stroke_kept.state === "Ready.", JSON.stringify(stroke_kept));
	const from_death = await rolled();
	await evaluate(async () => (await import("/src/archipelago.js")).death_received());
	let death = null;
	for (let i = 0; i < 100 && !death; i++) {
		await sleep(100);
		const pass = await hook("pass");
		if ((await rolled()) > from_death && pass.done) death = pass;
	}
	check("a DeathLink reset of a finished canvas starts the run again with Loop on", !!death && (await hook("pixels_left")) === 0 && (await count_color(0, 0, 30, 30, [0, 0, 0])) === 900, JSON.stringify({ death, left: await hook("pixels_left") }));
	const trap = await evaluate(async () => {
		const { handleTrap } = await import("/src/archipelago.js");
		const start = window.paint_hard_auto_copy.miss_stats().auto.rolled, at = performance.now();
		try { handleTrap("Invert Colors Trap", false, null); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
		const painted = await new Promise((resolve) => {
			const timer = setInterval(() => {
				if (window.paint_hard_auto_copy.miss_stats().auto.rolled > start) { clearInterval(timer); resolve(performance.now() - at); }
				else if (performance.now() - at > 8000) { clearInterval(timer); resolve(null); }
			}, 5);
		});
		return { painted_after_ms: painted === null ? null : Math.round(painted) };
	});
	const after_trap = await wait_stopped(10000);
	check("an Invert Colors Trap starts it again too, painting 3 s after the trap at the earliest", trap.painted_after_ms !== null && trap.painted_after_ms >= 3000 && after_trap.done && (await hook("pixels_left")) === 0, JSON.stringify({ ...trap, done: after_trap.done }));
	await standard_goal();
	await reopen_panel(); // drops the finished run, which the next game's shades would start again with Loop on

	// The Loop switch: the panel's button turns it off and on, and it's kept for each game, so in another game Auto Copy
	// Loop comes on when it arrives. The panel shows the other game's switch from its next recount, 2 s at most.
	await click_panel_button(/^Loop:/);
	const switched = { loop: await hook("loop"), button: await panel_button(/^Loop:/) };
	await game([...FULL_COLOR, ...SPEED, "Auto Copy Loop"], SLOT, 30, "another game");
	await sleep(2100);
	const other_game = { loop: await hook("loop"), button: await panel_button(/^Loop:/) };
	await game([...FULL_COLOR, ...SPEED, "Auto Copy Loop"], SLOT, 30);
	const back_here = await hook("loop");
	check("the panel's Loop button switches Loop off, for this game only", switched.loop === false && switched.button === "Loop: off" && other_game.loop === true && other_game.button === "Loop: on" && back_here === false, JSON.stringify({ switched, other_game, back_here }));

	// The Loop switch off: one pass, then it stops. The button turns it back on.
	await whiten();
	const switched_off = await run();
	await click_panel_button(/^Loop:/);
	check("with the Loop switch off a run stops after its pass, and the button turns it back on", switched_off.ended && switched_off.number === 1 && !switched_off.done && (await hook("loop")), JSON.stringify(switched_off));

	// Seeds from before Phase 4 have no miss_margin_step: no misses, and runs go on pass after pass until done, as Copy
	// Goal did. Rows whitened behind the scan make the first pass end with pixels off.
	const { miss_margin_step, ...old_slot } = SLOT;
	await reopen_panel();
	await game([...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 8)], old_slot, 30);
	await whiten();
	await evaluate(() => {
		window.__whitened = false;
		window.__whiten_timer = setInterval(() => {
			const data = main_ctx.getImageData(0, 0, 30, 30).data;
			let painted = 0;
			for (let i = 0; i < data.length; i += 4) if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) painted++;
			if (painted >= 400) {
				main_ctx.fillStyle = "#fff";
				main_ctx.fillRect(0, 0, 30, 5); // 150 pixels behind the scan, which is past row 13
				window.__whitened = true;
				clearInterval(window.__whiten_timer);
			}
		}, 10);
	});
	const old = await run(15000), old_tally = await tally();
	const whitened = await evaluate(() => { clearInterval(window.__whiten_timer); return window.__whitened; });
	check("a seed from before Phase 4 never misses, and goes on to the next pass by itself until done", whitened && (await hook("miss_chance")) === 0 && old.done && old.number >= 2 && old_tally.off === 0, `whitened ${whitened}; ${(await hook("miss_chance"))}% misses; ${JSON.stringify(old)}; ${old_tally.off} off`);

	// Pass orders (D23), in a seed with the ladders. Worst first, with the second Progressive Difference Mode, sweeps 8
	// bands of distance, furthest first: on a 60x60 goal whose rows 0-19 are 4 bands from the white canvas, rows 20-39 7
	// and rows 40-59 none, it paints the middle whole, then the top, then the bottom, and Loop takes it to done.
	await banded_goal([[20, [115, 115, 115, 255]], [40, [20, 30, 40, 255]], [60, [250, 250, 250, 255]]], 60);
	await game([...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 10), ...LADDERS, "Progressive Difference Mode", ...SURE, "Auto Copy Loop"], LADDER_SLOT, 60);
	await whiten();
	await evaluate(() => {
		window.__bands = [];
		let last = "";
		window.__band_timer = setInterval(() => {
			const data = main_ctx.getImageData(0, 0, 60, 60).data, counts = [0, 0, 0];
			for (let i = 0; i < data.length; i += 4) if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) counts[Math.floor(i / 240 / 20)]++;
			const key = counts.join();
			if (key !== last) { window.__bands.push(counts); last = key; }
		}, 20);
	});
	const banded_order = await hook("order");
	const banded = await run(15000);
	const bands = await evaluate(() => { clearInterval(window.__band_timer); return window.__bands; });
	const out_of_order = bands.filter(([b4, b7, b0]) => (b4 > 0 && b7 < 1200) || (b0 > 0 && b4 < 1200));
	check("worst first paints the furthest band whole, then the next, then the nearest", banded_order === "worst" && banded.done && out_of_order.length === 0 && bands.length > 3, `order ${banded_order}; ${banded.done ? "done" : "not done"}; ${bands.length} samples of [rows 0-19, 20-39, 40-59] painted, ${out_of_order.length} out of order, first ${JSON.stringify(out_of_order[0] ?? null)}, last ${JSON.stringify(bands.at(-1))}`);

	// The same order on 100x100: the goal's bottom half far from the white canvas and its top half close to it, so worst
	// first starts at the bottom. Paused after 2 s, for the next check.
	await standard_goal();
	await banded_goal([[50, [250, 250, 250, 255]], [100, [20, 30, 40, 255]]]);
	await reopen_panel();
	await game([...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 8), ...LADDERS, "Progressive Difference Mode", ...SURE], LADDER_SLOT);
	await whiten();
	await shift_m();
	await sleep(2000);
	await shift_m();
	const worst = await evaluate(() => {
		const data = main_ctx.getImageData(0, 0, 100, 100).data;
		let top = 0, bottom = 0;
		for (let i = 0; i < data.length; i += 4) if (data[i] !== 255) (i / 400 < 50 ? top++ : bottom++);
		return { order: window.paint_hard_auto_copy.order(), top, bottom };
	});
	check("with the second Progressive Difference Mode auto copy paints the worst pixels first", worst.order === "worst" && worst.bottom > 100 && worst.top === 0, JSON.stringify(worst));

	// Exact first arrives with the second Progressive Pick Color, and is picked, though the paused pass began worst first.
	// At 5 shades the goal has three bands, so each order starts in its own: the top is close to the white canvas and
	// can't be matched exactly (top to bottom starts there), the middle is furthest from it (worst first), and the bottom
	// is a shade in every channel (exact first).
	await banded_goal([[33, [200, 200, 200, 255]], [66, [10, 20, 30, 255]], [100, [128, 128, 128, 255]]]);
	await game([...color_items(3), ...copies("Progressive Auto Copy Speed", 8), ...LADDERS, "Progressive Difference Mode", "Progressive Pick Color", ...SURE], LADDER_SLOT);
	await whiten();
	await shift_m();
	await sleep(2000);
	await shift_m();
	const exact = await evaluate(() => {
		const data = main_ctx.getImageData(0, 0, 100, 100).data;
		const bands = { near: 0, far: 0, exact: 0 };
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue;
			const row = Math.floor(i / 400);
			bands[row < 33 ? "near" : row < 66 ? "far" : "exact"]++;
		}
		return { order: window.paint_hard_auto_copy.order(), ...bands };
	});
	exact.button = await panel_button(/^Order:/);
	check("the second Progressive Pick Color arrives and auto copy paints exact pixels first", exact.order === "exact" && exact.exact > 100 && exact.near === 0 && exact.far === 0 && exact.button === "Order: exact first", JSON.stringify(exact));

	// With both, the panel's order button goes round all three, top to bottom included.
	const cycle = [];
	for (let i = 0; i < 3; i++) {
		await click_panel_button(/^Order:/);
		cycle.push(await hook("order"));
	}
	check("with both, the order button goes round top to bottom, worst first and exact first", JSON.stringify(cycle) === JSON.stringify(["top", "worst", "exact"]), JSON.stringify(cycle));

	// In exact first, new shades start the pass again, since they change which pixels can be made exactly right. At 3
	// shades (0, 128, 255) the top half wants 200 and the bottom 85, neither a shade, so the pass is in its second sweep,
	// painting the bottom 128, when a fourth shade (0, 85, 170, 255) makes the bottom exactable. The pass goes back to the
	// top and paints the bottom's 85s first, then the top's 170s, and is done in one pass.
	await banded_goal([[50, [200, 200, 200, 255]], [100, [85, 85, 85, 255]]]);
	await reopen_panel();
	const exact_items = (depth) => [...color_items(depth), ...copies("Progressive Auto Copy Speed", 10), ...LADDERS, "Progressive Difference Mode", "Progressive Pick Color", ...SURE];
	await game(exact_items(1), LADDER_SLOT);
	await hook("choose_order", "exact");
	await whiten();
	await shift_m();
	await sleep(1500);
	const at_shade = { sweep: (await hook("pass")).sweep, exact_85: await count_color(0, 50, 100, 50, [85, 85, 85]) };
	await game(exact_items(2), LADDER_SLOT);
	await sleep(1000);
	const after_shade = { exact_85: await count_color(0, 50, 100, 50, [85, 85, 85]), top_170: await count_color(0, 0, 100, 50, [170, 170, 170]) };
	const exact_end = await wait_stopped(20000);
	check("in exact first, a new shade mid-pass starts the pass again, with the pixels it makes exact first", at_shade.sweep === 1 && at_shade.exact_85 === 0 && after_shade.exact_85 > 500 && after_shade.top_170 === 0 && exact_end.done && exact_end.number === 1, JSON.stringify({ at_shade, after_shade, end: { done: exact_end.done, pass: exact_end.number, state: exact_end.state } }));

	// An order that arrives while the page is closed is picked as it opens. The orders a game has seen are kept, so a
	// moment with no items, before they come in or after a reconnect, leaves your pick as it was.
	const worst_items = [...FULL_COLOR, ...copies("Progressive Auto Copy Speed", 10), ...LADDERS, "Progressive Difference Mode"];
	await game(worst_items, LADDER_SLOT, SIDE, "reloaded");
	const held = await hook("order");
	await hook("choose_order", "top");
	await open_paint(ready); // the page closes, and opens again
	await game([...worst_items, "Progressive Pick Color"], LADDER_SLOT, SIDE, "reloaded");
	const after_reload = await hook("order");
	await hook("choose_order", "top");
	await game([], LADDER_SLOT, SIDE, "reloaded");
	const no_items = await hook("order");
	await game([...worst_items, "Progressive Pick Color"], LADDER_SLOT, SIDE, "reloaded");
	const items_back = await hook("order");
	check("an order that arrived while the page was closed is picked as it opens, and a moment with no items keeps your pick", held === "worst" && after_reload === "exact" && no_items === "top" && items_back === "top", JSON.stringify({ held, picked_top_then_closed: true, after_reload, no_items, items_back }));

	// With reads blurred after the page loaded, M finds the blur when the pixel it wrote reads back a step off (D7).
	await standard_goal();
	await game([...FULL_COLOR, ...SPEED, ...SURE]);
	await open_panel();
	await whiten();
	const noise_before = await hook("read_noise");
	await evaluate(() => {
		const original = CanvasRenderingContext2D.prototype.getImageData;
		CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh, ...rest) {
			const image = original.call(this, sx, sy, sw, sh, ...rest);
			if (this.canvas === main_canvas) for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if ((sx + x + sy + y) % 3 === 0) image.data[(y * sw + x) * 4] ^= 1;
			return image;
		};
	});
	const blur_status = await press_m(6, 6);
	const noise_after = await hook("read_noise");
	check("with reads blurred after the page loaded, M finds the blur when the pixel it wrote reads back a step off", noise_before === null && noise_after === "read-back" && blur_status === "Copied 6,6 from the goal.", `${noise_before} before, ${noise_after} after; "${blur_status}"`);

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
