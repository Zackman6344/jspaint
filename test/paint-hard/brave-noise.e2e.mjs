// End-to-end test of auto copy and M under Brave's canvas farbling (brave-model.mjs), which nudges every getImageData()
// from page load on, the 1x1 reads Paint parses colors with included. Brave isn't needed: the model runs in Chrome.
// With this token, the parity check in auto copy's rounding tables used to throw at 6, 16, 42 and 256 shades, which
// stopped auto copy and M for most of a game (the second Phase 3 review).
// Usage: node test/paint-hard/brave-noise.e2e.mjs [--headful]. Set BROWSER_PATH if Chrome isn't in its default folder.
import { brave_noise_source, farble } from "./brave-model.mjs";
import { check, evaluate, finish, keyboard, mouse, open_paint, page, page_errors, point_on, sleep } from "./harness.mjs";

const TOKEN = "00112233445566778899aabbccddeeff";
const COLORS = [[12, 200, 77], [255, 128, 0], [90, 90, 250], [131, 7, 190]]; // the parity check's four
const color_items = (n) => ["Red", "Green", "Blue"].flatMap((channel) => Array(n).fill(`Progressive Color Depth (${channel})`));
const SPEED = Array(10).fill("Progressive Auto Copy Speed");
// Phase 4's items (D7): with every accuracy copy auto copy and M never miss, and Auto Copy Loop runs pass after pass
// until the canvas is done, as these checks expect. misses.e2e.mjs tests misses, the margin and passes.
const SURE = [...Array(9).fill("Progressive Auto Copy Accuracy"), "Auto Copy Loop"];
const SLOT_DATA = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 2, miss_margin_step: 1, version: "1.0.0", trap_blacklist: [] };
const receive = (items) => evaluate(async (slot_data, items) => {
	const { fake_session } = await import("/src/archipelago.js");
	const { resize_canvas_without_saving_dimensions } = await import("/src/functions.js");
	const width = main_canvas.width, height = main_canvas.height;
	fake_session(slot_data, ["Magnifier", "Brush", ...items]);
	resize_canvas_without_saving_dimensions(width, height);
}, SLOT_DATA, [...items, ...SURE]);
const tables = () => evaluate(() => { try { window.paint_hard_auto_copy.rounding_tables(); return "built"; } catch (error) { return `throws: ${error.message}`; } });
const state = () => evaluate(() => document.querySelector(".auto-copy-panel .window-content > div")?.textContent ?? null);
const true_px = (which, x, y) => evaluate((which, x, y) => Array.from(window.__brave_model.read(which === "goal" ? goal_ctx : main_ctx, x, y, 1, 1).data), which, x, y);
const focus_page = async () => { await mouse.click(5, 895); await sleep(100); };
const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
const hook = (name, ...args) => evaluate((name, args) => window.paint_hard_auto_copy[name](...args), name, args);
const shift_m = () => evaluate(() => { for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true })); });
const BLOCKED = "Your browser blocks reading the canvas, which auto copy and M need. Allow canvas reads for this site.";
// From section 4 on, each check stands in for a game of its own: a new run on a canvas of the size given, painted from
// white, toward a goal with lots of different colors.
const stage = (items, width, height, slot = SLOT_DATA) => evaluate(async (slot, items, width, height) => {
	const { fake_session } = await import("/src/archipelago.js");
	const { resize_canvas_without_saving_dimensions, set_magnification } = await import("/src/functions.js");
	document.querySelector(".auto-copy-panel .window-close-button")?.click(); // closing the panel drops the last run
	fake_session(slot, ["Magnifier", "Brush", ...items]);
	resize_canvas_without_saving_dimensions(width, height);
	const image = goal_ctx.createImageData(goal_canvas.width, goal_canvas.height);
	for (let y = 0; y < goal_canvas.height; y++) for (let x = 0; x < goal_canvas.width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * goal_canvas.width + x) * 4);
	goal_ctx.putImageData(image, 0, 0);
	main_ctx.fillStyle = "#fff";
	main_ctx.fillRect(0, 0, width, height);
	set_magnification(1);
	(await import("/src/auto-copy.js")).show_auto_copy_panel();
}, slot, items, width, height);
// Starts auto copy and waits until it stops, then pauses a run still going.
async function run_until_stopped(timeout) {
	await shift_m();
	const start = Date.now();
	let pass = null;
	while (Date.now() - start < timeout) {
		await sleep(250);
		pass = await hook("pass");
		if (!pass.running) break;
	}
	const result = { ...pass, state: await state(), left: await hook("pixels_left"), seconds: (Date.now() - start) / 1000 };
	if (pass.running) await shift_m();
	return result;
}
// Presses M over canvas pixel (x, y), and gives back the status line after it.
const press_m = (x, y) => evaluate((x, y) => new Promise((resolve) => {
	const rect = main_canvas.getBoundingClientRect();
	dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + (x + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true }));
	for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "m", code: "KeyM", bubbles: true }));
	setTimeout(() => resolve($status_text.text()), 250);
}), x, y);

try {
	const { identifier } = await page("Page.addScriptToEvaluateOnNewDocument", { source: brave_noise_source(TOKEN) });
	await open_paint(ready);

	// The model itself: its SHA-256, and its 1x1 reads against Node's crypto.
	const sha = await evaluate(() => window.__brave_model.sha256_hex("abc"));
	check("the page's SHA-256 is right", sha === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha);
	const parsed = await evaluate(async (colors) => {
		const { get_rgba_from_color } = await import("/src/helpers.js");
		return colors.map((rgb) => get_rgba_from_color(`rgb(${rgb})`));
	}, COLORS);
	const node_parse = COLORS.map((rgb) => Array.from(farble(Buffer.from(TOKEN, "hex"), [...rgb, 255])));
	check("the page's 1x1 reads match Node's HMAC model", JSON.stringify(parsed) === JSON.stringify(node_parse), parsed.map((p) => p.join(",")).join(" / "));
	check("...and this token reads some of the four colors a step off", parsed.some((p, i) => p.slice(0, 3).some((v, c) => v !== COLORS[i][c])), parsed.map((p) => p.join(",")).join(" / "));
	// D7: the page finds the noise as it loads. Section 4 checks that it then judges pixels with each channel let 1 off.
	const found = await evaluate(() => window.paint_hard_auto_copy.read_noise());
	check("the page finds the read noise as it loads", found === "load", String(found));

	await receive([...color_items(10), ...SPEED]);
	// SURE carries no margin copy, so a stand-in whose slot data lost miss_margin_step, which would play as a seed from
	// before Phase 4, reads a margin of 0 here.
	check("the stand-in plays as a Phase 4 seed: its margin is 255", (await hook("miss_margin")) === 255, String(await hook("miss_margin")));
	await evaluate(async () => {
		const functions = await import("/src/functions.js");
		const { width, height } = goal_canvas;
		const image = goal_ctx.createImageData(width, height); // a goal with lots of different colors
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * width + x) * 4);
		goal_ctx.putImageData(image, 0, 0);
		functions.set_magnification(1);
	});
	await sleep(300);

	// 1. The rounding tables build at every depth, the ones that used to throw included.
	const depths = {};
	for (const n of [0, 4, 10, 14, 40, 126, 254]) {
		await receive([...color_items(n), ...SPEED]);
		depths[n + 2] = await tables();
	}
	check("the rounding tables build at 2, 6, 12, 16, 42, 128 and 256 shades", Object.values(depths).every((result) => result === "built"), JSON.stringify(depths));

	// 2. Auto copy keeps running as color items arrive.
	await receive([...color_items(10), ...SPEED]);
	await focus_page();
	await keyboard.press("m", ["Shift"]);
	await sleep(4500); // past the hold-off after the packet's change
	check("auto copy runs at 12 shades", (await state()) === "Copying.", await state());
	await receive([...color_items(254), ...SPEED]);
	await sleep(4500);
	check("...and keeps running once every color item arrives", (await state()) === "Copying.", await state());
	await keyboard.press("m", ["Shift"]); // pause
	await evaluate(() => document.querySelector(".auto-copy-panel .window-close-button")?.click());
	await sleep(300);

	// 3. M copies at full depth: the canvas gets the goal's color, read without the noise.
	const at = await point_on("goal", 100, 50);
	await mouse.move(at.x, at.y);
	await sleep(50);
	const goal_px = await true_px("goal", 100, 50);
	await keyboard.press("m");
	await sleep(300);
	const copied = await true_px("canvas", 100, 50);
	check("M copies the goal's pixel at full depth", copied.every((v, c) => c === 3 ? v === 255 : Math.abs(v - goal_px[c]) <= 1), `${copied} vs the goal's ${goal_px}; ${await evaluate(() => $status_text.text())}`);

	// 4. With the noise found at load, a pixel within 1 of its best shade counts as done, so a 30x20 canvas at full depth
	// finishes in its first pass. Judged without the noise too: every pixel within 1 of the goal.
	await stage([...color_items(254), ...SPEED, ...SURE], 30, 20);
	const finished = await run_until_stopped(20000);
	const truth = await evaluate(() => {
		const canvas = window.__brave_model.read(main_ctx, 0, 0, 30, 20).data, goal = window.__brave_model.read(goal_ctx, 0, 0, 30, 20).data;
		let within1 = 0;
		for (let i = 0; i < canvas.length; i += 4) if (Math.max(Math.abs(canvas[i] - goal[i]), Math.abs(canvas[i + 1] - goal[i + 1]), Math.abs(canvas[i + 2] - goal[i + 2])) <= 1) within1++;
		return within1;
	});
	check("with the noise found at load, a 30x20 canvas at full depth finishes in its first pass", finished.done && finished.number === 1 && finished.left === 0 && truth === 600, `${JSON.stringify(finished)}; ${truth} of 600 within 1 of the goal, read without the noise`);

	// 5. The same at 6 shades, on a goal whose red and blue sit where a value and its low-bit twin round to different
	// shades (76 rounds to 51, 77 to 102) and whose green is a shade, 0: each pixel is judged against the one read of the
	// goal it was painted from, so the noise can't move its right shade a whole step between reads.
	await stage([...color_items(4), ...SPEED, ...SURE], 30, 20);
	await evaluate(() => {
		const image = goal_ctx.createImageData(30, 20);
		for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) image.data.set([76 + (x % 2), 0, 76 + (y % 2), 255], (y * 30 + x) * 4);
		goal_ctx.putImageData(image, 0, 0);
	});
	const six = await run_until_stopped(20000);
	check("...and at 6 shades, on a goal at the shade boundaries", six.done && six.left === 0, JSON.stringify(six));

	// 6. M judges the same way: pressed again on a pixel it just painted, it finds it done, 12 pixels of 12.
	await stage([...color_items(254), ...SPEED, ...SURE], 30, 20);
	const presses = [];
	for (let x = 2; x < 26; x += 2) presses.push({ x, first: await press_m(x, 10), again: await press_m(x, 10) });
	const matched = presses.filter((p) => /^Copied/.test(p.first) && p.again === "Already matches the goal.");
	check("M pressed again on a pixel it painted finds it done", matched.length === 12, `${matched.length} of 12; ${JSON.stringify(presses.filter((p) => !matched.includes(p)).slice(0, 3))}`);

	// 7. With misses left at a small margin a Loop run still ends: the count of pixels left reads the canvas in the scan's
	// own strips, so the two read every pixel alike. 200x200 at 65,536 pixels a second, 90% misses at margin 10.
	await stage([...color_items(254), ...Array(16).fill("Progressive Auto Copy Speed"), ...Array(245).fill("Progressive Miss Margin"), "Auto Copy Loop"], 200, 200, { ...SLOT_DATA, auto_copy_speed_items: 16 });
	await hook("seed_random", 1);
	const margin = await hook("miss_margin");
	const looped = await run_until_stopped(45000);
	check("with 90% misses at margin 10, a Loop run on 200x200 ends", margin === 10 && looped.done && looped.left === 0, `margin ${margin}; ${JSON.stringify(looped)}`);

	// The noise flips about 256 low bits a read wherever they land, so the run above meets a pixel the two reads judge
	// apart only by chance. Here one is made: on a 30x32 canvas painted in the goal's own colors, a pixel moved 2 levels
	// off the goal as read, picked where its 16-row strip, the read the scan makes, reads it 1 off, and a read of the
	// whole canvas 2 off. A count from the whole read would have the run pass on with nothing to paint; read in strips it
	// finds nothing left, and the run ends as it starts.
	await stage([...color_items(254), ...SPEED, ...SURE], 30, 32);
	const twin = await evaluate(() => {
		const W = 30, H = 32, gw = goal_canvas.width;
		const goal = goal_ctx.getImageData(0, 0, gw, goal_canvas.height).data; // the goal as count_left() reads it
		const truth = window.__brave_model.read(goal_ctx, 0, 0, W, H).data;
		main_ctx.putImageData(new ImageData(Uint8ClampedArray.from(truth), W, H), 0, 0);
		const done = (data, i, at) => data[i + 3] === 255 && [0, 1, 2].every((c) => Math.abs(data[i + c] - goal[at + c]) <= 1);
		const off_in = (data, top, rows) => {
			const off = [];
			for (let y = top; y < top + rows; y++) for (let x = 0; x < W; x++) if (!done(data, ((y - top) * W + x) * 4, (y * gw + x) * 4)) off.push([x, y]);
			return off;
		};
		for (let y = 16; y < H; y++) for (let x = 0; x < W; x++) {
			const j = (y * W + x) * 4, g = goal[(y * gw + x) * 4];
			const moved = g % 2 ? g + 2 : g - 2; // 1 off the goal as read if this read flips its low bit, else 2
			if (moved < 0 || moved > 255) continue;
			main_ctx.putImageData(new ImageData(Uint8ClampedArray.from([moved, truth[j + 1], truth[j + 2], 255]), 1, 1), x, y);
			const whole = off_in(main_ctx.getImageData(0, 0, W, H).data, 0, H);
			const strips = [...off_in(main_ctx.getImageData(0, 0, W, 16).data, 0, 16), ...off_in(main_ctx.getImageData(0, 16, W, 16).data, 16, 16)];
			if (whole.length === 1 && whole[0][0] === x && whole[0][1] === y && strips.length === 0) return { x, y, goal_red: g, painted_red: moved, tried: (y - 16) * W + x + 1 };
			main_ctx.putImageData(new ImageData(Uint8ClampedArray.from(truth.slice(j, j + 4)), 1, 1), x, y);
		}
		return null;
	});
	const twin_run = await run_until_stopped(5000);
	check("a pixel its strip reads as done and the whole canvas as off is done to the count too, so a Loop run ends", !!twin && twin_run.done && twin_run.left === 0, JSON.stringify({ twin, run: twin_run }));

	// 8. Reads that turn blocked while M is held, on a page without the noise: M lets go at its next read-back, paints
	// nothing more, and says why. 16 pixels a second, so M's line waits on the allowance.
	await page("Page.removeScriptToEvaluateOnNewDocument", { identifier });
	await open_paint(ready);
	await stage([...color_items(254), ...Array(4).fill("Progressive Auto Copy Speed"), ...SURE], 100, 100);
	const m_blocked = await evaluate(async () => {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const rect = main_canvas.getBoundingClientRect(), y = 30;
		const at = (px) => ({ clientX: rect.left + (px + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true });
		dispatchEvent(new PointerEvent("pointermove", at(0)));
		dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true }));
		for (let px = 1; px < 16; px++) dispatchEvent(new PointerEvent("pointermove", at(px)));
		await wait(300);
		const original = CanvasRenderingContext2D.prototype.getImageData;
		CanvasRenderingContext2D.prototype.getImageData = function (...args) {
			const image = original.apply(this, args);
			for (let i = 0; i < image.data.length; i += 4) { image.data[i] ^= 0x55; image.data[i + 1] ^= 0x33; image.data[i + 2] ^= 0x0f; }
			return image;
		};
		let after_blocked = 0;
		const put = main_ctx.putImageData.bind(main_ctx);
		main_ctx.putImageData = (image, ...rest) => { if (image.width === 1 && window.paint_hard_auto_copy.read_noise() === "blocked") after_blocked++; return put(image, ...rest); };
		for (let px = 16; px < 60; px++) { dispatchEvent(new PointerEvent("pointermove", at(px))); await wait(25); }
		dispatchEvent(new KeyboardEvent("keyup", { key: "m", code: "KeyM", bubbles: true }));
		await wait(1500);
		CanvasRenderingContext2D.prototype.getImageData = original;
		return { noise: window.paint_hard_auto_copy.read_noise(), after_blocked, status: $status_text.text() };
	});
	check("when reads turn blocked while M is held, M lets go, paints nothing more and says why", m_blocked.noise === "blocked" && m_blocked.after_blocked === 0 && m_blocked.status === `M stopped: ${BLOCKED}`, JSON.stringify(m_blocked));

	// 9. A browser that blocks canvas reads from the start, every read 16 levels off: the page finds it as it loads, and
	// auto copy and M say so rather than paint.
	await page("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
		const read = CanvasRenderingContext2D.prototype.getImageData;
		CanvasRenderingContext2D.prototype.getImageData = function (...args) {
			const image = read.apply(this, args);
			for (let i = 0; i < image.data.length; i += 4) image.data[i] ^= 16;
			return image;
		};
	})();` });
	await open_paint(ready);
	const blocked = await hook("read_noise");
	await stage([...color_items(254), ...SPEED, ...SURE], 30, 20);
	await shift_m();
	await sleep(1000);
	const refused = { running: (await hook("pass")).running, state: await state(), m: await press_m(5, 5) };
	check("with reads blocked from the start, the page finds it as it loads, and auto copy and M say so", blocked === "blocked" && !refused.running && refused.state === BLOCKED && refused.m === BLOCKED, JSON.stringify({ blocked, ...refused }));

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
