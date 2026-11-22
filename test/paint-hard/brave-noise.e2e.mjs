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
const SLOT_DATA = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 2, version: "1.0.0", trap_blacklist: [] };
const receive = (items) => evaluate(async (slot_data, items) => {
	const { fake_session } = await import("/src/archipelago.js");
	const { resize_canvas_without_saving_dimensions } = await import("/src/functions.js");
	const width = main_canvas.width, height = main_canvas.height;
	fake_session(slot_data, ["Magnifier", "Brush", ...items]);
	resize_canvas_without_saving_dimensions(width, height);
}, SLOT_DATA, items);
const tables = () => evaluate(() => { try { window.paint_hard_auto_copy.rounding_tables(); return "built"; } catch (error) { return `throws: ${error.message}`; } });
const state = () => evaluate(() => document.querySelector(".auto-copy-panel .window-content > div")?.textContent ?? null);
const true_px = (which, x, y) => evaluate((which, x, y) => Array.from(window.__brave_model.read(which === "goal" ? goal_ctx : main_ctx, x, y, 1, 1).data), which, x, y);
const focus_page = async () => { await mouse.click(5, 895); await sleep(100); };

try {
	await page("Page.addScriptToEvaluateOnNewDocument", { source: brave_noise_source(TOKEN) });
	await open_paint(() => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy);

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

	await receive([...color_items(10), ...SPEED]);
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

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
