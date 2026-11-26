// End-to-end test of the score as the page works it out (tasks 7.1 and 7.2 of the fork's ROADMAP, Phase 7). The page's
// calculate_similarity() must give what the loop it replaced (scoring-reference.mjs, the client's at d5bd9d7) gives on
// the page's own reads, at each version branch and canvas size; leave a view that isn't showing alone; draw a view as it
// shows; and at 800x600 take under half the old rescore's time, with no long task. An item packet rescores only for a new
// canvas size, and moves the logic figure without one. File > New and a resize that saves its size rescore themselves
// while a game is loaded, and a color item that changes a channel's shades rounds the Colors box's stored colors to them
// again. Auto copy and M add each pixel they paint to the running total by
// the seed's formula. It stands in for a game with fake_session() and fake_packet(), on the bundled 800x600 goal. It runs
// in Chrome and Firefox (decision 16).
// test/paint-hard/scoring.mjs checks the same score in Node on all five bundled goals.
// Usage: node test/paint-hard/scoring.e2e.mjs [--browser=chrome|firefox] [--headful]. Set BROWSER_PATH if the browser
// isn't in its default folder.
import { call, check, evaluate, finish, keyboard, mouse, open_paint, page_errors, sleep } from "./harness.mjs";

const FULL_COLOR = [];
for (const channel of ["Red", "Green", "Blue"]) for (let k = 0; k < 254; k++) FULL_COLOR.push(`Progressive Color Depth (${channel})`);
const SPEED = Array(10).fill("Progressive Auto Copy Speed");
const SURE = [...Array(9).fill("Progressive Auto Copy Accuracy"), "Auto Copy Loop"]; // auto copy never misses
const ITEMS = ["Magnifier", "Brush", ...FULL_COLOR, ...SPEED, ...SURE];
const SLOT_DATA = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 2, miss_margin_step: 1, version: "1.0.0", trap_blacklist: [] };
// Each version branch, with what version_below() says of it at 0.2.0 and 0.5.0. No version is a page with no seed.
const VERSIONS = [["no seed", null, true, true], ["0.1.0", "0.1.0", true, true], ["0.4.0", "0.4.0", false, true], ["1.0.0", "1.0.0", false, false]];
const slot_at = (version, more = {}) => {
	const slot = { ...SLOT_DATA, ...more };
	if (version) slot.version = version;
	else delete slot.version;
	return slot;
};
const game = (slot = SLOT_DATA, items = ITEMS) => evaluate(async (slot, items) => (await import("/src/archipelago.js")).fake_session(slot, items), slot, items);
const rescores = () => evaluate(async () => (await import("/src/functions.js")).rescore_count());
const status = () => evaluate(() => $status_similarity.text());
const focus_page = async () => { await mouse.click(5, 895); await sleep(100); };
// Waits up to 3 s for the page's rescores to pass a count, as a goal or session load lands.
const rescores_past = async (count) => {
	for (let i = 0; i < 30 && (await rescores()) <= count; i++) await sleep(100);
	return rescores();
};
// The page's similarity against the reference loop's on the same reads, with the canvas at a size: the canvas is read
// whole and the goal at the goal's size, as the old loop read them.
const against_reference = (b2, b5, size) => evaluate(async (b2, b5, size) => {
	const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
	const { reference_similarity, send_units } = await import("/test/paint-hard/scoring-reference.mjs");
	if (size) fn.resize_canvas_without_saving_dimensions(...size);
	const { width, height } = main_canvas, shown = $status_similarity.text().split("/")[0];
	const page = fn.calculate_similarity();
	const reference = reference_similarity(main_ctx.getImageData(0, 0, width, height).data, width, height, goal_ctx.getImageData(0, 0, ap.final_width, ap.final_height).data, ap.final_width, ap.final_height, b2, b5).similarity;
	return { size: `${width}x${height}`, page, reference, units: [send_units(page), send_units(reference)], gap: Math.abs(page - reference), shown, shown_now: shown === `${page.toFixed(4)}%` };
}, b2, b5, size);
const agrees = (r) => r.units[0] === r.units[1] && r.gap <= 1e-9;
// Both views as they show over the goal, against the reference's on the page's reads now: the Similarity view's pixels
// that show, and the Difference view's bytes, that differ.
const views_against_reference = () => evaluate(async () => {
	const ap = await import("/src/archipelago.js");
	const { reference_similarity, visible_differences } = await import("/test/paint-hard/scoring-reference.mjs");
	const { width, height } = main_canvas, fw = ap.final_width, fh = ap.final_height;
	const want = reference_similarity(main_ctx.getImageData(0, 0, width, height).data, width, height, goal_ctx.getImageData(0, 0, fw, fh).data, fw, fh, ap.version_below("0.2.0"), ap.version_below("0.5.0"));
	const sim = sim_canvas.ctx.getImageData(0, 0, fw, fh).data, diff = diff_canvas.ctx.getImageData(0, 0, fw, fh).data;
	let diff_bytes = 0;
	for (let i = 0; i < diff.length; i++) if (diff[i] !== want.diff[i]) diff_bytes++;
	return { sim: visible_differences(sim, want.sim), diff: diff_bytes, shown: { sim: $sim.is(":visible"), diff: $diff.is(":visible") } };
});

try {
	await open_paint(() => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy);

	// Before a game is loaded, neither a goal nor a session that loads rescores: with no slot data the logic figure would
	// read NaN. A restore loads both as the page opens, and the login rescores.
	const offline_from = await rescores();
	await evaluate(() => { $goal_image.attr("src", "images/archipelago/800x600.png"); });
	for (let i = 0; i < 30 && !(await evaluate(() => goal_ctx.getImageData(400, 300, 1, 1).data[3] === 255)); i++) await sleep(100);
	await evaluate(async () => (await import("/src/functions.js")).open_from_image_info({ image: new ImageData(4, 4) }, null, null, true, true));
	await sleep(500);
	const offline = { rescores: (await rescores()) - offline_from, status: await status(), session: await evaluate(async () => (await import("/src/archipelago.js")).session_name()) };
	check("before a game loads, a goal and a session that load make no rescore and no NaN in the status bar", offline.session === "offline" && offline.rescores === 0 && !/NaN/.test(offline.status), JSON.stringify(offline));
	// File > New and a resize that saves its size, as Image > Attributes makes one, come with no undo step: each rescores
	// itself, but only while a game is loaded.
	const offline_commands = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		const [width, height] = [main_canvas.width, main_canvas.height];
		let from = fn.rescore_count();
		fn.file_new();
		const after_new = { rescores: fn.rescore_count() - from, status: $status_similarity.text() };
		from = fn.rescore_count();
		fn.resize_canvas_and_save_dimensions(300, 200);
		const after_resize = { rescores: fn.rescore_count() - from, size: `${main_canvas.width}x${main_canvas.height}`, status: $status_similarity.text() };
		fn.resize_canvas_and_save_dimensions(width, height); // the size the profile keeps goes back to what it was
		return { session: (await import("/src/archipelago.js")).session_name(), new: after_new, resize: after_resize };
	});
	check("...and nor do File > New and a resize that saves its size, which rescore only while a game is loaded", offline_commands.session === "offline" && offline_commands.new.rescores === 0 && offline_commands.resize.rescores === 0 && offline_commands.resize.size === "300x200" && !/NaN/.test(offline_commands.new.status + offline_commands.resize.status), JSON.stringify(offline_commands));

	// The bundled goal, and a canvas with the goal at 16 shades in its top half and white below: the 600x450 start.
	await game();
	await evaluate(() => {
		const { width, height } = main_canvas, goal = goal_ctx.getImageData(0, 0, width, height), canvas = main_ctx.getImageData(0, 0, width, height);
		const quantize = (v) => Math.floor(Math.floor(v * 15 / 255 + 0.5) * 255 / 15 + 0.5);
		for (let i = 0; i < width * Math.floor(height / 2) * 4; i += 4) for (let c = 0; c < 3; c++) canvas.data[i + c] = quantize(goal.data[i + c]);
		main_ctx.putImageData(canvas, 0, 0);
	});
	console.log(`goal ${await evaluate(() => goal_canvas.width + "x" + goal_canvas.height)}, canvas ${await evaluate(() => main_canvas.width + "x" + main_canvas.height)}`);

	// 1. The score is the old loop's on the page's own reads, at every version branch (task 7.1).
	const by_version = [];
	for (const [label, version, b2, b5] of VERSIONS) {
		await game(slot_at(version));
		by_version.push({ label, ...(await against_reference(b2, b5)) });
	}
	check("the page's similarity is the old loop's on the same reads, with no seed and at 0.1.0, 0.4.0 and 1.0.0", by_version.every(agrees) && new Set(by_version.map((r) => r.units[0])).size === 3, by_version.map((r) => `${r.label} ${r.page.toFixed(6)}% (off ${r.gap.toExponential(1)})`).join("; "));
	// The session's own rescore put it in the status bar, by its version's formula, before anything else rescored.
	check("a new session's slot data shows its score at once, at each version", by_version.every((r) => r.shown_now), by_version.map((r) => `${r.label} showed ${r.shown}`).join("; "));
	await game();
	const by_size = [];
	for (const size of [[5, 5], [333, 217], [800, 600], [900, 650], [600, 450]]) by_size.push(await against_reference(false, false, size));
	check("...and at 5x5, 333x217, the goal's size, wider and taller than the goal, and 600x450", by_size.every(agrees), by_size.map((r) => `${r.size} ${r.page.toFixed(6)}% (off ${r.gap.toExponential(1)})`).join("; "));

	// 2. A view that doesn't show is left alone by a rescore: both stay magenta, on the 600x450 canvas and past it.
	const untouched = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		for (const canvas of [sim_canvas, diff_canvas]) { canvas.ctx.fillStyle = "#ff00ff"; canvas.ctx.fillRect(0, 0, canvas.width, canvas.height); }
		fn.calculate_similarity();
		const at = (canvas) => [[3, 3], [700, 500]].map(([x, y]) => Array.from(canvas.ctx.getImageData(x, y, 1, 1).data).join()).join(" ");
		return { shown: fn.shown_view, sim: at(sim_canvas), diff: at(diff_canvas) };
	});
	const magenta = "255,0,255,255 255,0,255,255";
	check("a rescore leaves a view that isn't showing alone", untouched.shown === null && untouched.sim === magenta && untouched.diff === magenta, JSON.stringify(untouched));

	// 3. A view shows drawn: after the canvas changed while it was hidden, and outside the 600x450 canvas too, where the
	// Similarity view is clear and the Difference view is the goal.
	await focus_page();
	await keyboard.press("m", ["Control", "Shift"]); // Similarity Mode
	await keyboard.press("m", ["Control", "Shift"]); // and back to the goal
	await call("image_invert_colors"); // what the Invert Colors trap runs, with no view showing
	await keyboard.press("m", ["Control", "Shift"]);
	const sim_shown = await views_against_reference();
	await keyboard.press("m", ["Control"]); // Difference Mode, in its place
	const diff_shown = await views_against_reference();
	await keyboard.press("m", ["Control"]);
	check("Similarity Mode shows drawn for the canvas as it is now, after a change made while it was hidden", sim_shown.shown.sim && !sim_shown.shown.diff && sim_shown.sim === 0, JSON.stringify(sim_shown));
	check("...and so does Difference Mode, byte for byte, the goal past the canvas's edges", diff_shown.shown.diff && !diff_shown.shown.sim && diff_shown.diff === 0, JSON.stringify(diff_shown));
	// The menu's checkbox and its own toggle go by the same view.
	await keyboard.press("m", ["Control", "Shift"]);
	const extras = await evaluate(() => { const r = [...document.querySelectorAll(".menu-button")].find((el) => /extras/i.test(el.textContent)).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
	await mouse.click(extras.x, extras.y);
	await sleep(250);
	const menu = await evaluate(() => {
		const item = (pattern) => [...document.querySelectorAll(".menu-item")].find((el) => pattern.test(el.textContent) && el.getBoundingClientRect().width > 0);
		const sim = item(/Similarity Mode/), diff = item(/Difference Mode/), r = sim.getBoundingClientRect();
		return { sim_checked: sim.getAttribute("aria-checked"), diff_checked: diff.getAttribute("aria-checked"), x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	await mouse.click(menu.x, menu.y);
	await sleep(250);
	if (await evaluate(() => !!document.querySelector(".menu-button.active"))) await keyboard.press("Escape");
	const after_menu = await evaluate(async () => ({ view: (await import("/src/functions.js")).shown_view, sim_shown: $sim.is(":visible") }));
	check("Extras shows Similarity Mode checked while it shows, and clicking it puts the goal back", menu.sim_checked === "true" && menu.diff_checked === "false" && after_menu.view === null && !after_menu.sim_shown, JSON.stringify({ sim_checked: menu.sim_checked, diff_checked: menu.diff_checked, ...after_menu }));

	// 4. A rescore at 800x600 makes no long task, and runs in under half the time the old one takes: its reads, its loop,
	// and its two views put, here into two canvases of their own. Each runs in a task of its own, the two taking turns.
	// Firefox reports no long tasks, so there the median under 50 ms, where a long task starts, is what holds it.
	await evaluate(async () => (await import("/src/functions.js")).resize_canvas_without_saving_dimensions(800, 600));
	const timing = await evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		const { reference_similarity } = await import("/test/paint-hard/scoring-reference.mjs");
		const fw = ap.final_width, fh = ap.final_height, views = [sim_canvas, diff_canvas].map(() => make_canvas(fw, fh));
		const old_rescore = () => {
			const { width, height } = main_canvas;
			const { sim, diff } = reference_similarity(main_ctx.getImageData(0, 0, width, height).data, width, height, goal_ctx.getImageData(0, 0, fw, fh).data, fw, fh, ap.version_below("0.2.0"), ap.version_below("0.5.0"));
			views[0].ctx.putImageData(new ImageData(sim, fw, fh), 0, 0);
			views[1].ctx.putImageData(new ImageData(diff, fw, fh), 0, 0);
		};
		const next_task = () => new Promise((resolve) => setTimeout(resolve, 20));
		const page = [], old = [], long_tasks = [], in_rescores = [];
		const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) long_tasks.push({ at: entry.startTime, ms: entry.duration }); });
		try { observer.observe({ type: "longtask" }); } catch { } // Chromium only
		for (let k = 0; k < 9; k++) {
			await next_task();
			let start = performance.now();
			fn.calculate_similarity();
			page.push(performance.now() - start);
			in_rescores.push([start, performance.now()]);
			await next_task();
			start = performance.now();
			old_rescore();
			old.push(performance.now() - start);
		}
		await next_task();
		observer.disconnect();
		const median = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
		// The long tasks a rescore ran in: each holds the whole of the rescore's run.
		const page_long = long_tasks.filter((task) => in_rescores.some(([start, end]) => task.at <= start && end <= task.at + task.ms));
		return { page_ms: +median(page).toFixed(1), old_ms: +median(old).toFixed(1), page_long_tasks: page_long.map((task) => Math.round(task.ms)), all_long_tasks: long_tasks.length, long_tasks_reported: !!PerformanceObserver.supportedEntryTypes?.includes("longtask") };
	});
	check("a rescore at 800x600 makes no long task, its median under the 50 ms one starts at, in under half the old rescore's time", timing.page_long_tasks.length === 0 && timing.page_ms < 50 && timing.page_ms < timing.old_ms / 2, JSON.stringify(timing));

	// 5. Item packets (task 7.2). Fillers and color items make no rescore and leave the Colors box as it was built; a
	// palette color rebuilds it; a canvas item, a DeathLink, a goal load and a session load make one rescore each.
	await game();
	const quiet = await evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		const button = document.querySelector(".palette .color-button"), from = fn.rescore_count();
		for (let k = 0; k < 25; k++) {
			ap.fake_packet(["Late Filler"]);
			ap.fake_packet(["Progressive Color Depth (Red)"]);
		}
		return { rescores: fn.rescore_count() - from, kept: !!button?.isConnected, colors: document.querySelectorAll(".palette .color-button").length };
	});
	check("50 filler and color packets make no rescore", quiet.rescores === 0, JSON.stringify(quiet));
	check("...and leave the Colors box as it was built", quiet.kept, JSON.stringify(quiet));
	const palette = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		const button = document.querySelector(".palette .color-button");
		ap.fake_packet(["Additional Palette Color"]);
		return { rebuilt: !button.isConnected, colors: document.querySelectorAll(".palette .color-button").length };
	});
	check("a palette color rebuilds the Colors box with it", palette.rebuilt && palette.colors === quiet.colors + 1, JSON.stringify(palette));
	// One packet copies the received names once. The default tool's pick used to copy them 8 more times.
	const copies = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		const names = ap.received().length + 1, slice = Array.prototype.slice;
		let n = 0;
		Array.prototype.slice = function (...args) { if (this.length === names) n++; return slice.apply(this, args); };
		try { ap.fake_packet(["Late Filler"]); } finally { Array.prototype.slice = slice; }
		return n;
	});
	check("...and a packet copies the received names once", copies === 1, `${copies} copies`);

	const one_each = {};
	let from = await rescores();
	await evaluate(async () => (await import("/src/archipelago.js")).fake_packet(["Progressive Canvas Width"]));
	one_each.canvas_item = { rescores: (await rescores()) - from, size: await evaluate(() => `${main_canvas.width}x${main_canvas.height}`) };
	from = await rescores();
	await evaluate(async () => (await import("/src/archipelago.js")).death_received());
	one_each.deathlink = (await rescores()) - from;
	from = await rescores();
	await evaluate(() => { $goal_image.attr("src", "images/archipelago/800x600.png?again"); });
	one_each.goal_load = (await rescores_past(from)) - from;
	from = await rescores();
	await evaluate(async () => (await import("/src/functions.js")).open_from_image_info({ image: new ImageData(4, 4) }, null, null, true, true));
	one_each.session_load = (await rescores_past(from)) - from;
	await sleep(300);
	one_each.session_load_later = (await rescores()) - from;
	check("a canvas item makes one rescore", one_each.canvas_item.rescores === 1 && one_each.canvas_item.size === "700x450", JSON.stringify(one_each));
	check("...and so do a DeathLink, a goal load and a session load", one_each.deathlink === 1 && one_each.goal_load === 1 && one_each.session_load === 1 && one_each.session_load_later === 1, JSON.stringify(one_each));

	// A color item that changes a channel's shades rounds each palette color to them again, from the color the palette
	// stores. The third button's color is set as Edit Colors stores one, mid gray at 3 shades a channel. A. One more red
	// item gives red 4 shades, and 128 isn't one of them. B. A palette color rebuilds the box at 4 shades, then one more
	// red item gives 5, and 128 is one of them again, where the 170 the button held would round to 191.
	const palette_kept = await evaluate(() => palette.length);
	await game(SLOT_DATA, ["Magnifier", "Brush", ...Array(Math.max(1, palette_kept - 2)).fill("Additional Palette Color"), "Progressive Color Depth (Red)", "Progressive Color Depth (Green)", "Progressive Color Depth (Blue)"]);
	const third_button = () => evaluate(async () => {
		const ap = await import("/src/archipelago.js"), table = ap.slotData.shade_counts;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); // a swatch paints on a frame
		const buttons = document.querySelectorAll(".palette .color-button"), button = buttons[2], canvas = button?.querySelector("canvas");
		const r = button?.getBoundingClientRect();
		return { shades: ["Red", "Green", "Blue"].map((channel) => table[Math.min(ap.rungs(`Progressive Color Depth (${channel})`), table.length - 1)]).join(), buttons: buttons.length, stored: palette[2], held: button ? $(button).data("swatch") : null, shown: canvas?.width && canvas.height ? Array.from(canvas.ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3)).join() : null, x: r && Math.round(r.left + r.width / 2), y: r && Math.round(r.top + r.height / 2) };
	});
	// The color a click on the button selects, with the foreground set back to black after it.
	const picked = async (button) => {
		await sleep(600); // past the double-click time since the last click
		await mouse.click(button.x, button.y);
		await sleep(150);
		return evaluate(() => { const color = selected_colors.foreground; selected_colors.foreground = "rgb(0,0,0)"; $G.trigger("option-changed"); return color; });
	};
	const set_up = await evaluate(async () => {
		const { update_$swatch } = await import("/src/$ColorBox.js");
		palette[2] = "rgb(128,128,128)";
		update_$swatch($(document.querySelectorAll(".palette .color-button")[2]), "rgb(128,128,128)");
	}).then(third_button);
	await evaluate(async () => (await import("/src/archipelago.js")).fake_packet(["Progressive Color Depth (Red)"]));
	const four = await third_button();
	four.picked = await picked(four);
	check("a color item that changes a channel's shades rounds a stored palette color to them: mid gray at 4 red shades is rgb(170,128,128) on its button, shown and picked", set_up.shades === "3,3,3" && set_up.held === "rgb(128,128,128)" && four.shades === "4,3,3" && four.stored === "rgb(128,128,128)" && four.held === "rgb(170,128,128)" && four.shown === "170,128,128" && four.picked === "rgb(170,128,128)", JSON.stringify({ set_up, four }));
	await evaluate(async () => (await import("/src/archipelago.js")).fake_packet(["Additional Palette Color"]));
	const rebuilt = await third_button();
	await evaluate(async () => (await import("/src/archipelago.js")).fake_packet(["Progressive Color Depth (Red)"]));
	const five = await third_button();
	five.picked = await picked(five);
	check("...from the color the palette stores, not the one its button holds: a palette color and a fifth red shade put the button back at rgb(128,128,128)", rebuilt.buttons === four.buttons + 1 && rebuilt.held === "rgb(170,128,128)" && five.shades === "5,3,3" && five.stored === "rgb(128,128,128)" && five.held === "rgb(128,128,128)" && five.shown === "128,128,128" && five.picked === "rgb(128,128,128)", JSON.stringify({ rebuilt, five }));

	// File > New and a resize that saves its size, as Image > Attributes makes one, come with no undo step, so with a game
	// loaded each rescores itself: an item packet rescores only a canvas whose size changed. The canvas is painted first,
	// so the blank one scores apart from it, and Similarity Mode shows through File > New.
	await game();
	const paint_block = () => evaluate(async () => {
		const fn = await import("/src/functions.js");
		main_ctx.putImageData(goal_ctx.getImageData(0, 0, 350, 300), 0, 0);
		fn.calculate_similarity();
		return $status_similarity.text().split("/")[0];
	});
	const painted_score = await paint_block();
	await evaluate(async () => {
		const fn = await import("/src/functions.js");
		fn.show_view("similarity");
		fn.file_new();
	});
	const new_view = await views_against_reference();
	const after_new = await against_reference(false, false);
	await evaluate(async () => (await import("/src/functions.js")).show_view(null));
	check("File > New with a game loaded rescores: the status bar shows the blank canvas's score, and the view that shows is drawn for it", after_new.shown_now && agrees(after_new) && after_new.shown !== painted_score && new_view.shown.sim && new_view.sim === 0, JSON.stringify({ painted: painted_score, after_new, view: new_view }));
	const repainted_score = await paint_block();
	await evaluate(async () => (await import("/src/functions.js")).resize_canvas_and_save_dimensions(800, 600));
	const after_resize = await against_reference(false, false);
	await evaluate(async () => (await import("/src/functions.js")).resize_canvas_and_save_dimensions(600, 450)); // the size the profile keeps goes back
	check("...and so does a resize that saves its size: at 800x600 the status bar shows the canvas's score there", after_resize.size === "800x600" && after_resize.shown_now && agrees(after_resize) && after_resize.shown !== repainted_score, JSON.stringify({ painted: repainted_score, after_resize }));

	// A speed copy moves the logic figure after the slash, at 1 h of auto copy in logic, with no rescore.
	await game(slot_at("1.0.0", { auto_copy_logic_hours: 1 }), ["Magnifier", "Brush", ...FULL_COLOR, ...SURE]);
	const speed = await evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		const before = $status_similarity.text(), from = fn.rescore_count();
		ap.fake_packet(["Progressive Auto Copy Speed"]);
		return { before, after: $status_similarity.text(), logic: fn.calculate_logic_similarity().toFixed(4), rescores: fn.rescore_count() - from };
	});
	const [similarity_before, logic_before] = speed.before.split("/"), [similarity_after, logic_after] = speed.after.split("/");
	check("a speed copy moves the logic figure with no rescore", speed.rescores === 0 && logic_after !== logic_before && logic_after === `${speed.logic}%` && similarity_after === similarity_before, JSON.stringify(speed));

	// A view whose item a new session lacks hides, in a seed with the ladders.
	const LADDER_SLOT = { ...SLOT_DATA, ladders: true };
	await game(LADDER_SLOT, [...ITEMS, "Progressive Difference Mode"]);
	await focus_page();
	await keyboard.press("m", ["Control"]);
	const shown_before = await evaluate(() => $diff.is(":visible"));
	await game(LADDER_SLOT);
	const locked = await evaluate(async () => ({ shown: $diff.is(":visible"), view: (await import("/src/functions.js")).shown_view }));
	check("a view hides when a session without its item loads", shown_before && !locked.shown && locked.view === null, JSON.stringify({ shown_before, ...locked }));

	// 6. Auto copy's running total uses the seed's formula too, so it matches a rescore at 0.4.0 as it does from 0.5.0.
	await game(slot_at("0.4.0"));
	await evaluate(() => { main_ctx.fillStyle = "#fff"; main_ctx.fillRect(0, 0, main_canvas.width, main_canvas.height); });
	await focus_page();
	await keyboard.press("m", ["Shift"]); // open the panel and start
	await sleep(2500);
	// The module first, then both figures in one task, so no tick of auto copy paints between the two reads.
	const totals = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		return { running: window.paint_hard_auto_copy.similarity(), full: fn.calculate_similarity() };
	});
	await keyboard.press("m", ["Shift"]); // pause
	check("at 0.4.0 auto copy's running total matches a rescore", totals.running !== null && Math.abs(totals.running - totals.full) < 1e-9, JSON.stringify(totals));

	// 7. M adds each pixel it paints to that total by the seed's formula too. A 0.4.0 seed has no ladders, so M held beside
	// a running auto copy makes auto copy wait, and the send auto copy had due goes out during the hold from the running
	// total, which by then holds M's pixels since M's own last rescore. Each score the page shows is compared, as it is
	// shown, with the canvas's root-mean-square score at that moment, and whether a rescore made it is noted: one that
	// isn't from a rescore comes from the running total.
	await evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js"), scoring = await import("/src/scoring.js");
		window.__shown = [];
		let rescores = fn.rescore_count();
		const text = $status_similarity.text;
		$status_similarity.text = function (...args) {
			if (args.length) {
				const width = Math.min(main_canvas.width, ap.final_width), height = Math.min(main_canvas.height, ap.final_height);
				const canvas = main_ctx.getImageData(0, 0, width, height).data, goal = goal_ctx.getImageData(0, 0, width, height).data;
				const want = scoring.similarity_of(scoring.score_area(scoring.RMS, canvas, goal, width, height), ap.final_width, ap.final_height);
				const now = fn.rescore_count();
				window.__shown.push({ at: performance.now(), shown: Number(String(args[0]).split("%")[0]), want, rescored: now !== rescores, held: !!window.__holding });
				rescores = now;
			}
			return text.apply(this, args);
		};
	});
	await keyboard.press("m", ["Shift"]); // resume
	// M held along row 300, 2 pixels every 16 ms for 4 s, from 150 ms after auto copy shows a score from its total, or
	// 5 s in if it shows none.
	const hold = await evaluate(() => new Promise((resolve) => {
		const rect = main_canvas.getBoundingClientRect();
		const at = (px) => ({ clientX: rect.left + (px + 0.5) * rect.width / main_canvas.width, clientY: rect.top + 300.5 * rect.height / main_canvas.height, bubbles: true });
		const seen = window.__shown.length, asked = performance.now();
		const wait = setInterval(() => {
			const last = window.__shown.at(-1), from_total = window.__shown.length > seen && !last.rescored && performance.now() - last.at >= 150;
			if (!from_total && performance.now() - asked < 5000) return;
			clearInterval(wait);
			let px = 20;
			dispatchEvent(new PointerEvent("pointermove", at(px)));
			window.__holding = true;
			dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true }));
			const from = performance.now();
			const timer = setInterval(() => {
				px = Math.min(px + 2, main_canvas.width - 1);
				dispatchEvent(new PointerEvent("pointermove", at(px)));
				if (performance.now() - from < 4000) return;
				clearInterval(timer);
				dispatchEvent(new KeyboardEvent("keyup", { key: "m", code: "KeyM", bubbles: true }));
				setTimeout(() => { window.__holding = false; resolve({ after_a_send_from_the_total: from_total, status: $status_text.text() }); }, 400);
			}, 16);
		}, 10);
	}));
	await keyboard.press("m", ["Shift"]); // pause
	const shown = await evaluate(() => { delete $status_similarity.text; return window.__shown; });
	const from_total = shown.filter((s) => s.held && !s.rescored), off = shown.filter((s) => Math.abs(s.shown - s.want) > 6e-5);
	check(`at 0.4.0 every score shown while M is held beside a running auto copy is the canvas's own: ${shown.length} shown, ${from_total.length} of them from the running total during the hold`, from_total.length >= 1 && off.length === 0, JSON.stringify({ shown: shown.length, during_the_hold: shown.filter((s) => s.held).length, from_the_total_during_the_hold: from_total.length, off: off.slice(0, 4).map((s) => ({ shown: s.shown, want: +s.want.toFixed(6), rescored: s.rescored, held: s.held })), worst_gap: shown.reduce((most, s) => Math.max(most, Math.abs(s.shown - s.want)), 0), hold }));

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
