// End-to-end test of the undo history's byte budget, whole-canvas reads paced by their cost, and one read of the goal
// for each goal (task 7.3 of the fork's ROADMAP, Phase 7, with 7.10's shared goal read). The budget is set by a test
// hook to 1 byte or to 2, 3, 4 or 5 steps of 800x600, so they fill it: the oldest steps go, the oldest kept becomes the
// root, and Ctrl+Z, the History window and an Undo Trap stop there. Never fewer than 2 steps stay, and Esc's cancel point
// stays. Left alone, the budget is 512 MiB, to the byte. Reads slowed by a wrapped getImageData() space auto copy's and
// M's snapshots of a step, and the counts of the pixels left, at 50 times their cost. A goal is read once, and read again
// only for a new goal, a goal canvas of another size or a login, and a login rescores though the canvas has the size
// last scored. A step that leaves the history lets go of its canvas copy and its links, whatever points at it; a step
// made from the history's first step keeps the line Redo led to for that step; and a second finger inside 500 ms takes
// Fill's step out of the history and out of Redo, by touch in Chromium. It stands in for a game with fake_session(),
// then logs in twice through Paint's own Connect button to a stand-in server (stand-in-server.mjs).
// Usage: node test/paint-hard/history.e2e.mjs [--headful]. Set BROWSER_PATH if Chrome isn't in its default folder.
import { add_init_script, check, chromium, evaluate, finish, keyboard, mouse, open_paint, page, page_errors, point_on, sleep } from "./harness.mjs";
import { CONTRACT, ITEMS, LOCATIONS, connect, fake_server, id_of, window_shown } from "./stand-in-server.mjs";

const color_items = (n) => ["Red", "Green", "Blue"].flatMap((channel) => Array(n).fill(`Progressive Color Depth (${channel})`));
const FULL_COLOR = color_items(254);
const speed_items = (n) => Array(n).fill("Progressive Auto Copy Speed");
const SURE = [...Array(9).fill("Progressive Auto Copy Accuracy"), "Auto Copy Loop"]; // auto copy and M never miss
const SLOT_DATA = { final_width: 800, final_height: 600, start_width: 800, start_height: 600, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 2, miss_margin_step: 1, version: "1.1.0", trap_blacklist: [] };
const STEP = 800 * 600 * 4; // the bytes of one step's canvas copy at 800x600
const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;

// What the page gets after it loads: a digest of RGBA bytes, the canvas's painted pixels, the history tree from its root,
// and a goal drawn as auto-copy.e2e.mjs draws it, or shifted by `seed`, with the save-goal a goal the page draws comes with.
const HELPERS = () => {
	window.__h = {
		digest(data) { let h = 2166136261; for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); },
		canvas() { return __h.digest(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data); },
		painted() {
			const d = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
			let n = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) n++;
			return n;
		},
		nodes() { const all = [], stack = [root_history_node]; while (stack.length) { const node = stack.pop(); all.push(node); stack.push(...node.futures); } return all; },
		// Waits up to `ms` for auto copy's next count ("counts") or snapshot ("snapshots"), by the newest entry's time, since
		// the log keeps its last 40. With none in that time it throws, so no check goes on to judge a read that never came.
		next_read(kind, ms = 10000) {
			const newest = () => { const entry = window.paint_hard_auto_copy.read_log()[kind].at(-1); return entry?.at ?? entry ?? null; };
			const from = newest(), until = performance.now() + ms;
			return new Promise((resolve, reject) => {
				const timer = setInterval(() => {
					const now = newest();
					if (now === from && performance.now() < until) return;
					clearInterval(timer);
					if (now === from) reject(new Error(`auto copy made none of its ${kind} in ${ms} ms`));
					else resolve();
				}, 20);
			});
		},
		goal(seed = 0) {
			const { width, height } = goal_canvas, image = goal_ctx.createImageData(width, height);
			for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y + seed) % 256, (y * 2 + 50 + seed * 7) % 256, (x + y * 3 + seed * 13) % 256, 255], (y * width + x) * 4);
			goal_ctx.putImageData(image, 0, 0);
			$G.triggerHandler("save-goal");
		},
	};
};
// The game's slot data and items, on the 800x600 canvas, with the test's goal.
const game = (items, slot = SLOT_DATA) => evaluate(async (slot, items) => {
	const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
	ap.fake_session(slot, ["Magnifier", "Brush", ...items]);
	fn.resize_canvas_without_saving_dimensions(slot.start_width, slot.start_height);
	__h.goal();
	fn.set_magnification(1);
}, slot, items);
// A history that starts over: a blank canvas, its one step New, and the budget at `bytes`.
const fresh_history = (bytes) => evaluate(async (bytes) => {
	const fn = await import("/src/functions.js");
	fn.reset_canvas_and_history();
	fn.set_undo_budget(bytes);
}, bytes);
// A step of your own, as Paint's tools make one: a rectangle of `color` at (x, y). Paint's send() throws without a server.
const own_step = (x, y, color, name = "Brush") => evaluate(async (x, y, color, name) => {
	const fn = await import("/src/functions.js");
	try { fn.undoable({ name }, () => { main_ctx.fillStyle = color; main_ctx.fillRect(x, y, 40, 40); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
	return { node_digest: __h.digest(current_history_node.image_data.data), canvas: __h.canvas() };
}, x, y, color, name);
const shift_m = () => evaluate(() => { for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true })); });
// Presses M over canvas pixel (x, y) and gives back the status line after it.
const press_m = (x, y) => evaluate((x, y) => new Promise((resolve) => {
	const rect = main_canvas.getBoundingClientRect();
	dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + (x + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true }));
	for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "m", code: "KeyM", bubbles: true }));
	setTimeout(() => resolve($status_text.text()), 250);
}), x, y);
const read_log = () => evaluate(() => window.paint_hard_auto_copy.read_log());
const focus_page = async () => { await mouse.click(5, 895); await sleep(100); };
// The gaps between the times of a list that fall between `from` and `until`, in ms.
const gaps = (times, from, until = Infinity) => {
	const kept = times.filter((t) => t > from && t < until);
	return kept.slice(1).map((t, i) => Math.round(t - kept[i]));
};
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

try {
	await open_paint(ready);
	await evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("pain-t-")) localStorage.removeItem(key); });
	await evaluate(HELPERS);
	await game([...FULL_COLOR, ...speed_items(4), ...SURE]); // 16 pixels a second
	await focus_page();

	// 1. Auto copy's minutes make 9 steps after New, with the page's clock jumped 31 s at a time: a step's minute starts
	// where its first tick's time did, so each jump after the first passes a minute. The clock stays ahead from then on,
	// so nothing auto copy keeps runs backward. With the budget at 4 steps, the newest 4 stay; the History window, open
	// as they're made, shows those 4.
	await fresh_history(4 * STEP);
	await evaluate(async () => {
		(await import("/src/functions.js")).show_document_history();
		const real = performance.now.bind(performance);
		window.__clock = { offset: 0 };
		performance.now = () => real() + window.__clock.offset;
		window.__steps = [current_history_node];
	});
	await focus_page();
	await shift_m(); // opens the panel and starts
	await sleep(500);
	const note_step = () => evaluate(() => { if (window.__steps.at(-1) !== current_history_node) window.__steps.push(current_history_node); return window.__steps.length; });
	await note_step();
	for (let jump = 0; jump < 9; jump++) {
		await evaluate(() => { window.__clock.offset += 31000; });
		await sleep(400);
		await note_step();
	}
	await shift_m(); // pause, which brings the last step up to date
	await sleep(200);
	const minutes = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		const steps = window.__steps, kept = __h.nodes();
		const entries = [...document.querySelectorAll(".history-window .history-entry")].map((entry) => entry.textContent.trim().replace(/\s+/g, " "));
		return {
			made: steps.length - 1, kept: kept.length, newest_kept: steps.slice(-4).every((node) => kept.includes(node)) && kept.every((node) => steps.slice(-4).includes(node)),
			bytes: fn.history_bytes(), undos: undos.length, root_is_oldest_kept: root_history_node === steps.at(-4), root_parent: root_history_node.parent === null ? null : "a node",
			entries: entries.length, start_marked: entries.filter((text) => text.includes("(Start of History)")).length,
			digests: steps.slice(-4).map((node) => __h.digest(node.image_data.data)),
		};
	});
	check("auto copy's minutes, with the clock jumped, keep only the newest steps within the budget", minutes.made === 9 && minutes.kept === 4 && minutes.newest_kept && minutes.bytes <= 4 * STEP && minutes.undos === 3, JSON.stringify({ ...minutes, digests: undefined }));
	check("...and the oldest step kept is the root, with no parent", minutes.root_is_oldest_kept && minutes.root_parent === null, JSON.stringify({ root_is_oldest_kept: minutes.root_is_oldest_kept, parent: minutes.root_parent }));
	check("...and the History window, open as they were made, lists only the steps kept", minutes.entries === 4 && minutes.start_marked === 1, JSON.stringify({ entries: minutes.entries, start_marked: minutes.start_marked }));
	// Ctrl+Z walks back through the kept steps' own canvases and stops at the root.
	await focus_page();
	const walked = [];
	for (let k = 0; k < 4; k++) {
		await keyboard.press("z", ["Control"]);
		walked.push(await evaluate(() => ({ canvas: __h.canvas(), at_root: current_history_node === root_history_node, undos: undos.length })));
	}
	check("Ctrl+Z walks back through the kept steps and stops at the new root", walked.slice(0, 3).every((w, k) => w.canvas === minutes.digests[2 - k]) && walked[2].at_root && walked[3].at_root && walked[3].canvas === minutes.digests[0] && walked[3].undos === 0, JSON.stringify({ walked, kept: minutes.digests }));
	const trapped = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		const before = { node: current_history_node, canvas: __h.canvas() };
		let error = null;
		try { ap.handleTrap("Undo Trap", false, null); } catch (e) { error = e.message; }
		return { same_step: current_history_node === before.node, same_canvas: __h.canvas() === before.canvas, undos: undos.length, error };
	});
	check("an Undo Trap at the history's first step does nothing", trapped.same_step && trapped.same_canvas && trapped.undos === 0 && trapped.error === null, JSON.stringify(trapped));
	await evaluate(() => document.querySelector(".history-window .window-close-button")?.click());

	// 2. Never fewer than 2 steps: with the budget under one step, each new step keeps the one before it.
	await fresh_history(1);
	const strokes = [];
	for (const [k, color] of ["#000000", "#ff0000", "#00ff00", "#0000ff"].entries()) strokes.push(await own_step(100 + 50 * k, 100, color));
	const floor = await evaluate(() => ({ nodes: __h.nodes().length, undos: undos.length, root_parent: root_history_node.parent === null }));
	await focus_page();
	await keyboard.press("z", ["Control"]);
	const back_one = await evaluate(() => __h.canvas());
	await keyboard.press("z", ["Control"]);
	const back_two = await evaluate(() => __h.canvas());
	check("with a budget under one step, each new step keeps the one before it, and Ctrl+Z goes back to it and no further", floor.nodes === 2 && floor.undos === 1 && floor.root_parent && back_one === strokes[2].canvas && back_two === strokes[2].canvas, JSON.stringify({ ...floor, back_one: back_one === strokes[2].canvas, no_further: back_two === strokes[2].canvas }));
	// A branch off a step that goes counts with it, so no more steps go than the budget needs. At 512 MiB, New, then s1
	// to s3, back to s1, then t2 to t5 make 8 steps. At a budget of 5 steps the next, t6, drops New and s1, with s2 and s3
	// off it, and keeps t2 to t6.
	await fresh_history();
	for (const [k, color] of ["#101010", "#202020", "#303030"].entries()) await own_step(60 * k, 200, color, `s${k + 1}`);
	await evaluate(async () => { const fn = await import("/src/functions.js"); fn.undo(); fn.undo(); });
	for (const [k, color] of ["#404040", "#505050", "#606060", "#707070"].entries()) await own_step(60 * k, 260, color, `t${k + 2}`);
	const branched = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		const before = __h.nodes().length;
		fn.set_undo_budget(5 * 800 * 600 * 4);
		try { fn.undoable({ name: "t6" }, () => { main_ctx.fillStyle = "#808080"; main_ctx.fillRect(300, 300, 40, 40); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
		return { before, kept: __h.nodes().map((node) => node.name).sort(), root: root_history_node.name, bytes: fn.history_bytes() };
	});
	check("...and a branch off a step that goes counts with it, so no more steps go than the budget needs", branched.before === 8 && branched.root === "t2" && JSON.stringify(branched.kept) === JSON.stringify(["t2", "t3", "t4", "t5", "t6"]) && branched.bytes === 5 * STEP, JSON.stringify(branched));
	// A step with a floating selection keeps the selection's copy too, and counts it.
	const selected = await evaluate(async (slot, items) => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		ap.fake_session(slot, ["Magnifier", "Brush", "Select", ...items]);
		fn.set_undo_budget();
		const quietly = (step) => { try { step(); } catch (error) { if (!/not connected/i.test(error.message)) throw error; } };
		const before = fn.history_bytes();
		quietly(() => fn.select_all());
		const step = fn.history_bytes() - before;
		quietly(() => fn.deselect());
		return { step, selection: current_history_node.parent?.selection_image_data?.data.byteLength ?? null };
	}, SLOT_DATA, [...FULL_COLOR, ...speed_items(4), ...SURE]);
	check("...and a step with a selection counts the selection's copy beside the canvas's", selected.step === 2 * STEP, JSON.stringify(selected));

	// 3. With the budget full at 3 steps, M stays one step a press, and Esc still rolls back.
	await fresh_history(3 * STEP);
	const presses = [];
	for (let k = 0; k < 6; k++) {
		const before = await evaluate(() => { window.__before_press = current_history_node; return __h.nodes().length; });
		const status = await press_m(200 + 9 * k, 300);
		presses.push(await evaluate((before, status) => ({ status, new_step: current_history_node !== window.__before_press, on_it: current_history_node.parent === window.__before_press, nodes_before: before, nodes: __h.nodes().length }), before, status));
	}
	check("with the budget full, M stays one step a press", presses.every((p, k) => /^Copied /.test(p.status) && p.new_step && p.on_it && p.nodes === Math.min(k + 2, 3)), JSON.stringify(presses));
	// Fill makes its step as the press begins, so Esc with the button still down rolls a step back.
	await evaluate(async () => (await import("/src/functions.js")).select_tool(get_tool_by_id("TOOL_FILL")));
	const fill_at = await point_on("canvas", 400, 400);
	const before_fill = await evaluate(() => { window.__fill_from = current_history_node; return __h.canvas(); });
	await mouse.move(fill_at.x, fill_at.y);
	await mouse.down();
	await sleep(100);
	const filled = await evaluate(() => ({ changed: __h.canvas(), new_step: current_history_node !== window.__fill_from, nodes: __h.nodes().length }));
	await keyboard.press("Escape");
	await mouse.up();
	await sleep(100);
	const after_esc = await evaluate(() => ({ canvas: __h.canvas(), back: current_history_node === window.__fill_from, nodes: __h.nodes().length }));
	check("...and Esc with the button down still rolls back a fill, which makes its step as the press begins", filled.changed !== before_fill && filled.new_step && filled.nodes === 3 && after_esc.canvas === before_fill && after_esc.back, JSON.stringify({ filled: filled.changed !== before_fill, new_step: filled.new_step, nodes: filled.nodes, rolled_back: after_esc.canvas === before_fill, back: after_esc.back }));
	// A gesture that makes steps of its own, as the Select tool's moves do, rolls back with Esc to where it started, though
	// its 3 steps pass a budget of 2.
	await evaluate(async () => (await import("/src/functions.js")).set_undo_budget(2 * 800 * 600 * 4));
	const gesture = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		const start = current_history_node, from = __h.canvas();
		history_node_to_cancel_to = current_history_node; // as a press on the canvas sets it
		for (let k = 0; k < 3; k++) {
			try { fn.undoable({ name: "Move Selection" }, () => { main_ctx.fillStyle = "#808000"; main_ctx.fillRect(500 + 20 * k, 100, 15, 15); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
		}
		window.__gesture_start = start;
		return { from, moved: __h.canvas() !== from };
	});
	await keyboard.press("Escape");
	const rolled = await evaluate(() => ({ canvas: __h.canvas(), at_start: current_history_node === window.__gesture_start, kept: __h.nodes().includes(window.__gesture_start) }));
	check("a gesture that makes 3 steps of its own, past a budget of 2, rolls back with Esc to where it started", gesture.moved && rolled.canvas === gesture.from && rolled.at_start && rolled.kept, JSON.stringify({ moved: gesture.moved, rolled_back: rolled.canvas === gesture.from, at_start: rolled.at_start, kept: rolled.kept }));
	// The budget a page starts with is 512 MiB, to the byte (decision 5). On a 1024x512 canvas a step is 2 MiB. The first
	// step, New, is made to hold 508 MiB, in a zeroed ImageData that nothing writes, so with two more steps the history
	// holds 536,870,912 bytes, and with a 1x1 selection's copy on New as well, 4 bytes more.
	const default_budget = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		const step = 1024 * 512 * 4, budget = 512 * 1024 * 1024;
		fn.resize_canvas_without_saving_dimensions(1024, 512);
		const most = new ImageData(8192, (budget - 2 * step) / 4 / 8192);
		const filled = (more) => {
			fn.reset_canvas_and_history();
			fn.set_undo_budget();
			const first = root_history_node;
			first.image_data = most;
			if (more) first.selection_image_data = new ImageData(1, 1);
			for (const color of ["#102030", "#405060"]) {
				try { fn.undoable({ name: "Brush" }, () => { main_ctx.fillStyle = color; main_ctx.fillRect(10, 10, 40, 40); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
			}
			return { bytes: fn.history_bytes(), steps: __h.nodes().length, first_kept: root_history_node === first };
		};
		const held = { exact: filled(false), over: filled(true), step };
		fn.resize_canvas_without_saving_dimensions(800, 600);
		fn.reset_canvas_and_history();
		return held;
	});
	check("left alone, the budget is 512 MiB: three steps of 536,870,912 bytes all stay, and with 4 bytes more the oldest goes", default_budget.exact.bytes === 512 * 1024 * 1024 && default_budget.exact.steps === 3 && default_budget.exact.first_kept && default_budget.over.steps === 2 && !default_budget.over.first_kept && default_budget.over.bytes === 2 * default_budget.step, JSON.stringify(default_budget));

	// 4. Reads paced by their cost. getImageData() is wrapped to take 40 ms more for a read of the whole canvas, as a
	// snapshot of a step makes, and 2 ms more for a 16-row strip, 38 of which make a count of the pixels left.
	await evaluate(async () => {
		(await import("/src/functions.js")).set_undo_budget();
		const real = CanvasRenderingContext2D.prototype.getImageData;
		window.__slow = { whole: 0, strip: 0, real };
		CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh, ...rest) {
			if (this === main_ctx) {
				const ms = sw === main_canvas.width && sh === main_canvas.height ? window.__slow.whole : sh <= 16 && sw === main_canvas.width ? window.__slow.strip : 0;
				for (const until = performance.now() + ms; performance.now() < until;);
			}
			return real.call(this, sx, sy, sw, sh, ...rest);
		};
	});
	await game([...color_items(100), ...speed_items(6), ...SURE]); // 64 pixels a second, 102 shades
	await fresh_history();
	await focus_page();
	await shift_m(); // resume, now in this game
	await sleep(1500);
	let mark = await evaluate(() => performance.now());
	await sleep(5200);
	let log = await read_log();
	const plain = { snapshots: gaps(log.snapshots.filter((s) => s.by === "auto copy").map((s) => s.at), mark), counts: gaps(log.counts, mark) };
	await evaluate(() => { window.__slow.whole = 40; window.__slow.strip = 2; });
	await sleep(6000); // past the first slow snapshot and count, which set the next waits
	mark = await evaluate(() => performance.now());
	await sleep(13000);
	log = await read_log();
	const slow = { snapshots: gaps(log.snapshots.filter((s) => s.by === "auto copy").map((s) => s.at), mark), counts: gaps(log.counts, mark), count_every: Math.round(log.count_every), snapshot_every: Math.round(log.snapshot_every.auto) };
	check("with whole-canvas reads slowed by 40 ms, auto copy's snapshots of its step come 2 s apart or more, where they came every second", median(plain.snapshots) >= 950 && median(plain.snapshots) < 1300 && slow.snapshots.length >= 3 && Math.min(...slow.snapshots) >= 1950, JSON.stringify({ plain: plain.snapshots, slow: slow.snapshots, snapshot_every: slow.snapshot_every }));
	// The plain counts come 2 s apart or more: on a loaded machine a count of 40 ms and over sets a longer wait of its own.
	// So their bound is the slow counts, which stay 1.5 s and more above them. A slowed count of over 130 ms sets a wait
	// past 6.5 s, which can leave one count in the 13 s and no gap to measure: the wait the last count set, 3.8 s or
	// more, stands then.
	check("...and with strip reads slowed by 2 ms, its counts of the pixels left come 50 times their cost apart, where they came every 2 s", plain.counts.length >= 1 && Math.min(...plain.counts) >= 1950 && slow.counts.every((gap) => gap >= 3800) && slow.count_every >= 3800 && median(plain.counts) + 1500 <= Math.min(...slow.counts), JSON.stringify({ plain: plain.counts, slow: slow.counts, count_every: slow.count_every }));
	// New shades count at once, though the last count says to wait.
	const shade = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		await __h.next_read("counts");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const at = performance.now();
		ap.fake_packet(["Progressive Color Depth (Red)"]);
		await new Promise((resolve) => setTimeout(resolve, 600));
		const next = window.paint_hard_auto_copy.read_log().counts.find((t) => t > at);
		return { counted_after_ms: next === undefined ? null : Math.round(next - at), count_every: Math.round(window.paint_hard_auto_copy.read_log().count_every) };
	});
	check("...and a color item's new shades still count at once", shade.counted_after_ms !== null && shade.counted_after_ms < 400 && shade.count_every >= 3800, JSON.stringify(shade));
	// A pause still brings the step up to date at once, between paced snapshots.
	const paused = await evaluate(async () => {
		await __h.next_read("snapshots");
		const painted_at_snapshot = __h.painted();
		await new Promise((resolve) => setTimeout(resolve, 700));
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true })); // pause
		window.__slow.whole = 0;
		return { painted_since: __h.painted() - painted_at_snapshot, step_is_canvas: __h.digest(current_history_node.image_data.data) === __h.canvas() };
	});
	check("...and a pause still brings the step up to date at once", paused.painted_since > 0 && paused.step_is_canvas, JSON.stringify(paused));
	// So does a press on the canvas: Esc mid-stroke then keeps auto copy's pixels from before the press.
	await evaluate(async () => {
		window.__slow.whole = 40;
		(await import("/src/functions.js")).select_tool(get_tool_by_id("TOOL_BRUSH"));
	});
	await focus_page();
	await shift_m(); // resume
	const press_at = await point_on("canvas", 700, 550);
	await mouse.move(press_at.x, press_at.y);
	const before_press = await evaluate(async () => {
		for (let i = 0; i < 2; i++) await __h.next_read("snapshots");
		const at_snapshot = __h.painted();
		await new Promise((resolve) => setTimeout(resolve, 700));
		return { at_snapshot, now: __h.painted() };
	});
	await mouse.down();
	await sleep(100);
	await keyboard.press("Escape");
	await mouse.up();
	await sleep(100);
	const after_press = await evaluate(() => __h.painted());
	await shift_m(); // pause
	check("...and so does a press on the canvas, so Esc mid-stroke keeps auto copy's pixels from before it", before_press.now > before_press.at_snapshot && after_press >= before_press.now, JSON.stringify({ ...before_press, after_esc: after_press }));
	// M paces its own snapshots, from 250 ms, and the panel's counts while auto copy is stopped are paced as auto copy's
	// are, from the panel's 2 s. M is held along a row, a pixel every 100 ms, first with plain reads, then slowed; the
	// snapshot letting go of M saves at once is left out.
	const hold_m = (seconds, y) => evaluate((seconds, y) => new Promise((resolve) => {
		const rect = main_canvas.getBoundingClientRect();
		const at = (px) => ({ clientX: rect.left + (px + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true });
		let px = 20;
		dispatchEvent(new PointerEvent("pointermove", at(px)));
		dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true }));
		const from = performance.now();
		const timer = setInterval(() => {
			dispatchEvent(new PointerEvent("pointermove", at(++px)));
			if (performance.now() - from < seconds * 1000) return;
			clearInterval(timer);
			const until = performance.now();
			dispatchEvent(new KeyboardEvent("keyup", { key: "m", code: "KeyM", bubbles: true }));
			setTimeout(() => resolve({ from, until }), 300);
		}, 100);
	}), seconds, y);
	// Waits up to 10 s for a count that sets the next wait to 2 s, or past it.
	const count_waits = async (longer) => { for (let i = 0; i < 100 && ((await read_log()).count_every > 2000) !== longer; i++) await sleep(100); };
	await evaluate(() => { window.__slow.whole = 0; window.__slow.strip = 0; });
	await count_waits(false);
	let held = await hold_m(5, 120);
	log = await read_log();
	const m_snapshots = () => log.snapshots.filter((s) => s.by === "M").map((s) => s.at);
	const m_plain = { snapshots: gaps(m_snapshots(), held.from, held.until), counts: gaps(log.counts, held.from, held.until) };
	await evaluate(() => { window.__slow.whole = 40; window.__slow.strip = 2; });
	await count_waits(true);
	held = await hold_m(13, 140);
	log = await read_log();
	const m_slow = { snapshots: gaps(m_snapshots(), held.from, held.until), counts: gaps(log.counts, held.from, held.until), count_every: Math.round(log.count_every) };
	await evaluate(() => { CanvasRenderingContext2D.prototype.getImageData = window.__slow.real; });
	check("M's snapshots of its step come 2 s apart or more with whole-canvas reads slowed by 40 ms, where they came every 250 ms", m_plain.snapshots.length >= 8 && median(m_plain.snapshots) < 450 && m_slow.snapshots.length >= 3 && Math.min(...m_slow.snapshots) >= 1950, JSON.stringify({ plain: m_plain.snapshots, slow: m_slow.snapshots }));
	// The stopped panel counts on a 2 s timer, and each tick finds the last count one count's time short of a multiple of
	// 2 s back. So a slowed count of 118 ms and over, whose wait is 5.9 s and more, misses the tick 6 s on and comes 8 s
	// or more after the last, and the 13 s can hold one count and no gap: the wait the last count set stands then, as
	// above.
	check("...and the counts the stopped panel makes come 50 times their cost apart too, where they came every 2 s", m_plain.counts.length >= 1 && Math.min(...m_plain.counts) >= 1950 && m_slow.counts.every((gap) => gap >= 3800) && m_slow.count_every >= 3800 && Math.max(...m_plain.counts) < Math.min(...m_slow.counts), JSON.stringify({ plain: m_plain.counts, slow: m_slow.counts, count_every: m_slow.count_every }));
	await evaluate(() => document.querySelector(".auto-copy-panel .window-close-button")?.click());

	// 5. One read of the goal for each goal. Reads of the goal canvas are counted from a new goal on.
	await game([...FULL_COLOR, ...speed_items(6), ...SURE], { ...SLOT_DATA, start_width: 600, start_height: 450, matched_pixels: 25 });
	await fresh_history();
	await evaluate(() => {
		const real = CanvasRenderingContext2D.prototype.getImageData;
		window.__goal_reads = [];
		goal_ctx.getImageData = function (...args) { window.__goal_reads.push(args.join(",")); return real.apply(this, args); };
		__h.goal(1); // a new goal, with save-goal, whose rescore reads it
	});
	const after_load = await evaluate(() => [...window.__goal_reads]);
	const used = await evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		for (let k = 0; k < 5; k++) fn.calculate_similarity();
		for (let k = 0; k < 3; k++) window.paint_hard_auto_copy.pixels_left();
		let matched = null;
		try { ap.send(-1); } catch (error) { matched = error.message; } // below every check, so Matched Pixels are counted
		return { matched };
	});
	for (const [x, y] of [[10, 10], [30, 12], [50, 14]]) await press_m(x, y);
	await focus_page();
	await shift_m(); // auto copy's start counts, rescores and scans; it counts again 2 s in
	await sleep(3000);
	await shift_m();
	const reads_once = await evaluate(() => [...window.__goal_reads]);
	check("a goal is read once for every rescore, count of the pixels left, auto copy's scan, M and Matched Pixels", after_load.length === 1 && reads_once.length === 1 && /not connected/i.test(used.matched ?? ""), JSON.stringify({ at_its_load: after_load, after_all_that: reads_once, matched_pixels_counted: used.matched }));
	// A second goal is read once more, and its score is the old loop's on fresh reads.
	const second = await evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		const { reference_similarity } = await import("/test/paint-hard/scoring-reference.mjs");
		const real = CanvasRenderingContext2D.prototype.getImageData;
		__h.goal(2);
		const page_score = fn.calculate_similarity(), reads = window.__goal_reads.length;
		const { width, height } = main_canvas;
		const reference = reference_similarity(main_ctx.getImageData(0, 0, width, height).data, width, height, real.call(goal_ctx, 0, 0, ap.final_width, ap.final_height).data, ap.final_width, ap.final_height, false, false).similarity;
		return { reads, gap: Math.abs(page_score - reference), page_score, reference };
	});
	check("...and a new goal drawn after it is read once more, and scored", second.reads === 2 && second.gap < 1e-9, JSON.stringify(second));
	// A goal canvas of another size is read again at its size, with no save-goal.
	const resized = await evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		const { reference_similarity } = await import("/test/paint-hard/scoring-reference.mjs");
		const real = CanvasRenderingContext2D.prototype.getImageData;
		goal_canvas.width = 700;
		goal_canvas.height = 500;
		const image = goal_ctx.createImageData(700, 500);
		for (let i = 0; i < image.data.length; i += 4) image.data.set([(i * 5) % 256, (i * 11) % 256, (i * 3) % 256, 255], i);
		goal_ctx.putImageData(image, 0, 0);
		const page_score = fn.calculate_similarity(), reads = window.__goal_reads.length;
		const { width, height } = main_canvas;
		const reference = reference_similarity(main_ctx.getImageData(0, 0, width, height).data, width, height, real.call(goal_ctx, 0, 0, ap.final_width, ap.final_height).data, ap.final_width, ap.final_height, false, false).similarity;
		goal_canvas.width = 800;
		goal_canvas.height = 600;
		__h.goal();
		return { reads, gap: Math.abs(page_score - reference), page_score, reference, canvas: `${width}x${height}` };
	});
	check("a goal canvas that changes size is read again at its size", resized.reads === 3 && resized.gap < 1e-9, JSON.stringify(resized));
	// A stand-in session whose goal size passes the goal canvas's still scores the area past it, against transparent
	// black, as before the shared read.
	const past = await evaluate(async (slot) => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		const { reference_similarity } = await import("/test/paint-hard/scoring-reference.mjs");
		ap.fake_session({ ...slot, final_width: 900, final_height: 700, start_width: 900, start_height: 700 }, ["Magnifier", "Brush"]);
		fn.resize_canvas_without_saving_dimensions(900, 700);
		const page_score = fn.calculate_similarity();
		const reference = reference_similarity(main_ctx.getImageData(0, 0, 900, 700).data, 900, 700, goal_ctx.getImageData(0, 0, 900, 700).data, 900, 700, false, false).similarity;
		return { page_score, reference, gap: Math.abs(page_score - reference) };
	}, SLOT_DATA);
	check("a stand-in session whose goal is bigger than the goal canvas scores past the goal canvas's edge as before", Number.isFinite(past.page_score) && past.gap < 1e-9, JSON.stringify(past));

	// 6. A step that leaves the history lets go of its canvas copy and its links, whatever still points at it: auto copy
	// keeps its own step and the last one it saw while it is paused. The steps are watched through WeakRefs, and in
	// Chromium the page's garbage is collected three times before they are read, so a step still alive is one that
	// something points at. Auto copy runs at 16 pixels a second.
	await game([...FULL_COLOR, ...speed_items(4), ...SURE]);
	// A history that starts over at a budget of 5 steps, auto copy's own step in it, and auto copy paused after it, its
	// step watched.
	const auto_copy_step = async () => {
		await fresh_history(5 * STEP);
		await focus_page();
		await shift_m(); // resume
		for (let i = 0; i < 80 && !(await evaluate(() => /Auto Copy/.test(current_history_node.name))); i++) await sleep(100);
		await shift_m(); // pause
		await sleep(300);
		return evaluate(() => { window.__watched = [new WeakRef(current_history_node)]; return { at: current_history_node.name, running: window.paint_hard_auto_copy.running() }; });
	};
	// Steps of your own, each watched.
	const watched_steps = (count) => evaluate(async (count) => {
		const fn = await import("/src/functions.js");
		for (let k = 0; k < count; k++) {
			try { fn.undoable({ name: `own ${k + 1}` }, () => { main_ctx.fillStyle = `rgb(${k * 9}, 40, 90)`; main_ctx.fillRect(10 + (k % 15) * 45, 10 + (k % 10) * 45, 40, 40); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
			window.__watched.push(new WeakRef(current_history_node));
		}
	}, count);
	// The watched steps the history no longer holds and that are still alive, and those of them that keep a canvas copy or
	// a link.
	const steps_left = async () => {
		if (chromium) for (let i = 0; i < 3; i++) { await page("HeapProfiler.collectGarbage"); await sleep(150); }
		return evaluate(async () => {
			const fn = await import("/src/functions.js");
			const kept = __h.nodes(), alive = window.__watched.map((ref) => ref.deref()).filter(Boolean), left = alive.filter((node) => !kept.includes(node));
			const holding = left.filter((node) => node.image_data || node.selection_image_data || node.parent || node.futures.length);
			return { watched: window.__watched.length, kept: kept.length, kept_with_copies: kept.filter((node) => node.image_data).length, bytes: fn.history_bytes(), left_alive: left.length, left_holding: holding.length, left_holding_bytes: holding.reduce((sum, node) => sum + (node.image_data?.data.byteLength ?? 0) + (node.selection_image_data?.data.byteLength ?? 0), 0) };
		}).then((left) => ({ ...left, collections: chromium ? 3 : 0 }));
	};
	const paused_after = await auto_copy_step();
	await watched_steps(20);
	const trimmed = { paused_after, ...(await steps_left()) };
	check("with the Auto Copy panel open and auto copy paused after its own step, the steps the budget trims let go of their canvas copies and their links", /Auto Copy/.test(paused_after.at) && !paused_after.running && trimmed.watched === 21 && trimmed.kept === 5 && trimmed.kept_with_copies === 5 && trimmed.bytes === 5 * STEP && trimmed.left_holding === 0, JSON.stringify(trimmed));
	// The history starts over, as a DeathLink and a login into another game make it, with auto copy's paused step in it.
	const starts_over = await auto_copy_step();
	await watched_steps(3);
	await evaluate(async () => (await import("/src/functions.js")).reset_canvas_and_history());
	const restarted = { starts_over, ...(await steps_left()) };
	check("...and when the history starts over, every step of the old one lets go of them too", /Auto Copy/.test(starts_over.at) && restarted.watched === 4 && restarted.kept === 1 && restarted.left_holding === 0, JSON.stringify(restarted));
	await evaluate(() => document.querySelector(".auto-copy-panel .window-close-button")?.click());

	// With the budget full at 3 steps, New, a and b, and the page back on New, Redo leading to a: a step made from there
	// keeps the line Redo led to for that one step, and a jump to its last step brings the canvas back. The next step made
	// from New, Redo then leading to the step before it, takes the line.
	await fresh_history(3 * STEP);
	const line = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		const step = (name, x, color) => { try { fn.undoable({ name }, () => { main_ctx.fillStyle = color; main_ctx.fillRect(x, 10, 40, 40); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; } return current_history_node; };
		const names = () => __h.nodes().map((node) => node.name).sort();
		step("a", 10, "#101010");
		const b = step("b", 60, "#202020"), work = __h.canvas();
		fn.undo();
		fn.undo();
		const back = { at: current_history_node.name, redo_leads_to: redos[redos.length - 1]?.name ?? null, bytes: fn.history_bytes() };
		const c = step("c", 110, "#303030");
		const one = { kept: names(), bytes: fn.history_bytes() };
		fn.go_to_history_node(b);
		Object.assign(one, { jumped_to: current_history_node.name, canvas_back: __h.canvas() === work });
		fn.go_to_history_node(c);
		fn.undo();
		const again = { at: current_history_node.name, redo_leads_to: redos[redos.length - 1]?.name ?? null };
		step("d", 160, "#404040");
		return { back, one, again, two: { kept: names(), bytes: fn.history_bytes() } };
	});
	check("with the budget full, a step made from the history's first step keeps the line Redo led to for that one step, and a jump to its last step brings the canvas back; the next step made from there takes it", line.back.at === "New" && line.back.redo_leads_to === "a" && line.back.bytes === 3 * STEP && JSON.stringify(line.one.kept) === JSON.stringify(["New", "a", "b", "c"]) && line.one.bytes === 4 * STEP && line.one.jumped_to === "b" && line.one.canvas_back && line.again.at === "New" && line.again.redo_leads_to === "c" && JSON.stringify(line.two.kept) === JSON.stringify(["New", "c", "d"]) && line.two.bytes === 3 * STEP, JSON.stringify(line));

	// A second finger inside 500 ms of the first cancels the gesture and takes its step out of the history, Paint's quick
	// undo, which only Fill has a step for by then: Fill makes its step as the press begins. Here by its call: the step is
	// out of the history and out of Redo, Redo after it stays in the history, and 6 steps on the way to the current step
	// keeps no more than the budget of 3 steps.
	await fresh_history(3 * STEP);
	const discarded = await evaluate(async () => {
		const fn = await import("/src/functions.js");
		const step = (name, k) => { try { fn.undoable({ name }, () => { main_ctx.fillStyle = `rgb(${k * 9}, 20, 60)`; main_ctx.fillRect(20 + 45 * k, 50, 40, 40); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; } };
		const state = () => ({ at: current_history_node.name, in_history: __h.nodes().includes(current_history_node), redos: redos.map((node) => node.name) });
		step("a", 1);
		step("b", 2);
		history_node_to_cancel_to = current_history_node; // the first finger's press
		step("c", 3);
		const taken = current_history_node;
		fn.cancel(false, true); // the second finger
		const after_cancel = { ...state(), taken_listed: __h.nodes().includes(taken), cancel_point: history_node_to_cancel_to?.name ?? null };
		const after_redo = { moved: fn.redo(), ...state() };
		// Redo with nothing to redo says so in a box of its own, as does a step with no image data: each is closed.
		for (const box of [...document.querySelectorAll(".window")].filter((w) => /Redo|no image data/.test(w.textContent) && !w.classList.contains("history-window"))) box.querySelector("button")?.click();
		for (let k = 1; k <= 6; k++) step(`d${k}`, 3 + k);
		const way = [current_history_node, ...fn.get_history_ancestors(current_history_node)];
		return { after_cancel, after_redo, later: { ...state(), way_bytes: way.reduce((sum, node) => sum + (node.image_data?.data.byteLength ?? 0), 0), history_bytes: fn.history_bytes() } };
	});
	check("a cancel that takes a quick step out of the history takes it out of Redo too, Redo after it stays in the history, and 6 steps on the way keeps within the budget", discarded.after_cancel.at === "b" && !discarded.after_cancel.taken_listed && !discarded.after_cancel.redos.includes("c") && discarded.after_cancel.cancel_point === null && discarded.after_redo.in_history && discarded.after_redo.at === "b" && discarded.later.in_history && discarded.later.way_bytes <= 3 * STEP && discarded.later.history_bytes === discarded.later.way_bytes, JSON.stringify(discarded));

	// The same by touch, in Chromium, whose touch input the harness drives: the history full at 3 steps, New, a and b, and
	// the page back on New by Ctrl+Z, Redo leading to a. Two fingers under 500 ms apart with Fill make its step and take it
	// out again, and Redo then leads to a once more, so a Brush stroke from New keeps the line a, b listed for that step.
	// A second finger that comes 500 ms or more after the first rolls the fill back and keeps it: the touch is made again.
	const touch_name = "a quick two-finger touch with Fill takes its step out of the history and leaves Redo leading along the line it led to before the press, so a Brush stroke from the history's first step keeps that line for that one step";
	if (chromium) {
		const touch_once = async () => {
			await fresh_history(3 * STEP);
			await evaluate(async () => {
				const fn = await import("/src/functions.js");
				for (const [name, x, color] of [["a", 300, "#405060"], ["b", 360, "#506070"]]) {
					try { fn.undoable({ name }, () => { main_ctx.fillStyle = color; main_ctx.fillRect(x, 300, 40, 40); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
				}
				window.__line = __h.nodes().filter((node) => node !== root_history_node);
				window.__work = __h.canvas();
				window.__downs = [];
				window.__note_down ??= (event) => window.__downs.push({ type: event.pointerType, at: performance.now() });
				addEventListener("pointerdown", window.__note_down, true);
			});
			await focus_page();
			await keyboard.press("z", ["Control"]);
			await keyboard.press("z", ["Control"]);
			const at = await point_on("canvas", 400, 400), beside = await point_on("canvas", 500, 420);
			// What each finger lands on, and the windows that show.
			const looked = await evaluate(async (points) => {
				(await import("/src/functions.js")).select_tool(get_tool_by_id("TOOL_FILL"));
				window.__downs = [];
				const under = points.map(({ x, y }) => document.elementFromPoint(x, y) === main_canvas);
				const windows = [...document.querySelectorAll(".window")].filter((w) => w.offsetParent !== null).map((w) => w.querySelector(".window-title")?.textContent.trim() ?? "?");
				return { at: current_history_node.name, redo_leads_to: redos[redos.length - 1]?.name ?? null, canvas: __h.canvas(), on_canvas: under, windows };
			}, [at, beside]);
			await page("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y, id: 1 }] });
			await sleep(120);
			const filled = await evaluate(() => { window.__fill = current_history_node; return current_history_node.name; });
			await page("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y, id: 1 }, { x: beside.x, y: beside.y, id: 2 }] });
			await sleep(100);
			await page("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await sleep(200);
			const touched = await evaluate((before) => ({ at: current_history_node.name, fill_listed: __h.nodes().includes(window.__fill), redo_leads_to: redos[redos.length - 1]?.name ?? null, same_canvas: __h.canvas() === before, downs: window.__downs.map((down) => down.type).join(), gap: window.__downs.length >= 2 ? Math.round(window.__downs[1].at - window.__downs[0].at) : null }), looked.canvas);
			return { looked: { at: looked.at, redo_leads_to: looked.redo_leads_to, on_canvas: looked.on_canvas, windows: looked.windows }, filled, touched };
		};
		let touch = await touch_once();
		if (!(touch.touched.gap < 500)) touch = { first_gap: touch.touched.gap, ...(await touch_once()) };
		await evaluate(async () => (await import("/src/functions.js")).select_tool(get_tool_by_id("TOOL_BRUSH")));
		const from = await point_on("canvas", 100, 450), to = await point_on("canvas", 260, 470);
		await mouse.move(from.x, from.y);
		await mouse.down();
		await mouse.move(to.x, to.y, 4);
		await mouse.up();
		await sleep(250);
		const stroked = await evaluate(async () => {
			const kept = __h.nodes(), b = window.__line.find((node) => node.name === "b"), out = { at: current_history_node.name, kept: kept.map((node) => node.name).sort(), line_listed: window.__line.filter((node) => kept.includes(node) && node.image_data).length };
			if (kept.includes(b)) {
				(await import("/src/functions.js")).go_to_history_node(b);
				Object.assign(out, { jumped_to: current_history_node.name, canvas_back: __h.canvas() === window.__work });
			}
			return out;
		});
		check(touch_name, touch.looked.at === "New" && touch.looked.redo_leads_to === "a" && touch.looked.on_canvas.every(Boolean) && touch.touched.downs === "touch,touch" && touch.touched.gap < 500 && touch.filled === "Fill With Color" && !touch.touched.fill_listed && touch.touched.at === "New" && touch.touched.same_canvas && touch.touched.redo_leads_to === "a" && stroked.kept.length === 4 && stroked.line_listed === 2 && stroked.jumped_to === "b" && stroked.canvas_back, JSON.stringify({ ...touch, stroked }));
	} else console.log(`SKIP  ${touch_name}  (Chromium only: the harness drives touch input through the DevTools Protocol)`);

	// 7. Two games logged into through Connect, on a stand-in server, each with a 700x500 goal: no goal of that size comes
	// with the page, so the goal canvas stays as the login leaves it, blank, until the test draws one.
	const config = (seed) => ({
		seed,
		items: ["Magnifier", "Brush", "Progressive Canvas Width", "Progressive Canvas Width", "Progressive Canvas Height"].map((name, i) => ({ item: id_of(name), location: 2199000 + 9000 + i, player: 1, flags: 1 })),
		late_item: { item: id_of("Progressive Canvas Width"), location: 2199000 + 9900, player: 1, flags: 1 },
		locations: LOCATIONS,
		slot_data: { ...CONTRACT.slot_data, final_width: 700, final_height: 500, version: "1.1.0" },
		package: { checksum: "items-py", item_name_to_id: ITEMS, location_name_to_id: {} },
	});
	const sent_since = (from) => evaluate((from) => __ap.log.slice(from).filter((p) => p.cmd === "LocationChecks").flatMap((p) => p.locations), from);
	// A stroke of white on the white canvas, which changes nothing but sends checks, as every step does.
	const white_stroke = () => evaluate(async () => {
		const fn = await import("/src/functions.js");
		fn.undoable({ name: "Brush" }, () => { main_ctx.fillStyle = "#ffffff"; main_ctx.fillRect(100, 60, 2, 2); });
	});
	await add_init_script(fake_server(config("HISTORY-A")));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	// Matched Pixels judge each pixel of the 205x105 canvas, white, against the goal pixel under it, from the goal as read
	// whole: on a black goal, 10 white pixels in row 50 are the only match.
	const before_matched = await evaluate(() => {
		const sent = __ap.log.length;
		goal_ctx.fillStyle = "#000000";
		goal_ctx.fillRect(0, 0, goal_canvas.width, goal_canvas.height);
		goal_ctx.fillStyle = "#ffffff";
		goal_ctx.fillRect(0, 50, 10, 1);
		$G.triggerHandler("save-goal");
		return sent;
	});
	await white_stroke();
	await sleep(300);
	const matched_ids = (await sent_since(before_matched)).filter((id) => id > 2198950 && id <= 2198975);
	check("Matched Pixels judge each canvas pixel against the goal pixel under it, as wide as the goal", matched_ids.length === 10 && matched_ids.every((id, k) => id === 2198951 + k), JSON.stringify({ canvas: await evaluate(() => `${main_canvas.width}x${main_canvas.height}`), matched: matched_ids }));
	// A login starts the goal canvas over, so the goal as last read goes with it. Game A's goal is made all white, and a
	// stroke sends what that earns. Game B's goal is the same size and its canvas is white too, so a stroke there scored
	// against A's goal would send checks B's canvas hasn't earned.
	await evaluate(() => { goal_ctx.fillStyle = "#ffffff"; goal_ctx.fillRect(0, 0, goal_canvas.width, goal_canvas.height); $G.triggerHandler("save-goal"); });
	await white_stroke();
	await sleep(300);
	const in_a = (await sent_since(0)).filter((id) => id > 2199000).length;
	// The status bar's similarity, beside the old loop's score of the canvas on fresh reads, and the rescores so far.
	const shown_and_scored = () => evaluate(async () => {
		const ap = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		const { reference_similarity } = await import("/test/paint-hard/scoring-reference.mjs");
		const { width, height } = main_canvas;
		const shown = $status_similarity.text().split("/")[0], rescores = fn.rescore_count();
		const reference = reference_similarity(main_ctx.getImageData(0, 0, width, height).data, width, height, goal_ctx.getImageData(0, 0, ap.final_width, ap.final_height).data, ap.final_width, ap.final_height, false, false).similarity;
		return { canvas: `${width}x${height}`, shown, reference: `${reference.toFixed(4)}%`, rescores };
	});
	const scored_in_a = await shown_and_scored();
	const before_b = await evaluate((b) => { const sent = __ap.log.length; __ap.use(b); __ap.drop(); return sent; }, config("HISTORY-B"));
	for (let i = 0; i < 30 && !(await window_shown()); i++) await sleep(100);
	await connect();
	// The login rescores though the canvas has the size last scored, and no goal load follows it to rescore in its place.
	const scored_in_b = await shown_and_scored();
	check("a login rescores though the canvas has the size last scored: the status bar shows this game's score, which differs from the last game's", scored_in_a.shown === scored_in_a.reference && scored_in_a.canvas === scored_in_b.canvas && scored_in_b.rescores > scored_in_a.rescores && scored_in_b.shown === scored_in_b.reference && scored_in_b.shown !== scored_in_a.shown, JSON.stringify({ in_a: scored_in_a, in_b: scored_in_b }));
	await white_stroke();
	await sleep(300);
	// What B's canvas earns, scored by the old loop on reads of the canvas and the goal canvas as they are now.
	const in_b = await evaluate(async (before) => {
		const ap = await import("/src/archipelago.js");
		const { reference_similarity } = await import("/test/paint-hard/scoring-reference.mjs");
		const { width, height } = main_canvas;
		const similarity = reference_similarity(main_ctx.getImageData(0, 0, width, height).data, width, height, goal_ctx.getImageData(0, 0, ap.final_width, ap.final_height).data, ap.final_width, ap.final_height, false, false).similarity;
		const earned = Math.floor(similarity * 10000 + 1e-7);
		const units = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90];
		const sent = __ap.log.slice(before).filter((p) => p.cmd === "LocationChecks").flatMap((p) => p.locations);
		const sent_units = sent.map((id) => (id > 2198900 && id <= 2198918 ? units[id - 2198901] : id > 2199000 ? (id - 2199000) * 100 : 0));
		return { canvas: `${main_canvas.width}x${main_canvas.height}`, similarity, earned, sent: sent.length, highest: Math.max(0, ...sent_units) };
	}, before_b);
	check("a login into another game with a goal of the same size sends no check from the last game's goal", in_a > 0 && in_b.highest <= Math.max(0, in_b.earned), JSON.stringify({ checks_in_a: in_a, in_b }));

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
