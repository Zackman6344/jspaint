// End-to-end test for Pain-T's built-in auto copy and M keys (ROADMAP Phase 3), with trusted mouse and keyboard input.
// It needs no packages: test/paint-hard/harness.mjs serves this client and drives Chrome through the DevTools Protocol,
// and the test stands in for an Archipelago game with fake_session() from src/archipelago.js (slot data and the items
// to count as received); real-client.e2e.mjs covers the real client. It draws a known goal, as the Copy Goal test it was
// ported from did.
// Usage: node test/paint-hard/auto-copy.e2e.mjs [--headful]. Set BROWSER_PATH if Chrome isn't in its default folder.
import { add_init_script, call, check, evaluate, finish, keyboard, mouse, open_paint, overclock_id, overclock_stored, page_errors, point_on, remove_init_script, same, sleep } from "./harness.mjs";

// --- The game, stood in for ---
const FULL_COLOR = [];
for (const channel of ["Red", "Green", "Blue"]) for (let k = 0; k < 254; k++) FULL_COLOR.push(`Progressive Color Depth (${channel})`);
const speed_items = (n) => Array(n).fill("Progressive Auto Copy Speed");
// Phase 4's items (D7): with every accuracy copy auto copy and M never miss, and Auto Copy Loop runs pass after pass
// until the canvas is done, as these checks expect. misses.e2e.mjs tests misses, the margin and passes.
const SURE = [...Array(9).fill("Progressive Auto Copy Accuracy"), "Auto Copy Loop"];
const SLOT_DATA = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 2, miss_margin_step: 1, version: "1.0.0", trap_blacklist: [] };
// Sets the received items. Canvas items aren't used: the test sizes the canvas itself, as a partly unlocked game.
// SLOT_DATA has no ladders flag, so both views and Pick Color work as upstream's do; no real seed pairs that with speed
// items, and section 17 tests a real Phase 2 seed's slot data.
const receive = (items, slot_data = SLOT_DATA) => evaluate(async (slot_data, items) => {
	const { fake_session } = await import("/src/archipelago.js");
	const { resize_canvas_without_saving_dimensions } = await import("/src/functions.js");
	const width = main_canvas.width, height = main_canvas.height;
	fake_session(slot_data, ["Magnifier", "Brush", ...items]);
	resize_canvas_without_saving_dimensions(width, height);
}, slot_data, [...items, ...SURE]);

try {
	await open_paint(() => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy);
	await evaluate(() => {
		localStorage.removeItem("pain-t-auto-copy-tier");
		for (const key of Object.keys(localStorage)) if (key.startsWith("pain-t-overclock-")) localStorage.removeItem(key);
	});
	await evaluate(async (slot_data, items) => {
		const { fake_session } = await import("/src/archipelago.js");
		const functions = await import("/src/functions.js");
		fake_session(slot_data, ["Magnifier", "Brush", ...items]);
		const { width, height } = goal_canvas;
		const image = goal_ctx.createImageData(width, height); // a goal with lots of different colors
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * width + x) * 4);
		goal_ctx.putImageData(image, 0, 0);
		$G.triggerHandler("save-goal"); // as a goal the page draws does, so the page reads it again (task 7.3)
		functions.set_magnification(1);
	}, SLOT_DATA, [...FULL_COLOR, ...speed_items(10), ...SURE]);
	await sleep(300);

	const canvas_px = (x, y) => evaluate((x, y) => Array.from(main_ctx.getImageData(x, y, 1, 1).data), x, y);
	// What Pick Color would give for goal pixel (x, y): the goal color rounded by the game's own legalizeColor.
	const expected = (x, y) => evaluate(async (x, y) => {
		const { legalizeColor } = await import("/src/$ColorBox.js");
		const [r, g, b, a] = goal_ctx.getImageData(x, y, 1, 1).data;
		return legalizeColor(`rgba(${r},${g},${b},${a / 255})`).match(/\d+/g).map(Number).concat(255);
	}, x, y);
	const undo_count = () => evaluate(() => undos.length);
	// The running total and a full rescore, read back to back: an await between them would let an auto copy tick in.
	const running_and_full = () => evaluate(async () => {
		const { calculate_similarity } = await import("/src/functions.js");
		return { running: window.paint_hard_auto_copy.similarity(), full: calculate_similarity() };
	});
	const status = () => evaluate(() => $status_text.text());
	const hover = async (which, x, y) => { const p = await point_on(which, x, y); await mouse.move(p.x, p.y); await sleep(30); return p; };
	const focus_page = async () => { await mouse.click(5, 895); await sleep(100); };
	const WHITE = [255, 255, 255, 255];
	console.log(`goal ${await evaluate(() => goal_canvas.width + "x" + goal_canvas.height)}`);
	await focus_page();

	// 1. M copies without Pick Color (D5): the goal color, rounded like Pick Color, lands in the same canvas pixel.
	check("Pick Color isn't held", !(await evaluate(async () => (await import("/src/archipelago.js")).received().includes("Pick Color"))));
	let before = await undo_count();
	await hover("goal", 100, 50);
	await keyboard.press("m");
	check("M on the goal copies into the same canvas pixel", same(await canvas_px(100, 50), await expected(100, 50)), `${JSON.stringify(await canvas_px(100, 50))} vs ${JSON.stringify(await expected(100, 50))}`);
	check("...as one undo step", (await undo_count()) === before + 1, `${before} -> ${await undo_count()}`);
	check("...and reports it", (await status()) === "Copied 100,50 from the goal.", await status());
	before = await undo_count();
	await keyboard.press("m");
	check("M again adds no undo step", (await undo_count()) === before && (await status()) === "Already matches the goal.", await status());

	// 2. Point at the canvas: same thing, pulled from the goal. Ctrl+Z undoes it.
	await hover("canvas", 120, 60);
	await keyboard.press("m");
	check("M on the canvas pulls from the goal", same(await canvas_px(120, 60), await expected(120, 60)), JSON.stringify(await canvas_px(120, 60)));
	await keyboard.press("z", ["Control"]);
	check("Ctrl+Z undoes it", same(await canvas_px(120, 60), WHITE), JSON.stringify(await canvas_px(120, 60)));

	// 3. Hold M and sweep at 1,024 pixels a second: every pixel passed over, one undo step.
	const sweep_row = async (row) => {
		const a = await point_on("goal", 10, row), b = await point_on("goal", 300, row);
		await mouse.move(a.x, a.y);
		await keyboard.down("m");
		await mouse.move(b.x, b.y, 6); // about 48 pixels between moves: the gaps must be filled
		await sleep(700);
		await keyboard.up("m");
		await sleep(1200); // letting go finishes the pixels in line, up to a second of them
		return evaluate(async (row) => {
			const { legalizeColor } = await import("/src/$ColorBox.js");
			let matched = 0, changed_from_white = 0;
			for (let x = 10; x <= 300; x++) {
				const [r, g, b, a] = goal_ctx.getImageData(x, row, 1, 1).data;
				const want = legalizeColor(`rgba(${r},${g},${b},${a / 255})`).match(/\d+/g).map(Number).concat(255);
				const got = main_ctx.getImageData(x, row, 1, 1).data;
				if (want.every((v, i) => v === got[i])) matched++;
				if (!(want[0] === 255 && want[1] === 255 && want[2] === 255)) changed_from_white++;
			}
			return { matched, changed_from_white };
		}, row);
	};
	before = await undo_count();
	const fast = await sweep_row(200);
	const fast_status = await status();
	check("hold M at 1,024 a second copies every pixel passed over", fast.matched === 291, `${fast.matched}/291`);
	check("...as one undo step", (await undo_count()) === before + 1, `${before} -> ${await undo_count()}`);
	check("...and counts what changed", fast_status === `Copied ${fast.changed_from_white} pixels from the goal.`, fast_status);
	const shown = await evaluate(() => $status_similarity.text());
	const now_similarity = await evaluate(async () => (await import("/src/functions.js")).calculate_similarity().toFixed(4));
	check("...and the similarity (what sends checks) was recalculated", shown.startsWith(now_similarity + "%"), `${shown} vs ${now_similarity}`);
	// One fast move with M held at 1,024 a second over 600 pixels that already match, in colors Paint hasn't parsed yet:
	// M looks each up in the rounding tables and makes no step, so no long task. Each used to parse a new color string.
	// At full color depth the goal's own colors match, so the row is put in straight from the goal.
	await evaluate(() => {
		main_ctx.putImageData(goal_ctx.getImageData(0, 130, 600, 1), 0, 130);
		window.flick_long_tasks = [];
		try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.flick_long_tasks.push(Math.round(entry.duration)); }).observe({ type: "longtask" }); } catch { }
	});
	const flick_undos = await undo_count();
	const flick_from = await point_on("canvas", 0, 130), flick_to = await point_on("canvas", 599, 130); // the whole row shows on the canvas
	await mouse.move(flick_from.x, flick_from.y);
	await keyboard.down("m");
	await mouse.move(flick_to.x, flick_to.y);
	await sleep(1000);
	await keyboard.up("m");
	await sleep(500);
	const flick = { long_tasks: await evaluate(() => window.flick_long_tasks), status: await status(), undos: (await undo_count()) - flick_undos };
	check("a fast flick with M over 600 matching pixels leaves no long task", flick.long_tasks.length === 0 && flick.status === "Already matches the goal." && flick.undos === 0, JSON.stringify(flick));

	// 4. Goal pixels past the unlocked canvas are refused; a fast flick onto the canvas misses nothing.
	before = await undo_count();
	await hover("goal", 100, 500);
	await keyboard.press("m");
	check("a goal pixel past the canvas edge is refused", (await undo_count()) === before && /past the edge of your canvas \(600x450\)/.test(await status()), await status());
	const off = await point_on("canvas", 0, 300), onto = await point_on("canvas", 40, 300);
	await mouse.move(off.x - 15, off.y);
	await keyboard.down("m");
	await mouse.move(onto.x, onto.y);
	await sleep(150);
	await keyboard.up("m");
	await sleep(200);
	let edge = 0;
	for (let x = 0; x <= 40; x++) if (same(await canvas_px(x, 300), await expected(x, 300))) edge++;
	check("a flick onto the canvas copies from the very edge", edge === 41, `${edge}/41`);

	// Clicks Extras > <item>, then makes sure the menu is closed.
	const extras_item = async (pattern) => {
		const extras = await evaluate(() => { const r = [...document.querySelectorAll(".menu-button")].find((el) => /extras/i.test(el.textContent)).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
		await mouse.click(extras.x, extras.y);
		await sleep(250);
		const item = await evaluate((source) => { const el = [...document.querySelectorAll(".menu-item")].find((el) => new RegExp(source, "i").test(el.textContent) && el.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, pattern.source);
		if (item) await mouse.click(item.x, item.y);
		await sleep(250);
		if (await evaluate(() => !!document.querySelector(".menu-button.active"))) { await keyboard.press("Escape"); }
		return !!item;
	};
	const panel_text = () => evaluate(() => { const p = document.querySelector(".auto-copy-panel"); return p && p.offsetParent !== null ? p.querySelector(".window-content").innerText.replace(/\s+/g, " ").trim() : null; });
	const speed_button = async (title, times = 1) => {
		for (let i = 0; i < times; i++) {
			const p = await evaluate((title) => { const b = document.querySelector(`.auto-copy-panel button[title=${title}]`); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled }; }, title);
			await mouse.click(p.x, p.y);
			await sleep(100);
		}
	};
	const panel_button = async (selector) => {
		const p = await evaluate((selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
		await mouse.click(p.x, p.y);
		await sleep(150);
	};

	// 5. Extras > Auto Copy opens the panel without starting; the speed tiers come from items (D5).
	check("Extras has Auto Copy", await extras_item(/^Auto Copy/));
	check("...which opens the panel, ready and at the top speed", /^Ready\. .*1,024 pixels a second The top speed\./.test(await panel_text() || ""), await panel_text());
	await speed_button("Slower", 10);
	check("- goes down to 1 pixel a second", /1 pixel a second Your top speed is 1,024 a second\./.test(await panel_text() || "") && await evaluate(() => document.querySelector(".auto-copy-panel button[title=Slower]").disabled), await panel_text());

	// 6. M shares the allowance (D6): at 1 pixel a second a fast sweep copies a pixel or two and says why. What changed is
	// counted over the whole canvas, so a sweep that lands on another row can't pass for one that copied nothing.
	await focus_page();
	before = await undo_count();
	await evaluate(() => { window.canvas_before = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data; });
	await sweep_row(220);
	const slow_status = await status();
	const slow_changed = await evaluate(() => {
		const now = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data, was = window.canvas_before, found = [];
		for (let i = 0; i < now.length; i += 4) if (now[i] !== was[i] || now[i + 1] !== was[i + 1] || now[i + 2] !== was[i + 2] || now[i + 3] !== was[i + 3]) found.push(`${(i / 4) % main_canvas.width},${Math.floor(i / 4 / main_canvas.width)}`);
		return found;
	});
	const slow_said = /^Copied \d+,\d+ from/.test(slow_status) ? 1 : Number((slow_status.match(/^Copied ([\d,]+) pixels/)?.[1] ?? "0").replace(/,/g, ""));
	check("hold M at 1 a second copies a couple of pixels", slow_changed.length >= 1 && slow_changed.length <= 3 && slow_said === slow_changed.length, `${slow_changed.length} changed (${slow_changed.join(" ")}); the status says ${slow_said}`);
	check("...on the row swept", slow_changed.every((p) => p.endsWith(",220")), slow_changed.join(" "));
	check("...and says the rest were left", /M copies 1 pixel a second at your speed, so [\d,]+ passed over were left\./.test(slow_status), slow_status);
	await speed_button("Faster", 5); // 32 a second
	check("+ climbs back to 32 a second", /32 pixels a second/.test(await panel_text() || ""), await panel_text());

	// 7. Auto copy (Shift+M): its own speed, in scan order, one undo step a minute, the running total (D9).
	await call("clear");
	await focus_page();
	const painted = (rows = 1e9) => evaluate((rows) => {
		const w = main_canvas.width, h = Math.min(main_canvas.height, rows);
		const d = main_ctx.getImageData(0, 0, w, h).data;
		let n = 0, max_y = -1;
		for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) { n++; max_y = Math.floor(i / 4 / w); }
		return { n, max_y };
	}, rows);
	const undos_before_auto = await undo_count();
	await keyboard.press("m", ["Shift"]);
	await sleep(400);
	check("Shift+M starts auto copy", /^Copying\. [\d,]+ pixels left/.test(await panel_text() || ""), await panel_text());
	await evaluate(() => { window.history_updates = 0; $G.on("history-update.autocopytest", () => window.history_updates++); });
	const t0 = await painted(); let start = Date.now();
	await sleep(3000);
	const t1 = await painted(); let seconds = (Date.now() - start) / 1000;
	let rate = (t1.n - t0.n) / seconds;
	check("auto copy keeps to the speed (32 a second)", rate > 27 && rate <= 34, `${t1.n - t0.n} pixels in ${seconds.toFixed(2)} s = ${rate.toFixed(1)}/s`);
	check("...in scan order, top row first", t1.max_y === 0, `lowest painted row ${t1.max_y}`);
	check("...without rebuilding the History window every tick", (await evaluate(() => window.history_updates)) <= 1, `${await evaluate(() => window.history_updates)} History updates in 3 s`);
	check("...as one undo step", (await undo_count()) === undos_before_auto + 1, `${undos_before_auto} -> ${await undo_count()}`);
	const totals = await running_and_full();
	check("...and its running similarity matches a full rescore", totals.running !== null && Math.abs(totals.running - totals.full) < 1e-9, JSON.stringify(totals));
	const shown_running = await evaluate(() => $status_similarity.text());
	// The bar shows the total from the last send, up to a second and 32 pixels ago: within 0.02 points.
	check("...and the status bar shows it", Math.abs(parseFloat(shown_running) - totals.full) < 0.02, `${shown_running} vs ${totals.full.toFixed(4)}`);

	// 8. Overclock (D10): two banked at 2 s each double the speed for 4 s, then it drops back.
	await receive([...FULL_COLOR, ...speed_items(10), "Overclock", "Overclock"]);
	await sleep(200);
	const o0 = await painted(); start = Date.now();
	await sleep(2000);
	const o1 = await painted(); seconds = (Date.now() - start) / 1000;
	const overclocked = (o1.n - o0.n) / seconds;
	await sleep(3000);
	const o2 = await painted(); start = Date.now();
	await sleep(2000);
	const o3 = await painted(); seconds = (Date.now() - start) / 1000;
	const after = (o3.n - o2.n) / seconds;
	check("Overclock doubles auto copy's speed", overclocked > 55 && overclocked <= 68, `${overclocked.toFixed(1)}/s`);
	check("...until the banked seconds run out", after > 27 && after <= 34 && (await evaluate(() => window.paint_hard_auto_copy.overclock_banked())) === 0, `${after.toFixed(1)}/s, ${await evaluate(() => window.paint_hard_auto_copy.overclock_banked())} s left`);
	// Within what filler_banked() counts as nothing left: adding up the fractions has ended about 1e-15 s short.
	const kept_spent = (await overclock_stored()).spent;
	check("...and the spent seconds are kept", kept_spent >= 4 - 1e-6, String(kept_spent));
	// A late tick, as in a throttled background tab, gets double speed only for the seconds still banked: a third
	// Overclock banks 2 s, and the page stalls for 5 s, so about 32 x 5 + 32 x 2 pixels, not 64 x 5.
	await receive([...FULL_COLOR, ...speed_items(10), "Overclock", "Overclock", "Overclock"]);
	await sleep(100);
	const l0 = await painted();
	await evaluate(() => { const until = performance.now() + 5000; while (performance.now() < until); });
	await sleep(400);
	const late = (await painted()).n - l0.n;
	check("...and a late tick doubles only the seconds banked", late > 190 && late < 285, `${late} pixels over a 5 s stall with 2 s banked; about 240 due, 340 if the whole tick doubled`);

	// 9. A new speed item raises the top; pausing brings the undo step and similarity up to date.
	await keyboard.press("m", ["Shift"]); // pause
	const paused_shown = await evaluate(() => $status_similarity.text());
	const paused_full = await evaluate(async () => (await import("/src/functions.js")).calculate_similarity().toFixed(4));
	check("pausing sends an up-to-date similarity", paused_shown.startsWith(paused_full + "%"), `${paused_shown} vs ${paused_full}`);
	const snapshot_diff = await evaluate(() => {
		const a = current_history_node.image_data.data, b = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
		let n = a.length === b.length ? 0 : -1;
		for (let i = 0; n >= 0 && i < a.length; i++) if (a[i] !== b[i]) n++;
		return n;
	});
	check("...and brings its undo step up to date", snapshot_diff === 0, `${snapshot_diff} bytes differ`);
	await receive([...FULL_COLOR, ...speed_items(3), "Overclock", "Overclock"]);
	await sleep(2200); // the panel refreshes every 2 s while stopped
	check("with 3 speed items the top is 8 a second", /8 pixels a second Your top speed\. Each Progressive Auto Copy Speed doubles it\./.test(await panel_text() || ""), await panel_text());
	await receive([...FULL_COLOR, ...speed_items(4), "Overclock", "Overclock"]);
	await sleep(2200);
	check("...and a fourth raises it to 16, since 32 was picked", /16 pixels a second/.test(await panel_text() || ""), await panel_text());
	await receive([...FULL_COLOR, ...speed_items(10), "Overclock", "Overclock"]);
	await sleep(2200);
	check("...and with all 10 back it returns to the 32 picked", /32 pixels a second/.test(await panel_text() || ""), await panel_text());
	await focus_page();
	await keyboard.press("m", ["Shift"]); // resume

	// 10. Holding M while it runs: auto copy waits, then carries on with one new step.
	const undos_before_hold = await undo_count();
	const hold_from = await point_on("goal", 50, 250), hold_to = await point_on("goal", 150, 250);
	await mouse.move(hold_from.x, hold_from.y);
	await keyboard.down("m");
	await mouse.move(hold_to.x, hold_to.y, 10);
	await sleep(600);
	const hold_text = await panel_text();
	const undos_during_hold = await undo_count();
	await keyboard.up("m");
	check("holding M makes auto copy wait", /Waiting while you hold M/.test(hold_text || "") && undos_during_hold === undos_before_hold + 1, `${undos_before_hold} -> ${undos_during_hold}, ${hold_text}`);
	await sleep(4500); // it holds off 3 s after any change it didn't make
	check("...then it carries on, with one new step", /^Copying\./.test(await panel_text() || "") && (await undo_count()) === undos_before_hold + 2, `${undos_before_hold} -> ${await undo_count()}, ${await panel_text()}`);
	const resynced = await running_and_full();
	check("...and its running total took the M pixels in", resynced.running !== null && Math.abs(resynced.running - resynced.full) < 1e-9, JSON.stringify(resynced));

	// 11. It waits while you draw; Ctrl+Z after a stroke undoes the stroke; it waits while disconnected.
	const hold_at = await point_on("canvas", 300, 300);
	await mouse.move(hold_at.x, hold_at.y);
	await mouse.down();
	await sleep(300);
	const w0 = await painted(10); await sleep(1500); const w1 = await painted(10);
	const waiting_text = await panel_text();
	await mouse.up();
	check("it waits while you draw", w1.n === w0.n && /Waiting while you draw/.test(waiting_text || ""), `${w0.n} -> ${w1.n}, ${waiting_text}`);
	await sleep(150);
	const stroke_pixel = await canvas_px(300, 300);
	await keyboard.press("z", ["Control"]);
	check("Ctrl+Z after a stroke undoes the stroke, not auto copy", !same(stroke_pixel, WHITE) && same(await canvas_px(300, 300), WHITE), `${JSON.stringify(stroke_pixel)} -> ${JSON.stringify(await canvas_px(300, 300))}`);
	check("...while auto copy holds off a moment", /Waiting a moment after your change/.test(await panel_text() || ""), await panel_text());
	await sleep(3500);
	check("...and carries on after", /^Copying\./.test(await panel_text() || ""), await panel_text());
	const set_connection_window = (shown) => evaluate((shown) => { for (const w of document.querySelectorAll(".window")) if (/Archipelago Connection Options/.test(w.textContent)) w.style.display = shown ? "" : "none"; }, shown);
	await set_connection_window(true);
	await sleep(300);
	const d0 = await painted(10); await sleep(1000); const d1 = await painted(10);
	const disconnected_text = await panel_text();
	await set_connection_window(false);
	await sleep(300);
	check("it waits while disconnected", d1.n === d0.n && /Waiting for the connection/.test(disconnected_text || ""), `${d0.n} -> ${d1.n}, ${disconnected_text}`);
	// Esc mid-stroke rolls the canvas back to the step the stroke started on, auto copy's own, without a new step.
	await sleep(1500); // copying again
	const esc_at = await point_on("canvas", 400, 400);
	await mouse.move(esc_at.x, esc_at.y);
	await mouse.down();
	await mouse.move(esc_at.x + 30, esc_at.y, 5);
	await keyboard.press("Escape");
	await mouse.up();
	await sleep(300);
	check("Esc mid-stroke makes auto copy hold off too", /Waiting a moment after your change/.test(await panel_text() || ""), await panel_text());
	await sleep(3500);
	const esc_totals = await running_and_full();
	check("...and its running total takes the rollback in", esc_totals.running !== null && Math.abs(esc_totals.running - esc_totals.full) < 1e-9, JSON.stringify(esc_totals));

	// 12. A small canvas finishes, the speed is remembered, and "Done" goes away when something undoes the work.
	await call("resize_canvas_without_saving_dimensions", 30, 20);
	await speed_button("Faster", 5); // the top, 1,024
	for (let i = 0; i < 100 && !/^Done/.test(await panel_text() || ""); i++) await sleep(150);
	const wrong = await evaluate(async () => {
		const { legalizeColor } = await import("/src/$ColorBox.js");
		let wrong = 0;
		for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) {
			const [r, g, b, a] = goal_ctx.getImageData(x, y, 1, 1).data;
			const want = legalizeColor(`rgba(${r},${g},${b},${a / 255})`).match(/\d+/g).map(Number);
			const got = main_ctx.getImageData(x, y, 1, 1).data;
			if (want[0] !== got[0] || want[1] !== got[1] || want[2] !== got[2] || got[3] !== 255) wrong++;
		}
		return wrong;
	});
	check("a 30x20 canvas gets finished", wrong === 0, `${wrong} of 600 pixels wrong`);
	check("...and the panel says done", /^Done: your canvas matches the goal\./.test(await panel_text() || ""), await panel_text());
	check("the top speed is remembered as the top", (await evaluate(() => localStorage.getItem("pain-t-auto-copy-tier"))) === "99", await evaluate(() => localStorage.getItem("pain-t-auto-copy-tier")));
	// The next check is about Auto Copy Loop's restart, which a seed from before Phase 4 doesn't have. SURE carries no
	// margin copy, so the stand-in's margin is 255 only while its slot data names miss_margin_step.
	const phase4 = await evaluate(() => ({ margin: window.paint_hard_auto_copy.miss_margin(), loop: window.paint_hard_auto_copy.loop() }));
	check("the stand-in plays as a Phase 4 seed: its margin is 255, with Loop on", phase4.margin === 255 && phase4.loop, JSON.stringify(phase4));
	await call("clear");
	await sleep(2500);
	check('"Done" goes away when something undoes the work', /^Ready\. [\d,]+ pixels left/.test(await panel_text() || ""), await panel_text());

	// 13. With blurred canvas reads (Brave, Firefox strict mode) it still finishes. The blur starts after the page loaded,
	// so the page finds it when a pixel auto copy wrote reads back a step off (D7).
	const noise_before = await evaluate(() => window.paint_hard_auto_copy.read_noise());
	await evaluate(() => {
		const original = CanvasRenderingContext2D.prototype.getImageData;
		window.original_get_image_data = original;
		CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh, ...rest) {
			const image = original.call(this, sx, sy, sw, sh, ...rest);
			if (this.canvas === main_canvas) for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if ((sx + x + sy + y) % 3 === 0) image.data[(y * sw + x) * 4] ^= 1;
			return image;
		};
	});
	await focus_page();
	await keyboard.press("m", ["Shift"]);
	for (let i = 0; i < 100 && !/^Done/.test(await panel_text() || ""); i++) await sleep(150);
	check("with blurred canvas reads it still finishes", /^Done: your canvas matches the goal\./.test(await panel_text() || ""), await panel_text());
	const noise_after = await evaluate(() => window.paint_hard_auto_copy.read_noise());
	check("...having found the blur when a pixel it wrote read back a step off", noise_before === null && noise_after === "read-back", `${noise_before} before, ${noise_after} after`);
	await evaluate(() => { CanvasRenderingContext2D.prototype.getImageData = window.original_get_image_data; });

	// 14. Closing the panel stops auto copy.
	await call("resize_canvas_without_saving_dimensions", 600, 450);
	await panel_button(".auto-copy-panel .window-content > button"); // Start
	await sleep(700);
	await panel_button(".auto-copy-panel .window-close-button");
	await sleep(200);
	const c0 = await painted(); await sleep(1200); const c1 = await painted();
	check("closing the panel stops auto copy", c1.n === c0.n && (await panel_text()) === null, `${c0.n} -> ${c1.n}`);

	// 15. The ladders (D23), in a seed that has them: the views and Pick Color wait for their first copy, and the second
	// Progressive Similarity Mode lets M copy alongside auto copy.
	const LADDER_SLOT = { ...SLOT_DATA, ladders: true };
	const views = () => evaluate(() => ({ diff: $diff.is(":visible"), sim: $sim.is(":visible"), pick: !document.getElementById("TOOL_PICK_COLOR").classList.contains("disabled") }));
	await receive([...FULL_COLOR, ...speed_items(10)], LADDER_SLOT);
	await focus_page();
	await keyboard.press("m", ["Control"]);
	await keyboard.press("m", ["Control", "Shift"]);
	let seen = await views();
	check("in a ladder seed, Ctrl+M and Ctrl+Shift+M do nothing before the first copies", !seen.diff && !seen.sim, JSON.stringify(seen));
	check("...and Pick Color is still locked", !seen.pick, JSON.stringify(seen));
	await receive([...FULL_COLOR, ...speed_items(10), "Progressive Difference Mode", "Progressive Similarity Mode", "Progressive Pick Color"], LADDER_SLOT);
	await focus_page();
	await keyboard.press("m", ["Control"]);
	seen = await views();
	check("the first Progressive Difference Mode unlocks Ctrl+M", seen.diff, JSON.stringify(seen));
	await keyboard.press("m", ["Control", "Shift"]);
	seen = await views();
	check("...the first Progressive Similarity Mode Ctrl+Shift+M", seen.sim && !seen.diff, JSON.stringify(seen));
	check("...and the first Progressive Pick Color the tool", seen.pick, JSON.stringify(seen));
	await keyboard.press("m", ["Control", "Shift"]); // back to the plain goal
	await call("resize_canvas_without_saving_dimensions", 600, 450);
	await call("clear");
	await receive([...FULL_COLOR, ...speed_items(5), "Progressive Difference Mode", "Progressive Similarity Mode", "Progressive Similarity Mode", "Progressive Pick Color"], LADDER_SLOT);
	await focus_page();
	await keyboard.press("m", ["Shift"]); // open and start, at 32 a second
	await sleep(800);
	check("the panel says M copies alongside", /M copies alongside auto copy/.test(await panel_text() || ""), await panel_text());
	const undos_before_together = await undo_count();
	const a0 = await painted(); start = Date.now();
	const along_from = await point_on("goal", 50, 300), along_to = await point_on("goal", 250, 300);
	await mouse.move(along_from.x, along_from.y);
	await keyboard.down("m");
	await mouse.move(along_to.x, along_to.y, 10);
	await sleep(1500);
	const together_text = await panel_text();
	await keyboard.up("m");
	await sleep(1200);
	const a1 = await painted(); seconds = (Date.now() - start) / 1000;
	const row_300 = await evaluate(() => { const d = main_ctx.getImageData(50, 300, 201, 1).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) n++; return n; });
	check("with the second copy, holding M doesn't make auto copy wait", /^Copying\./.test(together_text || ""), together_text);
	check("...M's pixels and auto copy's both land", row_300 >= 20 && (a1.n - a0.n) - row_300 >= 32 * seconds * 0.7, `${row_300} by M on row 300, ${a1.n - a0.n - row_300} by auto copy in ${seconds.toFixed(1)} s`);
	check("...in auto copy's own undo step", (await undo_count()) === undos_before_together, `${undos_before_together} -> ${await undo_count()}`);
	const together_totals = await running_and_full();
	check("...and the running total counts M's pixels", together_totals.running !== null && Math.abs(together_totals.running - together_totals.full) < 1e-9, JSON.stringify(together_totals));
	// A trap that lands just before M's pixels go into auto copy's step is still a change to hold off for and rescore.
	await mouse.move(along_from.x, along_from.y);
	await sleep(100);
	const trap_status = await evaluate(async () => {
		const { image_invert_colors } = await import("/src/functions.js");
		image_invert_colors(); // what the Invert Colors trap runs
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "m", code: "KeyM", bubbles: true }));
		return $status_text.text();
	});
	check("M copies right after a trap, into auto copy's step", /^Copied /.test(trap_status), trap_status);
	await sleep(300);
	check("...and auto copy still holds off for the trap", /Waiting a moment after your change/.test(await panel_text() || ""), await panel_text());
	await sleep(3500);
	const trap_totals = await running_and_full();
	check("...and its running total takes the trap in", trap_totals.running !== null && Math.abs(trap_totals.running - trap_totals.full) < 1e-9, JSON.stringify(trap_totals));
	await keyboard.press("m", ["Shift"]); // pause
	// Similarity Mode redraws while auto copy runs, not only on the minute's rescore.
	await call("clear");
	await focus_page();
	await keyboard.press("m", ["Control", "Shift"]); // Similarity Mode
	await evaluate(() => { window.view_before = sim_canvas.getContext("2d").getImageData(0, 0, main_canvas.width, main_canvas.height).data; });
	await keyboard.press("m", ["Shift"]); // resume
	const view_now = () => evaluate(() => {
		const w = main_canvas.width, h = main_canvas.height;
		const canvas = main_ctx.getImageData(0, 0, w, h).data, after = sim_canvas.getContext("2d").getImageData(0, 0, w, h).data, before = window.view_before;
		let painted = 0, redrawn = 0;
		for (let i = 0; i < canvas.length; i += 4) {
			if (canvas[i] === 255 && canvas[i + 1] === 255 && canvas[i + 2] === 255) continue;
			painted++;
			if (after[i] !== before[i] || after[i + 1] !== before[i + 1] || after[i + 2] !== before[i + 2]) redrawn++;
		}
		return { painted, redrawn };
	});
	// A shown view is redrawn from a full rescore, kept to about 2% of the time: every few seconds here. Without that it
	// waits for the minute's rescore.
	let view = null;
	const view_from = Date.now();
	for (let i = 0; i < 24; i++) {
		await sleep(500);
		view = await view_now();
		if (view.painted > 50 && view.redrawn >= view.painted / 3) break;
	}
	check("Similarity Mode redraws while auto copy runs", view.painted > 50 && view.redrawn >= view.painted / 3, `${JSON.stringify(view)} after ${((Date.now() - view_from) / 1000).toFixed(1)} s`);
	await keyboard.press("m", ["Shift"]); // pause
	await keyboard.press("m", ["Control", "Shift"]); // back to the goal

	// 16. Timing (task 3.5): 1,024 pixels a second on the full 800x600 canvas for 10 s, watching the page's frames.
	await receive([...FULL_COLOR, ...speed_items(10)]);
	await call("resize_canvas_without_saving_dimensions", 800, 600);
	await call("clear");
	await focus_page();
	await evaluate(() => {
		window.frame_gaps = [];
		window.long_tasks = [];
		let last = performance.now();
		const frame = (now) => { window.frame_gaps.push(now - last); last = now; if (window.timing_on) requestAnimationFrame(frame); };
		window.timing_on = true;
		requestAnimationFrame(frame);
		try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.long_tasks.push(Math.round(entry.duration)); }).observe({ type: "longtask" }); } catch { }
	});
	await keyboard.press("m", ["Shift"]);
	await sleep(1500); // past the first full score
	await evaluate(() => { window.frame_gaps = []; window.long_tasks = []; });
	const p0 = await painted(); start = Date.now();
	await sleep(10000);
	const p1 = await painted(); seconds = (Date.now() - start) / 1000;
	const timing = await evaluate(() => {
		window.timing_on = false;
		const gaps = [...window.frame_gaps].sort((a, b) => a - b);
		return { frames: gaps.length, p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0), max: Math.round(gaps[gaps.length - 1] ?? 0), long_tasks: window.long_tasks.length, longest_task: Math.max(0, ...window.long_tasks) };
	});
	rate = (p1.n - p0.n) / seconds;
	check("1,024 a second on 800x600 keeps to the speed", rate > 950 && rate <= 1040, `${rate.toFixed(0)}/s over ${seconds.toFixed(1)} s`);
	check("...and the page keeps drawing frames", timing.frames > seconds * 30 && timing.max < 250, JSON.stringify(timing));
	await keyboard.press("m", ["Shift"]);
	// The same in D23's pass orders, 5 s each in a seed with the ladders: worst first sweeps the canvas once for each of
	// its 8 bands of distance, and exact first twice.
	await receive([...FULL_COLOR, ...speed_items(10), "Progressive Pick Color", "Progressive Difference Mode", "Progressive Similarity Mode", "Progressive Pick Color", "Progressive Difference Mode"], { ...SLOT_DATA, ladders: true });
	const by_order = {};
	for (const order of ["worst", "exact"]) {
		await evaluate((order) => window.paint_hard_auto_copy.choose_order(order), order);
		await call("clear");
		await focus_page();
		await keyboard.press("m", ["Shift"]);
		await sleep(1500); // past the first full score
		await evaluate(() => {
			window.frame_gaps = [];
			window.long_tasks = [];
			let last = performance.now();
			const frame = (now) => { window.frame_gaps.push(now - last); last = now; if (window.timing_on) requestAnimationFrame(frame); };
			window.timing_on = true;
			requestAnimationFrame(frame);
		});
		const q0 = await painted(), from = Date.now();
		await sleep(5000);
		const q1 = await painted(), took = (Date.now() - from) / 1000;
		const gaps = await evaluate(() => {
			window.timing_on = false;
			const sorted = [...window.frame_gaps].sort((a, b) => a - b);
			return { frames: sorted.length, max: Math.round(sorted[sorted.length - 1] ?? 0), long_tasks: window.long_tasks.length };
		});
		by_order[order] = { order: await evaluate(() => window.paint_hard_auto_copy.order()), rate: Math.round((q1.n - q0.n) / took), ...gaps };
		await keyboard.press("m", ["Shift"]);
	}
	check("...and so do worst first and exact first", Object.entries(by_order).every(([order, r]) => r.order === order && r.rate > 950 && r.rate <= 1040 && r.frames > 150 && r.max < 250), JSON.stringify(by_order));

	// 17. A seed from before the speed items: Phase 2's slot data, Pick Color under its old name, no speed copies.
	const { auto_copy_speed_items: _speed_items, miss_margin_step: _margin_step, ...PHASE_2_SLOT } = SLOT_DATA;
	await receive([...FULL_COLOR, "Pick Color"], PHASE_2_SLOT);
	await sleep(2200); // the panel refreshes every 2 s while stopped
	const old_seed = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		const panel = document.querySelector(".auto-copy-panel .window-content")?.innerText.replace(/\s+/g, " ") ?? "";
		return { top: window.paint_hard_auto_copy.top_tier(), speed: window.paint_hard_auto_copy.speed(), views: ap.mode_unlocked("Similarity") && ap.mode_unlocked("Difference"), pick: !document.getElementById("TOOL_PICK_COLOR").classList.contains("disabled"), top_speed: panel.includes("The top speed.") };
	});
	check("a seed from before the speed items keeps every tier, both views and Pick Color", old_seed.top === 10 && old_seed.speed === 1024 && old_seed.views && old_seed.pick && old_seed.top_speed, JSON.stringify(old_seed));
	// Each stand-in session starts with every tool locked, as a fresh page does, so the unlock above came from this one.
	await receive([...FULL_COLOR], PHASE_2_SLOT);
	check("...and one without its Pick Color item leaves the tool locked", await evaluate(() => document.getElementById("TOOL_PICK_COLOR").classList.contains("disabled")));

	// 18. Late in a game, 8,000 items: a packet without color items keeps the rounding tables, and rounding stays cheap.
	const late_game = await evaluate(async (slot_data, items) => {
		const { fake_session } = await import("/src/archipelago.js");
		const { legalizeColor } = await import("/src/$ColorBox.js");
		const hook = window.paint_hard_auto_copy;
		fake_session(slot_data, items);
		const before = hook.rounding_tables();
		fake_session(slot_data, [...items, "Late Filler"]);
		const kept = hook.rounding_tables() === before;
		const start = performance.now();
		for (let i = 0; i < 768; i++) legalizeColor("rgb(12,200,77)");
		const ms = performance.now() - start;
		fake_session(slot_data, [...items, "Late Filler", "Progressive Color Depth (Red)"]);
		return { kept, ms, rebuilt: hook.rounding_tables() !== before };
	}, SLOT_DATA, ["Magnifier", "Brush", ...FULL_COLOR.slice(3), ...speed_items(10), ...Array(7228).fill("Late Filler")]);
	check("late in a game, a packet without color items keeps the rounding tables", late_game.kept && late_game.rebuilt, JSON.stringify(late_game));
	check("...and 768 colors round in under 50 ms at 8,000 items", late_game.ms < 50, `${late_game.ms.toFixed(1)} ms`);

	// 19. The Overclock bank (D25): it fills by itself up to its size, fillers go on top, and its own seconds go first.
	const BANK_SLOT = { ...SLOT_DATA, overclock_bank_size_step: 3, overclock_fill_speed_step: 30 }; // 3 s a copy; half a second a second
	const bank_now = () => evaluate(() => window.paint_hard_auto_copy.overclock_bank());
	const BANK_ITEMS = [...FULL_COLOR, ...speed_items(10), "Progressive Overclock Bank Size", "Progressive Overclock Fill Speed", ...SURE];
	// Sets the bank's level as another tab would leave it: a fill note that many seconds over every page's bank seconds.
	const set_bank = (seconds) => evaluate((seconds) => {
		const { mine, others } = window.paint_hard_auto_copy.overclock_record();
		localStorage.setItem("pain-t-overclock-fill:test", JSON.stringify({ filled: mine.used + others.used + seconds, at: Date.now() }));
	}, seconds);
	const drain = () => set_bank(0);
	await call("resize_canvas_without_saving_dimensions", 600, 450);
	await receive([...FULL_COLOR, ...speed_items(10)], BANK_SLOT);
	await sleep(2200);
	let bank = await bank_now();
	check("without the bank's ladders nothing fills by itself", bank.size === 0 && bank.level === 0, JSON.stringify(bank));
	await receive(BANK_ITEMS, BANK_SLOT);
	await sleep(2200);
	bank = await bank_now();
	check("with one copy of each, the bank fills by itself at half a second a second", bank.size === 3 && bank.level > 0.5 && bank.level < 1.7, JSON.stringify(bank));
	await sleep(5000);
	bank = await bank_now();
	// The record's own level too: the page shows at most the bank's size, so a fill past it would only show as the bank
	// refilling as it's spent.
	const capped = await overclock_stored();
	check("...and stops at its size", Math.abs(bank.level - 3) < 1e-9 && Math.abs(capped.level - 3) < 1e-9, `${JSON.stringify(bank)}; the record's level ${capped.level}`);
	await receive([...BANK_ITEMS, ...Array(20).fill("Overclock")], BANK_SLOT);
	bank = await bank_now();
	const on_top = await evaluate(() => window.paint_hard_auto_copy.overclock_banked());
	check("Overclock fillers go on top of a full bank", bank.filler > 0 && Math.abs(on_top - (bank.level + bank.filler)) < 1e-9 && on_top > bank.size, `${on_top} banked: ${JSON.stringify(bank)}`);
	await call("clear");
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await sleep(1500);
	const spending = await bank_now();
	await keyboard.press("m", ["Shift"]); // pause
	check("auto copy spends the bank's own seconds first", spending.level < 3 && Math.abs(spending.filler - bank.filler) < 1e-9, `${JSON.stringify(bank)} -> ${JSON.stringify(spending)}`);
	const kept = (await overclock_stored()).level;
	check("...and keeps the bank's level in this browser", Math.abs(kept - (await bank_now()).level) < 0.6, `${kept} kept`);
	check("the panel shows the bank", /The bank holds \d+ s of 3 s and fills 30 s a minute while auto copy isn't running\./.test(await panel_text() || ""), await panel_text());

	// Another tab of the same game spends 10 filler seconds, under its own page's key. This tab takes that in at its next
	// merge, a second at most, and writes only its own page's totals, so the other tab's stay as that tab wrote them.
	const other_key = "pain-t-overclock-page:test:another-tab";
	const other_tab = await evaluate((key) => {
		const filler = window.paint_hard_auto_copy.overclock_bank().filler;
		localStorage.setItem(key, JSON.stringify({ spent: 10, used: 0 }));
		return { filler };
	}, other_key);
	await sleep(1300);
	const after_other = await bank_now();
	check("seconds another tab spent reach this one within a second", Math.abs(after_other.filler - (other_tab.filler - 10)) < 1e-6, `${other_tab.filler} -> ${after_other.filler}`);
	await sleep(2500); // more of this tab's merges, as the bank fills
	const own = await evaluate(() => window.paint_hard_auto_copy.overclock_record());
	const record = await overclock_stored();
	check("...and stay in the record as that tab wrote them, beside this tab's own", (await evaluate((key) => localStorage.getItem(key), other_key)) === JSON.stringify({ spent: 10, used: 0 }) && record.pages === 2 && Math.abs(record.spent - (own.mine.spent + 10)) < 1e-9, `${JSON.stringify(record)}; this page ${JSON.stringify(own.mine)}`);

	// While auto copy spends the bank, the record is written once a second, not on every 50 ms tick: this page's totals,
	// each with its copy in sessionStorage. The fill note isn't written at all, since the bank doesn't fill while auto
	// copy runs (D25), so the bank's 3 s go at a second a second.
	await receive(BANK_ITEMS, BANK_SLOT); // no Overclock fillers
	await set_bank(3);
	await sleep(1200);
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await sleep(300);
	const writes = await evaluate(async () => {
		const set_item = Storage.prototype.setItem;
		const n = { stored: 0, copies: 0, notes: 0 };
		Storage.prototype.setItem = function (key, value) {
			if (String(key).startsWith("pain-t-overclock-")) n[this === sessionStorage ? "copies" : "stored"]++;
			if (String(key).startsWith("pain-t-overclock-fill:")) n.notes++;
			return set_item.call(this, key, value);
		};
		const from = window.paint_hard_auto_copy.overclock_bank().level;
		await new Promise((resolve) => setTimeout(resolve, 2000));
		Storage.prototype.setItem = set_item;
		return { ...n, from, bank: window.paint_hard_auto_copy.overclock_bank() };
	});
	await keyboard.press("m", ["Shift"]); // pause
	check("a bank auto copy spends is written once a second, and doesn't fill while it runs", writes.stored <= 6 && writes.copies <= 6 && writes.notes === 0 && writes.from - writes.bank.level > 1.8, `${writes.stored} writes and ${writes.copies} copies in 2 s, ${writes.notes} of the fill note; ${writes.from.toFixed(3)} -> ${writes.bank.level.toFixed(3)} s banked`);

	// With storage full, the browser refuses the record's writes. This tab spends from its own totals, not from what
	// storage last took, so a full bank still drains and the fillers still run out. Here the bank holds 3 s and doesn't
	// fill, and the fillers hold 1 to 3 s.
	const spent_so_far = (await evaluate(() => window.paint_hard_auto_copy.overclock_record())).mine.spent + 10;
	const REFUSAL_ITEMS = [...FULL_COLOR, ...speed_items(10), "Progressive Overclock Bank Size", ...Array(Math.ceil((spent_so_far + 1) / 2)).fill("Overclock")];
	await receive(REFUSAL_ITEMS, BANK_SLOT);
	await set_bank(3);
	await evaluate(() => {
		const set_item = Storage.prototype.setItem;
		window.stop_refusing = () => { Storage.prototype.setItem = set_item; };
		Storage.prototype.setItem = function (key, value) {
			if (String(key).startsWith("pain-t-overclock-")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
			return set_item.call(this, key, value);
		};
	});
	await sleep(1200);
	const refused_from = await bank_now();
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await sleep(7000);
	const refused = await evaluate(() => ({ banked: window.paint_hard_auto_copy.overclock_banked(), bank: window.paint_hard_auto_copy.overclock_bank() }));
	await keyboard.press("m", ["Shift"]); // pause
	const stored_while_refused = await overclock_stored();
	await evaluate(() => window.stop_refusing());
	check("with storage refusing the record's writes, a full bank still drains and the fillers still run out", Math.abs(refused_from.level - 3) < 1e-9 && refused_from.filler >= 1 && refused.banked === 0, `${JSON.stringify(refused_from)} -> ${JSON.stringify(refused)}`);
	await sleep(1200);
	const mine_now = (await evaluate(() => window.paint_hard_auto_copy.overclock_record())).mine, stored_after = await overclock_stored();
	check("...and once storage takes writes again, this tab's totals reach it within a second", stored_while_refused.used < mine_now.used - 2 && Math.abs(stored_after.used - mine_now.used) < 1e-9 && Math.abs(stored_after.spent - (mine_now.spent + 10)) < 1e-9, `${JSON.stringify(stored_while_refused)} while refused; ${JSON.stringify(stored_after)} after; this page ${JSON.stringify(mine_now)}`);

	// The tab plays another game, then comes back: its totals for the first game come back from what it wrote, so it
	// doesn't write nothing over its own key.
	const left_game = { filler: (await bank_now()).filler, mine: (await evaluate(() => window.paint_hard_auto_copy.overclock_record())).mine, stored: await overclock_stored() };
	await evaluate(async (slot_data, items) => {
		const { fake_session } = await import("/src/archipelago.js");
		fake_session(slot_data, ["Magnifier", "Brush", ...items], "another-game");
		window.paint_hard_auto_copy.overclock_bank(); // loads that game's record
	}, BANK_SLOT, [...FULL_COLOR, ...speed_items(10), ...SURE]);
	await sleep(1200);
	await receive(REFUSAL_ITEMS, BANK_SLOT);
	await sleep(1200);
	const back_in_game = { filler: (await bank_now()).filler, mine: (await evaluate(() => window.paint_hard_auto_copy.overclock_record())).mine, stored: await overclock_stored() };
	check("a tab that plays another game and comes back keeps what it spent in the first", left_game.mine.spent > 0 && Math.abs(back_in_game.filler - left_game.filler) < 1e-9 && back_in_game.mine.spent === left_game.mine.spent && back_in_game.mine.used === left_game.mine.used && Math.abs(back_in_game.stored.spent - left_game.stored.spent) < 1e-9, `${JSON.stringify(left_game)} -> ${JSON.stringify(back_in_game)}`);

	// The time left doesn't jump when auto copy pauses: banked seconds count as the stretch they double. While paused the
	// bank fills, and the estimate falls by what that adds. D25's defaults: 5 copies of each.
	const DEFAULT_BANK = { ...SLOT_DATA, overclock_bank_size_step: 120, overclock_fill_speed_step: 2 };
	const DEFAULT_ITEMS = [...FULL_COLOR, ...speed_items(10), ...Array(5).fill("Progressive Overclock Bank Size"), ...Array(5).fill("Progressive Overclock Fill Speed"), ...SURE];
	await receive(DEFAULT_ITEMS, DEFAULT_BANK);
	await set_bank(3);
	await call("clear");
	await sleep(1200);
	const time_left = async () => (await panel_text() || "").match(/pixels left, (.+?)\./)?.[1] ?? null;
	// The speed line's readings in order, as the page itself sees them every 50 ms.
	const watch_line = () => evaluate(() => {
		window.line_seen = [];
		window.line_watch = setInterval(() => {
			const text = document.querySelector(".auto-copy-panel .window-content span").textContent;
			if (window.line_seen.at(-1) !== text) window.line_seen.push(text);
		}, 50);
	});
	const lines_seen = () => evaluate(() => { clearInterval(window.line_watch); return window.line_seen; });
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await watch_line();
	await sleep(13000);
	// The bank's 3 s double the speed until auto copy runs them out. It doesn't fill while auto copy runs, so from then on
	// the line reads the plain speed and the bank stays empty.
	const drain_lines = await lines_seen(), drained_level = (await bank_now()).level;
	const doubled_line = "2,048 pixels a second, Overclocked", plain_line = "1,024 pixels a second";
	check("a bank that runs dry reads Overclocked, then the plain speed, and stays empty while auto copy runs", JSON.stringify(drain_lines) === JSON.stringify([doubled_line, plain_line]) && drained_level === 0, `${JSON.stringify(drain_lines)}; ${drained_level} s banked`);
	const while_running = await time_left();
	await keyboard.press("m", ["Shift"]); // pause
	const paused_at = Date.now();
	// The bank, empty at the pause, fills from the next merge, and the panel redraws every 2 s while stopped, so the
	// panel shows the fill within about 3 s, and the bank stays under a second for 6.
	let paused_text = null;
	for (let i = 0; i < 50 && !/Overclock: under 1 s/.test(paused_text ?? ""); i++) {
		await sleep(100);
		paused_text = await panel_text();
	}
	const while_paused = paused_text?.match(/pixels left, (.+?)\./)?.[1] ?? null;
	// To the minute it rounds to, give or take one: the seconds banked while paused count as a stretch at double speed,
	// which can take a fraction of a second off and cross a rounding line.
	const minutes = (text) => { const m = text?.match(/(?:(\d+) h )?(\d+) min/); return m ? 60 * Number(m[1] ?? 0) + Number(m[2]) : text === "under a minute" ? 0 : NaN; };
	check("the time left stays put when auto copy pauses", Math.abs(minutes(while_running) - minutes(while_paused)) <= 1, `running: ${while_running}; paused: ${while_paused}`);
	check("...and a bank under a second shows as under 1 s", /Overclock: under 1 s of double speed banked\./.test(paused_text || ""), paused_text);
	// Resumed, auto copy spends what the bank filled while paused, then reads the plain speed again. A stroke's 3 s
	// hold-off, which auto copy waits through while it runs, fills nothing. It resumes 3 s after the pause at the soonest,
	// so the bank holds a third of a second or more and reads Overclocked for that long.
	await sleep(Math.max(0, paused_at + 3000 - Date.now()));
	await focus_page();
	await keyboard.press("m", ["Shift"]); // resume
	await watch_line();
	await sleep(2500);
	const dot = await point_on("canvas", 550, 420);
	await mouse.move(dot.x, dot.y);
	await mouse.down();
	await sleep(100);
	await mouse.up();
	await sleep(6000);
	const resumed_lines = await lines_seen(), after_hold_off = (await bank_now()).level;
	await keyboard.press("m", ["Shift"]); // pause
	check("...and resumed, it spends what the bank filled while paused, and a hold-off fills nothing", JSON.stringify(resumed_lines) === JSON.stringify([doubled_line, plain_line]) && after_hold_off === 0, `${JSON.stringify(resumed_lines)}; ${after_hold_off} s banked after`);
	// With 120 s banked, on a blank canvas at 1,024 pixels a second, the time left counts them as a stretch at double
	// speed: about 2 min, where the plain speed takes about 4. The speed line reads Overclocked only while auto copy
	// copies, and the plain speed while it's paused and while it holds off after a change, with seconds still banked.
	await call("clear");
	await set_bank(120);
	await sleep(1200);
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await keyboard.press("m", ["Shift"]); // and pause at once
	await sleep(2500); // the panel redraws every 2 s while stopped
	const read_panel = () => evaluate(() => {
		const content = document.querySelector(".auto-copy-panel .window-content");
		return { state: content.children[0].textContent, progress: content.children[1].textContent, line: content.querySelector("span").textContent, banked: window.paint_hard_auto_copy.overclock_banked() };
	});
	const banked_paused = await read_panel();
	const pixels_left = Number(banked_paused.progress.match(/([\d,]+) pixels left/)?.[1].replace(/,/g, "")), banked_then = banked_paused.banked;
	const doubled_minutes = Math.round((pixels_left <= 2048 * banked_then ? pixels_left / 2048 : banked_then + (pixels_left - 2048 * banked_then) / 1024) / 60);
	const plain_minutes = Math.round(pixels_left / 1024 / 60);
	check("with seconds banked, the time left counts them at double speed", minutes(banked_paused.progress.match(/pixels left, (.+?)\./)?.[1]) === doubled_minutes && doubled_minutes !== plain_minutes, `${banked_paused.progress} with ${banked_then.toFixed(1)} s banked, where it takes about ${doubled_minutes} min at double speed and ${plain_minutes} at the plain speed`);
	await focus_page();
	await keyboard.press("m", ["Shift"]); // resume
	await sleep(1200);
	const banked_copying = await read_panel();
	await evaluate(() => window.$G.triggerHandler("history-update")); // a change auto copy didn't make
	await sleep(600);
	const banked_holding = await read_panel();
	await keyboard.press("m", ["Shift"]); // pause
	check("...and the speed line reads Overclocked only while auto copy copies, not while it's paused or holds off", banked_paused.line === plain_line && banked_copying.line === doubled_line && /Waiting a moment/.test(banked_holding.state) && banked_holding.banked > 100 && banked_holding.line === plain_line, JSON.stringify({ paused: banked_paused.line, copying: banked_copying.line, holding_off: [banked_holding.state, banked_holding.line, banked_holding.banked] }));
	// With 240 s banked, enough to double about 491,000 pixels, the bank covers what's left, so all of it is at double
	// speed: about 2 min still. Counting the 240 s as a stretch before the plain speed would take under a minute. Read
	// once the panel redraws with the new level.
	await set_bank(240);
	let covered = null;
	for (let i = 0; i < 50 && !/Overclock: 4 min of double speed banked/.test(covered ?? ""); i++) {
		await sleep(100);
		covered = await panel_text();
	}
	const covered_left = Number(covered?.match(/([\d,]+) pixels left/)?.[1].replace(/,/g, ""));
	check("...and with the bank covering what's left, the time left is all at double speed", covered_left <= 2048 * 240 && minutes(covered?.match(/pixels left, (.+?)\./)?.[1]) === Math.round(covered_left / 2048 / 60), `${covered}; about ${Math.round(covered_left / 2048 / 60)} min at double speed`);
	// The page's Date.now stands in for the clock from here on.
	await evaluate(() => {
		const real = Date.now;
		window.clock = { real, offset: 0 };
		Date.now = () => real.call(Date) + window.clock.offset;
	});
	// Another tab of the game runs auto copy: it holds a Web Lock named for the game and its id, and this tab, resting,
	// doesn't fill the bank while that's held, from its first merge that reads it. Nothing compares times, so that holds
	// through a clock set 2 minutes ahead, then an hour back, then right again, as a sleep or a time sync moves it. The
	// page holds these locks itself, under ids no page has.
	const fill_key = "pain-t-overclock-fill:test", other_run = "pain-t-overclock-run:test:running-tab";
	const hold_lock = (name) => evaluate((name) => new Promise((granted) => {
		navigator.locks.request(name, () => new Promise((release) => { window.let_go_lock = release; granted(true); }));
	}), name);
	// Lets go of the lock, and with `stop` moves the fill note on to now with nothing added in the same task, as a tab that
	// stops auto copy does. Returns when, by the page's clock.
	const let_go_lock = (stop) => evaluate((key, stop) => {
		if (stop) localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), at: Date.now() }));
		window.let_go_lock();
		return Date.now();
	}, fill_key, stop);
	// The page's first merge after `after` by its clock, and within 30 s of it, so a merge from before a clock set back
	// doesn't count, with whether it saw another tab run, and the stored note's fill read in the same task.
	const merge_after = async (after) => {
		for (let i = 0; i < 50; i++) {
			const seen = await evaluate((after, key) => {
				const { merged_at, others } = window.paint_hard_auto_copy.overclock_record();
				if (!(merged_at > after && merged_at - after < 30000)) return null;
				return { at: merged_at, running: others.running, filled: JSON.parse(localStorage.getItem(key) ?? "null")?.filled ?? 0 };
			}, after, fill_key);
			if (seen) return seen;
			await sleep(100);
		}
		return null;
	};
	const page_now = () => evaluate(() => Date.now());
	// Moves the clock on by `by` ms, or back to right with null, and reads the page's next 5 merges.
	const merges_after = async (by) => {
		let after = await evaluate((by) => { window.clock.offset = by === null ? 0 : window.clock.offset + by; return Date.now(); }, by);
		const merges = [];
		for (let i = 0; i < 5; i++) {
			const merge = await merge_after(after);
			if (!merge) break;
			merges.push(merge);
			after = merge.at;
		}
		return merges;
	};
	// The page's first merge from now on that sees another tab run, or that doesn't, within 5 merges.
	const merge_seeing = async (running) => {
		let merge = null;
		for (let i = 0; i < 5 && merge?.running !== running; i++) merge = await merge_after(merge?.at ?? await page_now());
		return merge?.running === running ? merge : null;
	};
	await hold_lock(other_run);
	const seen_run = await merge_seeing(true);
	const held_merges = [...await merges_after(0), ...await merges_after(120000), ...await merges_after(-3600000), ...await merges_after(null)];
	const held_fill = held_merges.map((merge) => Number((merge.filled - seen_run?.filled).toFixed(4)));
	check("the bank doesn't fill while another tab runs auto copy, holding its run lock, through a clock set 2 minutes ahead, an hour back and right again", !!seen_run && held_merges.length === 20 && held_merges.every((merge) => merge.running) && held_fill.every((seconds) => seconds === 0), `seconds filled by each of the 5 merges after the run was seen, after the clock went 2 minutes ahead, an hour back and right again: ${JSON.stringify(held_fill)}, ${held_merges.filter((merge) => merge.running).length} of ${held_merges.length} seeing the run`);
	// Once the other tab stops, the fill counts from the stop note it leaves. A run that ends with no note, as when its tab
	// crashes, says nothing of when it ended, so the fill counts from this tab's first merge since. Up to 3 tries at the
	// stop, since a merge whose query came just before the lock was let go of still sees the run, and then nothing tells
	// the stop from a crash.
	await let_go_lock(false);
	const crashed = await merge_seeing(false), after_crash = crashed && await merge_after(crashed.at);
	let stop = null;
	for (let i = 0; i < 3 && !stop?.first; i++) {
		await hold_lock(other_run);
		const held = await merge_seeing(true), stopped_at = await let_go_lock(true), next = await merge_after(stopped_at);
		stop = { held, stopped_at, next, first: next && !next.running ? next : null, tries: i + 1 };
	}
	const last_held = held_merges.at(-1);
	const crash_added = crashed && last_held ? Number((crashed.filled - last_held.filled).toFixed(4)) : NaN;
	const crash_then = after_crash && crashed ? Number((after_crash.filled - crashed.filled).toFixed(4)) : NaN;
	const stop_added = stop?.first && stop.held ? stop.first.filled - stop.held.filled : NaN, since_stop = stop?.first ? (stop.first.at - stop.stopped_at) / 1000 : NaN;
	check("...and once that tab stops, the fill counts from its stop note, or from this tab's first merge since a run that ends with no note, as when its tab crashes", crash_added === 0 && crash_then > 0 && stop_added > 0 && stop_added <= since_stop / 6 + 0.002, `after a crash: ${crash_added} s at the first merge that saw no run, then ${crash_then} s at the next; after a stop: ${stop_added.toFixed(4)} s at the first merge since, ${since_stop.toFixed(3)} s after it, at 1/6 s a second, in ${stop?.tries} tries`);
	// A lock held for another game doesn't count.
	await hold_lock("pain-t-overclock-run:another-game:running-tab");
	const other_game_from = await merge_after(await page_now());
	await sleep(3000);
	const other_game_to = await merge_after(await page_now());
	await let_go_lock(false);
	const other_game_fill = other_game_to && other_game_from ? Number((other_game_to.filled - other_game_from.filled).toFixed(4)) : NaN;
	const other_game_for = other_game_to && other_game_from ? ((other_game_to.at - other_game_from.at) / 1000).toFixed(1) : "no";
	check("...and a run lock that another game's tab holds doesn't count", other_game_fill > 0.3 && !other_game_to.running, `${other_game_fill} s filled in the ${other_game_for} s between two merges beside it, at 1/6 s a second`);
	await drain();
	// A tab running auto copy holds its own run lock from the moment it starts, through a clock jumped 31 s and set back an
	// hour, sees no other tab run beside it, and lets go of the lock as it pauses.
	const own_run = await evaluate(() => `pain-t-overclock-run:test:${window.paint_hard_auto_copy.overclock_record().page}`);
	// Whether the page holds it, by a query after a task, so a lock let go of in the task before shows as let go.
	const holds_own_run = () => evaluate(async (name) => {
		await new Promise((resolve) => setTimeout(resolve));
		return (await navigator.locks.query()).held.some((lock) => lock.name === name);
	}, own_run);
	// Starts auto copy as Shift+M does, and asks for the locks held in the same task, after the start's lock request.
	const started_holding = await evaluate(async (name) => {
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true }));
		return { running: window.paint_hard_auto_copy.running(), held: (await navigator.locks.query()).held.some((lock) => lock.name === name) };
	}, own_run);
	await evaluate(() => { window.clock.offset = 31000; });
	await sleep(1500);
	const held_ahead = await holds_own_run();
	await evaluate(() => { window.clock.offset = -3600000; });
	await sleep(1500);
	const held_back = await holds_own_run(), alone = (await evaluate(() => window.paint_hard_auto_copy.overclock_record())).others.running;
	await focus_page();
	await keyboard.press("m", ["Shift"]); // pause
	const held_paused = await holds_own_run();
	await evaluate(() => { window.clock.offset = 0; });
	check("a tab running auto copy holds its run lock from the moment it starts, through a clock jumped 31 s and set back an hour, sees no other tab run, and lets go of it as it pauses", started_holding.running && started_holding.held && held_ahead && held_back && alone === false && !held_paused, JSON.stringify({ started: started_holding, held_ahead, held_back, others_running: alone, held_paused }));
	await drain();
	// A trip through the back-forward cache while auto copy runs, with pagehide and pageshow events standing in for it: as
	// the page goes, it lets go of its run lock. Once it's back, auto copy runs again, and the page takes the lock again at
	// its next merge and fills nothing.
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await sleep(1500);
	const away = await evaluate(async (name) => {
		dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		await new Promise((resolve) => setTimeout(resolve));
		const held = (await navigator.locks.query()).held.some((lock) => lock.name === name);
		dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		return { held, back_at: performance.now() };
	}, own_run);
	let back_held = false, back_after = NaN; // once a merge takes it again, within 5 s
	for (let i = 0; i < 50 && !back_held; i++) {
		await sleep(100);
		back_held = await holds_own_run();
		if (back_held) back_after = await evaluate((at) => performance.now() - at, away.back_at);
	}
	const back_from = (await overclock_stored()).fill.filled;
	await sleep(3000);
	const back_to = (await overclock_stored()).fill.filled;
	await keyboard.press("m", ["Shift"]); // pause
	check("a trip through the back-forward cache lets go of the run lock as the page goes, and takes it again once it's back, with nothing filled", !away.held && back_held && back_to === back_from, `held as it went: ${away.held}; once back: ${back_held ? `held by ${Math.round(back_after)} ms after the pageshow` : "not held in 5 s"}; ${(back_to - back_from).toFixed(3)} s filled in the 3 s after`);
	await drain();
	await receive([...FULL_COLOR, ...speed_items(10)], BANK_SLOT); // a moment without the bank, as before connecting
	await sleep(1200);
	await receive(BANK_ITEMS, BANK_SLOT);
	await sleep(1200);
	const before_back = (await bank_now()).level;
	await evaluate(() => { window.clock.offset = -20000; });
	await sleep(3200);
	const after_back = (await bank_now()).level;
	check("setting the clock back 20 s keeps the bank filling", after_back - before_back > 0.4, `${before_back} -> ${after_back} at half a second a second`);
	// This tab stops filling, another tab fills on, and the clock is set back past that tab's last note but not this
	// tab's own. The stored note counts, not this tab's older one.
	await receive(DEFAULT_ITEMS, DEFAULT_BANK);
	await evaluate(() => { window.clock.offset = 0; });
	await drain();
	await sleep(1200); // this tab writes notes of its own
	await receive([...FULL_COLOR, ...speed_items(10)], DEFAULT_BANK); // and stops filling
	await sleep(3000);
	await set_bank(20); // another tab's note, 3 s after this tab's last
	await evaluate(() => { window.clock.offset = -2000; });
	await receive(DEFAULT_ITEMS, DEFAULT_BANK); // this tab fills again
	await sleep(1200);
	const after_other_note = (await bank_now()).level;
	check("...and set back past another tab's newer note, that note still counts over this tab's older one", after_other_note > 19.9, `${after_other_note} s, where the other tab's note held 20 s`);
	await evaluate(() => { window.clock.offset = 0; });
	await drain();
	await sleep(1200);
	const before_forward = (await bank_now()).level;
	await evaluate(() => { window.clock.offset += 3600000; });
	await sleep(1600);
	const after_forward = (await bank_now()).level;
	check("...and setting it forward an hour fills a minute and a half's worth at most", after_forward > before_forward && after_forward - before_forward <= 90 * 10 / 60 + 1, `${before_forward} -> ${after_forward} of 600 s`);
	// Storage refuses this tab's notes, so it counts from the later of the stored note and its own. Its own, from an hour
	// ahead, goes last once the clock is set right, and another tab's newer note counts.
	await evaluate(() => {
		const set_item = Storage.prototype.setItem;
		window.stop_refusing = () => { Storage.prototype.setItem = set_item; };
		window.as_another_tab = (key, value) => set_item.call(localStorage, key, value);
		Storage.prototype.setItem = function (key, value) {
			if (String(key).startsWith("pain-t-overclock-fill:")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
			return set_item.call(this, key, value);
		};
	});
	await sleep(1200); // this tab's note, an hour ahead, is refused
	await evaluate(() => {
		Date.now = window.clock.real;
		const { mine, others } = window.paint_hard_auto_copy.overclock_record();
		window.as_another_tab("pain-t-overclock-fill:test", JSON.stringify({ filled: mine.used + others.used + 50, at: Date.now() }));
	});
	await sleep(1300);
	const newer_note = (await bank_now()).level;
	await evaluate(() => window.stop_refusing());
	check("...and with storage refusing this tab's notes, once it's set right, another tab's newer note counts over this tab's own from an hour ahead", Math.abs(newer_note - 50) < 1, `${newer_note} s, where the other tab's note held 50 s`);

	// Import Session over the canvas while auto copy runs: auto copy hears about it as a change it didn't make, holds
	// off, and rescores the imported canvas, rather than sending from the old canvas's total for up to a minute.
	await receive([...FULL_COLOR, ...speed_items(10)]);
	await call("clear");
	await evaluate(async () => {
		systemHooks.showSaveFileDialog = async ({ getBlob }) => { window.backup_text = await (await getBlob()).text(); };
		await window.export_local_session(); // an older backup, of the blank canvas
		const functions = await import("/src/functions.js");
		main_ctx.putImageData(goal_ctx.getImageData(0, 0, 600, 300), 0, 0); // then most of the goal, in one step
		try { functions.undoable({ name: "Earlier progress" }, () => { }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
	});
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await sleep(4000); // past the hold-off for that step
	const before_import = await running_and_full();
	await evaluate(() => {
		systemHooks.showOpenFileDialog = async () => ({ file: new File([window.backup_text], "backup.appaint", { type: "application/json" }) });
		window.import_local_session();
	});
	let import_wait = null;
	for (let i = 0; i < 30 && !import_wait; i++) {
		await sleep(100);
		if (/Waiting a moment after your change/.test(await panel_text() || "")) import_wait = await panel_text();
	}
	check("importing a session while auto copy runs makes it hold off", !!import_wait, await panel_text());
	await sleep(3500);
	const after_import = await running_and_full();
	check("...and its running total is the imported canvas's", after_import.running !== null && Math.abs(after_import.running - after_import.full) < 1e-9 && after_import.full < before_import.full - 10, `${JSON.stringify(before_import)} -> ${JSON.stringify(after_import)}`);
	await keyboard.press("m", ["Shift"]); // pause

	// If copying fails partway, M lets go and says why, so auto copy isn't left waiting on a sweep that never ends. M reads
	// the canvas pixel it copies into, and the goal as the page last read it (task 7.3), so the canvas read fails here.
	await evaluate(() => { main_ctx.getImageData = () => { throw new Error("a test failure"); }; });
	await hover("goal", 200, 380);
	await keyboard.press("m");
	const failed_status = await status();
	await evaluate(() => { delete main_ctx.getImageData; });
	check("M stops when copying fails, and says why", failed_status === "M stopped: a test failure", failed_status);
	await keyboard.press("m", ["Shift"]); // resume
	await sleep(600);
	check("...and auto copy isn't left waiting on it", /^Copying\./.test(await panel_text() || ""), await panel_text());
	await keyboard.press("m", ["Shift"]); // pause

	// After a reload the bank's level is what the page had as it closed: the page writes its totals as it goes. Storage
	// refuses every other Overclock write while auto copy spends the bank, as when it's full, so only that last write can
	// carry the last 1.5 s. The test notes the level the page held at pagehide, after auto copy's own listener, added
	// first, has saved it. Near the end, as it reloads the page.
	const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
	await receive(DEFAULT_ITEMS, DEFAULT_BANK);
	await set_bank(100);
	await sleep(1200);
	await focus_page();
	await keyboard.press("m", ["Shift"]); // start
	await sleep(3500); // past any hold-off, spending the bank
	await evaluate(() => {
		const set_item = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (String(key).startsWith("pain-t-overclock-") && window.event?.type !== "pagehide") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
			return set_item.call(this, key, value);
		};
		addEventListener("pagehide", () => set_item.call(sessionStorage, "test-closing-level", String(window.paint_hard_auto_copy.overclock_bank().level)));
	});
	await sleep(1500);
	await open_paint(ready);
	const reloaded = await evaluate(async (slot_data, items) => {
		const { fake_session } = await import("/src/archipelago.js");
		fake_session(slot_data, ["Magnifier", "Brush", ...items]);
		return { level: window.paint_hard_auto_copy.overclock_bank().level, closing: Number(sessionStorage.getItem("test-closing-level")) };
	}, DEFAULT_BANK, DEFAULT_ITEMS);
	check("after a reload the bank's level is what the page had as it closed", reloaded.closing > 0 && reloaded.closing < 98 && Math.abs(reloaded.level - reloaded.closing) < 1e-6, `${reloaded.closing} as it closed, ${reloaded.level} after`);

	// Storage is full, so a key this tab hasn't written can't be added. The tab keeps what it spent through two reloads,
	// from its copy in sessionStorage, under the id it keeps, and the bank keeps its level, from the copy of the fill note.
	// Its keys go first, as for a tab whose every write was refused. The game has D25's bank, which starts empty and fills
	// while auto copy is paused, so its fill note is a new key too. Last, as it reloads the page.
	const page_id = await overclock_id();
	await evaluate((id) => { for (const key of Object.keys(localStorage)) if (key.startsWith("pain-t-overclock-page:") && key.endsWith(`:${id}`)) localStorage.removeItem(key); }, page_id);
	const REFUSE_NEW_KEYS = `{
		const set_item = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (this === localStorage && String(key).startsWith("pain-t-overclock-") && localStorage.getItem(key) === null) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
			return set_item.call(this, key, value);
		};
	}`;
	await evaluate(REFUSE_NEW_KEYS);
	const refuse_new_keys = await add_init_script(REFUSE_NEW_KEYS);
	const in_full_game = () => evaluate(async (slot_data, items) => {
		const { fake_session } = await import("/src/archipelago.js");
		fake_session(slot_data, ["Magnifier", "Brush", ...items], "full-storage");
		const { width, height } = goal_canvas;
		const image = goal_ctx.createImageData(width, height); // the test's goal, which a reload doesn't keep
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * width + x) * 4);
		goal_ctx.putImageData(image, 0, 0);
		$G.triggerHandler("save-goal");
		const { filler, level } = window.paint_hard_auto_copy.overclock_bank();
		return { filler, level };
	}, DEFAULT_BANK, [...DEFAULT_ITEMS, ...Array(10).fill("Overclock")]); // 20 s of fillers
	const full_from = await in_full_game();
	const reloads = [];
	for (let i = 0; i < 2; i++) {
		await focus_page();
		await keyboard.press("m", ["Shift"]); // start
		await sleep(3500);
		await keyboard.press("m", ["Shift"]); // pause
		await sleep(3000); // the bank fills half a second
		const left = (await bank_now()).filler;
		await evaluate(() => addEventListener("pagehide", () => sessionStorage.setItem("test-closing-level", String(window.paint_hard_auto_copy.overclock_bank().level))));
		await open_paint(ready);
		const after = await in_full_game();
		reloads.push({ left, after: after.filler, closing: Number(await evaluate(() => sessionStorage.getItem("test-closing-level"))), level: after.level, page: await overclock_id() });
	}
	const full_record = await overclock_stored("full-storage");
	await remove_init_script(refuse_new_keys);
	check("with storage full, a tab that reloads keeps what it spent, twice, under the id it keeps", full_from.filler === 20 && reloads[0].left < 19 && reloads[1].left < reloads[0].left - 1 && reloads.every((r) => Math.abs(r.after - r.left) < 1e-9 && r.page === page_id) && full_record.pages === 0, `${full_from.filler} s of fillers; ${JSON.stringify(reloads.map(({ left, after, page }) => ({ left, after, page })))}; ${full_record.pages} keys stored for that game`);
	check("...and the bank keeps the level it had as the page closed", reloads.every((r) => r.closing > 0.3 && Math.abs(r.level - r.closing) < 1e-6), JSON.stringify(reloads.map(({ closing, level }) => ({ closing, level }))));

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
