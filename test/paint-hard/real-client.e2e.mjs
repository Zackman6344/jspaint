// End-to-end test of Pain-T through its real Archipelago client: what reaches the server and what survives a dropped
// connection, the goal among it. Before the page loads, window.WebSocket is replaced by a stand-in for MultiServer
// (stand-in-server.mjs), and the page logs in through its own Connect button. Last, the page logs in to a second seed,
// one with starting_color_depth 1, whose items come as a server sends start inventory and cheat items, for logic's
// ceiling.
// Usage: node test/paint-hard/real-client.e2e.mjs [--headful]. It reads items.py and test/client_contract.json from the
// APWorld checkout beside this one; set PAIN_T_ITEMS_PY and PAIN_T_CONTRACT to read them from elsewhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { miss_margin, miss_percent } from "../../src/misses.js";
import { add_init_script, check, evaluate, finish, keyboard, mouse, open_paint, page_errors, reload_paint, remove_init_script, same, sleep } from "./harness.mjs";
import { CONTRACT, CONTRACT_JSON, ITEMS, ITEMS_PY, LOCATIONS, connect, fake_server, id_of, window_shown } from "./stand-in-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOGIC = CONTRACT.logic;

const names = ["Magnifier", "Brush"];
for (let k = 0; k < 254; k++) names.push("Progressive Color Depth (Red)", "Progressive Color Depth (Green)", "Progressive Color Depth (Blue)");
names.push(...Array(8).fill("Progressive Canvas Width"), ...Array(6).fill("Progressive Canvas Height"));
names.push(...Array(10).fill("Progressive Auto Copy Speed"), "Overclock", "Overclock", "Progressive Similarity Mode", "Progressive Difference Mode", "Progressive Pick Color");
names.push("Progressive Brush Size"); // D24's names come through too
// Phase 4's (D7): every accuracy copy the world makes, so auto copy never misses and the checks below go out as before,
// one margin copy, and Auto Copy Loop, so it runs pass after pass.
names.push(...Array(CONTRACT.accuracy_items).fill("Progressive Auto Copy Accuracy"), "Progressive Miss Margin", "Auto Copy Loop");
// Late in a default solo seed the client holds about 8,000 items. Canvas items past the goal's size change nothing.
names.push(...Array(7200).fill("Progressive Canvas Width"));
// Each item's flags as the world classifies it at the defaults (D8): progression (1) for the color and canvas items,
// Pick Color's first copy, every accuracy copy and the 8 speed copies that can still raise logic's cap at 6 h; filler
// (0) for Overclock; useful (2) for the rest, the 2 other speed copies among them.
const PROGRESSION = new Set(["Progressive Color Depth (Red)", "Progressive Color Depth (Green)", "Progressive Color Depth (Blue)", "Progressive Canvas Width", "Progressive Canvas Height", "Progressive Pick Color", "Progressive Auto Copy Accuracy"]);
let speed_copies = 0;
const flags_of = (name) => (name === "Overclock" ? 0 : name === "Progressive Auto Copy Speed" ? (++speed_copies <= LOGIC.speed_progression ? 1 : 2) : PROGRESSION.has(name) ? 1 : 2);
const LATE_ITEM = { item: id_of("Progressive Canvas Width"), location: 2199000 + 9000 + names.length, player: 1, flags: 1 };
const START_ITEMS = names.map((name, i) => ({ item: id_of(name), location: 2199000 + 9000 + i, player: 1, flags: flags_of(name) }));

// The world's own slot data at its defaults, with only what this test needs changed. Each changed key has to be one the
// world writes, so a rename on that side can't hide behind a value typed here. miss_margin_step is 5 rather than the
// default 1, so a client that read the key and went on at a step of 1 would show. The version is the world's, 1.1.0
// from Phase 5 on, which the contract leaves out.
const OVERRIDES = { overclock_seconds: 2, miss_margin_step: 5, version: "1.1.0" };
const SLOT_DATA = { ...CONTRACT.slot_data, ...OVERRIDES };
const CONFIG = { seed: "SEED42", items: START_ITEMS, late_item: LATE_ITEM, locations: LOCATIONS, slot_data: SLOT_DATA, package: { checksum: "items-py", item_name_to_id: ITEMS, location_name_to_id: {} } };
// The second seed: the world's slot data and start inventory for starting_color_depth 1, the inventory as
// MultiServer.py:545 sends it, at location -2 from player 0 with flags 0.
const START_SLOT_DATA = { ...CONTRACT.slot_data, ...LOGIC.slot_data_changes.starting_color_depth_1, version: OVERRIDES.version };
const START_INVENTORY = LOGIC.start_inventory.map((name) => ({ item: id_of(name), location: -2, player: 0, flags: 0 }));
const START_CONFIG = { ...CONFIG, seed: "SEED43", items: START_INVENTORY, slot_data: START_SLOT_DATA };

const FAKE_SERVER = fake_server(CONFIG);

const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
const shift_m = async () => {
	await keyboard.press("m", ["Shift"]);
	await sleep(50);
};
const panel_text = () => evaluate(() => { const p = document.querySelector(".auto-copy-panel"); return p && p.offsetParent !== null ? p.querySelector(".window-content").innerText.replace(/\s+/g, " ").trim() : null; });
const session = () => evaluate(async () => (await import("/src/archipelago.js")).session_name());

// Logic's ceiling in the second seed. What the client holds of each item the ceiling reads, in this order, how many of
// each it counts, and the ceiling.
const LOGIC_NAMES = ["Progressive Color Depth (Red)", "Progressive Color Depth (Green)", "Progressive Color Depth (Blue)", "Progressive Canvas Width", "Progressive Canvas Height", "Progressive Auto Copy Speed", "Progressive Auto Copy Accuracy", "Progressive Pick Color"];
const logic_now = () => evaluate(async (names) => {
	const ap = await import("/src/archipelago.js");
	return { session: ap.session_name(), held: names.map((name) => ap.rungs(name)).join(","), counted: names.map((name) => ap.progression_rungs(name)).join(","), ceiling: (await import("/src/functions.js")).calculate_logic_similarity() };
}, LOGIC_NAMES);
// The world's ceiling at the defaults' hours for a state, (color items in each channel, width and height items, speed
// and accuracy copies logic counts, Pick Color): test_auto_copy_logic.py's, or the world's own at the contract's more
// states.
const world_ceiling = (state) => {
	const at = (states) => states.findIndex((s) => JSON.stringify(s) === JSON.stringify(state));
	if (at(LOGIC.states) >= 0) return LOGIC.ceilings[START_SLOT_DATA.auto_copy_logic_hours][at(LOGIC.states)];
	if (at(LOGIC.more_states) >= 0) return LOGIC.more_ceilings[at(LOGIC.more_states)];
	throw new Error(`the contract has no ceiling at ${JSON.stringify(state)}`);
};
const close = (a, b) => Math.abs(a - b) < 5e-7; // the world rounds to 6 decimals
// Found items as the server sends them: from this slot, each at a location of its own, with flags 1 for progression
// and 2 for useful, as the world classifies them.
let found_at = 2199000 + 20000;
const found = (name, n, flags = 1) => Array.from({ length: n }, () => ({ item: id_of(name), location: found_at++, player: 1, flags }));
// Sends items in one packet and waits until the client holds them.
const received_count = () => evaluate(async () => (await import("/src/archipelago.js")).received().length);
const give = async (items) => {
	const want = (await received_count()) + items.length;
	await evaluate((items) => __ap.give(items), items);
	for (let i = 0; i < 50 && (await received_count()) < want; i++) await sleep(100);
};

// Every item the client spells out in quotes: the ladders, the speed copies, the Overclock bank. The other e2e tests type
// these by hand, so this is what catches a rename in one repo and not the other. Every slot data key the client reads,
// too: a flag the world renames would otherwise turn its feature off without a word. canvas_size_increment is the one
// key only older seeds wrote, read as a fallback. Every other mention of slotData has to be an import, the export, the
// declaration or an assignment, so a read the scan can't name fails: destructured, with a computed key, split across
// lines, or through another name.
const SPELLED = new Set(), READ_KEYS = new Set(), UNNAMED_READS = [];
const NAMED_READ = /^slotData(?:\?\.|\.)([A-Za-z_$][\w$]*)|^slotData(?:\?\.)?\[\s*(["'])([^"']+)\2\s*\]/;
const NOT_A_READ = /^(?:import \{[^}]*\} from "\.\/archipelago\.js";|export \{[^}]*\};|var slotData = \{\};|slotData = [\w$]+;)$/;
for (const file of fs.readdirSync(path.join(ROOT, "src")).filter((name) => name.endsWith(".js"))) {
	const source = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
	for (const m of source.matchAll(/"(Progressive [A-Z][A-Za-z ()]+?)"/g)) SPELLED.add(m[1]);
	for (const m of source.matchAll(/\bcount_of\("([^"]+)"\)/g)) SPELLED.add(m[1]); // Auto Copy Loop and Overclock too
	for (const m of source.matchAll(/\bslotData\b/g)) {
		const read = source.slice(m.index).match(NAMED_READ);
		if (read) READ_KEYS.add(read[1] ?? read[3]);
		else {
			const line = source.slice(source.lastIndexOf("\n", m.index) + 1).split("\n")[0].trim();
			if (!NOT_A_READ.test(line)) UNNAMED_READS.push(`${file}: ${line}`);
		}
	}
}
const OLDER_SEEDS_ONLY = ["canvas_size_increment"];

try {
	const unknown = [...SPELLED].filter((name) => !(name in ITEMS));
	check("every item the client names is in items.py", SPELLED.size >= 15 && unknown.length === 0, unknown.length ? `not in items.py: ${unknown.join(", ")}` : `${SPELLED.size} names`);
	// The client's miss model against the copies the world makes: its last accuracy copy ends misses, and one fewer leaves
	// 10%; its last margin copy at its default step brings the margin to 0, and one fewer doesn't.
	const accuracy = CONTRACT.accuracy_items, margin_items = CONTRACT.miss_margin_items, step = CONTRACT.slot_data.miss_margin_step;
	check("the world's last accuracy copy ends misses and its last margin copy brings the margin to 0, each in the client's model", miss_percent(accuracy) === 0 && miss_percent(accuracy - 1) === 10 && miss_margin(margin_items, step) === 0 && miss_margin(margin_items - 1, step) > 0, JSON.stringify({ accuracy, margin_items, step, chance_one_short: miss_percent(accuracy - 1), margin_at_last: miss_margin(margin_items, step), margin_one_short: miss_margin(margin_items - 1, step) }));
	const not_written = Object.keys(OVERRIDES).filter((key) => !CONTRACT.slot_data_keys.includes(key));
	check("the slot data is the world's own, and every key this test changes is one it writes", not_written.length === 0 && Object.keys(CONTRACT.tool_ladders).length === 9, not_written.length ? `not written: ${not_written.join(", ")}` : `${CONTRACT.slot_data_keys.length} keys from ${CONTRACT_JSON}`);
	const unread = [...READ_KEYS].filter((key) => !CONTRACT.slot_data_keys.includes(key) && !OLDER_SEEDS_ONLY.includes(key));
	const from_today = [...READ_KEYS].filter((key) => !OLDER_SEEDS_ONLY.includes(key));
	check("every slot data key the client reads is one the world writes", READ_KEYS.size >= 15 && unread.length === 0 && UNNAMED_READS.length === 0, unread.length ? `not written: ${unread.join(", ")}` : UNNAMED_READS.length ? `reads the scan can't name: ${UNNAMED_READS.join("; ")}` : `${from_today.length} keys read from today's seeds, and ${OLDER_SEEDS_ONLY.length} only older seeds wrote`);
	const first_server = await add_init_script(FAKE_SERVER);
	await open_paint(ready, { hide_connection_window: false });
	check("items.py has the names this test sends", names.every((name) => name in ITEMS), `${Object.keys(ITEMS).length} items read from ${ITEMS_PY}`);
	check("before connecting, the session is offline", (await session()) === "offline", await session());
	// With no slot data yet the page counts as a new seed with no items, not as one from before Phase 4.
	const unconnected = await evaluate(() => ({ miss: paint_hard_auto_copy.miss_chance(), margin: paint_hard_auto_copy.miss_margin(), loop: paint_hard_auto_copy.loop() }));
	check("...and auto copy would miss 90% at margin 255, with no Loop", unconnected.miss === 90 && unconnected.margin === 255 && !unconnected.loop, JSON.stringify(unconnected));
	await connect();
	const size = await evaluate(() => `${main_canvas.width}x${main_canvas.height}`);
	check("the page logs in through its own Connect button", !(await window_shown()) && size === "800x600", size);
	check("...and names the session seed-team-slot", (await session()) === "SEED42-0-1", await session());
	const version_line = await evaluate(() => $("#appaint-version").text().trim());
	check(`...and shows the APWorld version the slot data names, ${SLOT_DATA.version}`, version_line === `APWorld Version ${SLOT_DATA.version}`, version_line);
	const named = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		const brush = [...document.querySelectorAll(".tool-options .chooser-option")].length;
		return { top: paint_hard_auto_copy.top_tier(), banked: paint_hard_auto_copy.overclock_banked(), sim: ap.mode_unlocked("Similarity"), diff: ap.mode_unlocked("Difference"), pick: !document.getElementById("TOOL_PICK_COLOR").classList.contains("disabled"), brush_rung: ap.rungs("Progressive Brush Size"), brush_box: brush, miss: paint_hard_auto_copy.miss_chance(), margin: paint_hard_auto_copy.miss_margin(), loop: paint_hard_auto_copy.loop() };
	});
	check("items.py's names reach the client: 10 speed tiers, 2 Overclocks (4 s), both views, Pick Color, a Brush Size", named.top === 10 && named.banked === 4 && named.sim && named.diff && named.pick && named.brush_rung === 1, JSON.stringify(named));
	// The world's miss_margin_step reaches the client too: one Progressive Miss Margin at step 5 takes 5 off 255.
	check("...and Phase 4's: the world's accuracy copies leave no misses, one margin copy at step 5 a margin of 250, and Auto Copy Loop is on", named.miss === 0 && named.margin === 250 && SLOT_DATA.miss_margin_step === 5 && named.loop, JSON.stringify({ miss: named.miss, margin: named.margin, loop: named.loop, miss_margin_step: SLOT_DATA.miss_margin_step }));
	// Logic (D8) counts a found copy only when the server marks it progression: 8 of the 10 speed copies. With every item
	// its ceiling is the whole logic percent, since 8 copies get all 480,000 pixels right in the world's 6 h, and so would
	// 10. The second seed below checks the ceiling where the useful copies would raise it.
	const logic = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		return { speed: ap.rungs("Progressive Auto Copy Speed"), counted: ap.progression_rungs("Progressive Auto Copy Speed"), ceiling: (await import("/src/functions.js")).calculate_logic_similarity() };
	});
	check("...and logic counts only the found copies marked progression, 8 of 10 speed copies, and with every item its ceiling is the whole logic percent", logic.speed === 10 && logic.counted === LOGIC.speed_progression && Math.abs(logic.ceiling - SLOT_DATA.logic_percent) < 1e-9 && SLOT_DATA.auto_copy_logic_hours === 6, JSON.stringify({ ...logic, hours: SLOT_DATA.auto_copy_logic_hours }));
	for (let i = 0; i < 50 && !(await evaluate(() => goal_ctx.getImageData(400, 300, 1, 1).data[3] === 255)); i++) await sleep(100);

	// Auto copy at the top speed, connected: what goes out, and how often.
	await mouse.click(5, 895);
	await sleep(100);
	await evaluate(() => {
		window.long_tasks = [];
		try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.long_tasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ type: "longtask" }); } catch { }
		__ap.log.length = 0;
	});
	await shift_m();
	const started_at = await evaluate(() => performance.now());
	for (let i = 0; i < 9; i++) { // a packet a second, as other players' checks bring items in
		await sleep(1000);
		await evaluate(() => __ap.push());
	}
	const run = await evaluate((started_at) => {
		const checks = __ap.log.filter((p) => p.cmd === "LocationChecks");
		const ids = checks.flatMap((p) => p.locations);
		const gaps = checks.slice(1).map((p, i) => Math.round(p.t - checks[i].t));
		return { packets: checks.length, ids: ids.length, unique: new Set(ids).size, matched: ids.filter((id) => id > 2198950 && id <= 2198975).length, early: ids.filter((id) => id > 2198900 && id <= 2198918).length, gaps, long_tasks: window.long_tasks.filter((t) => t.at > started_at + 1500), first_long_tasks: window.long_tasks.filter((t) => t.at <= started_at + 1500), spent: spent_stored() };
	}, started_at);
	check("auto copy sends checks through the real client: all 18 early checks and 25 Matched Pixels", run.early === 18 && run.matched === 25, `${run.packets} LocationChecks, ${run.ids} IDs, early ${run.early}, matched ${run.matched}`);
	check("...no ID twice", run.unique === run.ids, `${run.unique} unique of ${run.ids}`);
	check("...at most one LocationChecks a second after the first", run.gaps.slice(1).every((g) => g >= 950), run.gaps.join(","));
	check("...the spent Overclock kept under the seed-team-slot key", run.spent >= 4 - 1e-6, String(run.spent));
	// Since task 7.2 a packet rescores only for a new canvas size, which scoring.e2e.mjs counts; before, each scored the
	// whole canvas, up to about 60 ms here. Before the Phase 3 review's fix each packet also rebuilt the rounding tables,
	// 300-400 ms at 8,000 items.
	let held = 0;
	for (let i = 0; i < 20 && held < names.length + 9; i++) {
		held = await evaluate(async () => (await import("/src/archipelago.js")).received().length);
		if (held < names.length + 9) await sleep(100);
	}
	check("...no task over 100 ms while it runs at 1,024 a second with 8,000 items and a packet a second", held >= names.length + 9 && run.long_tasks.every((t) => t.ms < 100), `${held} items; ${JSON.stringify(run.long_tasks)}`);
	check("...and a short start", run.first_long_tasks.every((t) => t.ms < 500), JSON.stringify(run.first_long_tasks));

	// The goal through a reconnect (R7): a login into the game the goal canvas was last cleared for, at the same goal size,
	// leaves the goal canvas and its read alone, and the goal image's load clears the goal canvas before it draws. Until the
	// reload below, the page's own handler for that load runs 150 ms late, as a slow load makes it, so a goal the login
	// cleared would stay blank that long, and auto copy would copy from it. The page logs each clear of the goal canvas,
	// each draw of the goal image, each 1x1 put that is black where the goal isn't, and each LocationChecks with what the
	// canvas had earned against the goal as it went out.
	const GOAL_HOLD = 150;
	await evaluate((hold) => {
		const real_get = CanvasRenderingContext2D.prototype.getImageData, real_put = CanvasRenderingContext2D.prototype.putImageData, real_draw = CanvasRenderingContext2D.prototype.drawImage;
		const watch = window.__goal_watch = { clears: [], draws: [], black: [], puts: [], sends: [] };
		// The goal the page holds, read again when the test draws another.
		watch.read_goal = () => { const { width, height } = goal_canvas; watch.goal = { width, height, data: real_get.call(goal_ctx, 0, 0, width, height).data }; };
		watch.read_goal();
		// What the canvas has earned against that goal, in 0.0001% units, by the formula of 0.5.0 and later.
		watch.earned = () => {
			const { width, height, data: g } = watch.goal, c = real_get.call(main_ctx, 0, 0, width, height).data;
			let sum = 0;
			for (let i = 0; i < g.length; i += 4) {
				const dr = c[i] - g[i], dg = c[i + 1] - g[i + 1], db = c[i + 2] - g[i + 2];
				sum += 2 * (1 - Math.sqrt((dr * dr + dg * dg + db * db) / 3) / 255) - 1;
			}
			return Math.floor(sum * 100 / (width * height) * 10000 + 1e-7);
		};
		const width_of = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width");
		Object.defineProperty(goal_canvas, "width", { configurable: true, get() { return width_of.get.call(this); }, set(value) { watch.clears.push(performance.now()); width_of.set.call(this, value); } });
		goal_ctx.drawImage = function (image, ...rest) { if (image instanceof HTMLImageElement) watch.draws.push(performance.now()); return real_draw.call(this, image, ...rest); };
		main_ctx.putImageData = function (image, x, y, ...rest) {
			if (image.width === 1 && image.height === 1) {
				const t = performance.now(), d = image.data, g = watch.goal.data, j = (y * watch.goal.width + x) * 4;
				watch.puts.push(t);
				if (watch.puts.length > 20000) watch.puts.splice(0, 10000);
				if (d[0] === 0 && d[1] === 0 && d[2] === 0 && (g[j] || g[j + 1] || g[j + 2])) watch.black.push(t);
			}
			return real_put.call(this, image, x, y, ...rest);
		};
		// Each connection's socket is of one class.
		const EARLY = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90];
		const socket = Object.getPrototypeOf(__ap.sockets.at(-1)), real_send = socket.send;
		socket.send = function (text) {
			for (const p of JSON.parse(text)) {
				if (p.cmd !== "LocationChecks") continue;
				const units = p.locations.map((id) => (id > 2198900 && id <= 2198918 ? EARLY[id - 2198901] : id > 2199000 ? (id - 2199000) * 100 : 0));
				watch.sends.push({ t: performance.now(), checks: p.locations.length, highest: Math.max(0, ...units), earned: watch.earned() });
			}
			return real_send.call(this, text);
		};
		const image = $goal_image[0], draw = image.onload;
		image.onload = function (event) { setTimeout(() => draw.call(this, event), hold); };
	}, GOAL_HOLD);
	// What the page logged since `mark`: the goal canvas's clears and the goal image's draws, the black puts, the puts made
	// after the goal drew, and the sends whose highest check passes what the canvas had earned.
	const goal_since = (mark) => evaluate((mark) => {
		const watch = window.__goal_watch, after = (list) => list.filter((entry) => (entry.t ?? entry) > mark);
		const clears = after(watch.clears), draws = after(watch.draws), sends = after(watch.sends);
		return { clears: clears.length, draws: draws.length, black: after(watch.black).length, puts_after_draw: draws.length ? after(watch.puts).filter((t) => t > draws[0]).length : 0, sends: sends.length, unearned: sends.filter((s) => s.highest > Math.max(0, s.earned)).map((s) => ({ checks: s.checks, highest: s.highest, earned: s.earned })).slice(0, 3) };
	}, mark);

	// The connection drops: the items stay with the client, and so does the session's name.
	const dropped_at = await evaluate(() => { const at = performance.now(); __ap.drop(); return at; });
	await sleep(2500);
	const dropped = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		return { session: ap.session_name(), banked: paint_hard_auto_copy.overclock_banked(), panel: document.querySelector(".auto-copy-panel .window-content").innerText.replace(/\s+/g, " ").trim() };
	});
	check("a dropped connection keeps the seed-team-slot name", dropped.session === "SEED42-0-1", dropped.session);
	check("...so the panel shows no Overclock banked: all 4 s were spent", dropped.banked === 0 && !/Overclock:/.test(dropped.panel), JSON.stringify(dropped));

	// Reconnect, then reload and reconnect: only new IDs go out, and the spent seconds come back from the key.
	await evaluate(() => { __ap.log.length = 0; });
	await connect();
	await sleep(2500);
	const back = await evaluate(() => ({ banked: paint_hard_auto_copy.overclock_banked(), resent: __ap.log.filter((p) => p.cmd === "LocationChecks").flatMap((p) => p.locations).filter((id) => id <= 2198975).length }));
	check("reconnecting sends no early check or Matched Pixel again, and keeps the spent seconds", back.resent === 0 && back.banked === 0, JSON.stringify(back));
	const reconnected = await goal_since(dropped_at);
	check("a reconnect into the same game leaves the goal as it was: with the goal's draw held 150 ms, auto copy paints no pixel black where the goal isn't, and goes on once the goal has drawn", reconnected.black === 0 && reconnected.draws >= 1 && reconnected.puts_after_draw > 0, JSON.stringify(reconnected));

	// The worst case, as UN2's verdict found it: a dark goal, drawn as one File > Open Goal Image brings, and the canvas
	// filled black as a player's dark base, which earns a good part of the goal. Auto copy is paused for the fill and runs
	// again without Loop right after it, which it starts at once, and the connection drops 2.5 s later, for 1.2 s. A tick
	// that read a blank goal would take every black pixel for done, run to its pass's end and score the whole canvas
	// against the blank goal there, which sends every check and the goal.
	if (await evaluate(() => window.paint_hard_auto_copy.running())) await shift_m(); // pause
	await evaluate(() => window.paint_hard_auto_copy.set_loop(false));
	// The dark goal, with its rows from `see_through` on at half alpha, as the goal image.
	const dark_goal = (see_through) => evaluate((see_through) => {
		const dark = document.createElement("canvas");
		dark.width = 800;
		dark.height = 600;
		const context = dark.getContext("2d"), image = context.createImageData(800, 600), d = image.data;
		for (let y = 0, i = 0; y < 600; y++) for (let x = 0; x < 800; x++, i += 4) d.set([20 + (x * 3 + y) % 60, 30 + (y * 2) % 50, 25 + (x + y * 3) % 70, y < see_through ? 255 : 128], i);
		context.putImageData(image, 0, 0);
		$goal_image.attr("src", dark.toDataURL("image/png"));
	}, see_through);
	await dark_goal(600);
	const dark_drawn = () => evaluate(() => { const [r, g, b] = goal_ctx.getImageData(400, 300, 1, 1).data; return r === 20 + (400 * 3 + 300) % 60 && g === 30 + (300 * 2) % 50 && b === 25 + (400 + 300 * 3) % 70; });
	for (let i = 0; i < 50 && !(await dark_drawn()); i++) await sleep(100);
	await sleep(300); // the new goal's rescore
	await evaluate(async () => {
		window.__goal_watch.read_goal();
		(await import("/src/functions.js")).undoable({ name: "Fill With Color" }, () => { main_ctx.fillStyle = "#000000"; main_ctx.fillRect(0, 0, main_canvas.width, main_canvas.height); });
	});
	await shift_m(); // run again
	await sleep(2500);
	const base = await evaluate(() => ({ running: window.paint_hard_auto_copy.running(), loop: window.paint_hard_auto_copy.loop(), earned: window.__goal_watch.earned() }));
	const dark_at = await evaluate(() => { const at = performance.now(); __ap.drop(); return at; });
	for (let i = 0; i < 50 && !(await window_shown()); i++) await sleep(100);
	await sleep(1200);
	await connect();
	await sleep(1500 + GOAL_HOLD);
	const dark = { ...(await goal_since(dark_at)), ...(await evaluate((mark) => ({ goal_sent: __ap.log.some((p) => p.cmd === "StatusUpdate" && p.status === 30 && p.t > mark), earned_now: window.__goal_watch.earned(), running: window.paint_hard_auto_copy.running() }), dark_at)) };
	check("...and with a dark goal and the canvas filled black, auto copy running without Loop sends no check through a reconnect that the canvas hasn't earned, and not the goal", base.running && !base.loop && base.earned > 0 && dark.unearned.length === 0 && !dark.goal_sent, JSON.stringify({ base, ...dark }));
	if (await evaluate(() => window.paint_hard_auto_copy.running())) await shift_m(); // pause
	// The same goal with its bottom 10 rows half see-through, through one more reconnect. Drawn over its own last draw,
	// a pixel at half alpha would come out at three quarters.
	const draws_before = await evaluate(() => window.__goal_watch.draws.length);
	await dark_goal(590);
	for (let i = 0; i < 50 && (await evaluate(() => window.__goal_watch.draws.length)) === draws_before; i++) await sleep(100);
	const alpha_now = () => evaluate(() => goal_ctx.getImageData(400, 595, 1, 1).data[3]);
	const first_drawn = await alpha_now();
	const see_through_at = await evaluate(() => { const at = performance.now(); __ap.drop(); return at; });
	for (let i = 0; i < 50 && !(await window_shown()); i++) await sleep(100);
	await sleep(300);
	await connect();
	await sleep(1000 + GOAL_HOLD);
	const redrawn = { first_drawn, draws: (await goal_since(see_through_at)).draws, alpha: await alpha_now() };
	check("...and the goal image's draw at the reconnect starts from a clear goal canvas: its half see-through rows stay at half alpha", redrawn.draws >= 1 && Math.abs(redrawn.alpha - 128) <= 1, JSON.stringify(redrawn));
	await reload_paint(ready, { hide_connection_window: false });
	await connect();
	const reloaded = await evaluate(() => ({ banked: paint_hard_auto_copy.overclock_banked(), key: spent_stored() }));
	check("after a reload and reconnect the spent seconds are restored", reloaded.banked === 0 && reloaded.key >= 4 - 1e-6, JSON.stringify(reloaded));

	// The Overclock bank's ladders arrive: it fills by the steps the world wrote, under the names it wrote them.
	await evaluate((ids) => { for (const id of ids) __ap.push(id); }, [id_of("Progressive Overclock Bank Size"), id_of("Progressive Overclock Fill Speed")]);
	await sleep(2500);
	const bank_a = await evaluate(() => paint_hard_auto_copy.overclock_bank());
	await sleep(2000);
	const bank_b = await evaluate(() => paint_hard_auto_copy.overclock_bank());
	check("one copy of each bank ladder fills the bank by the world's steps", bank_a.size === SLOT_DATA.overclock_bank_size_step && Math.abs(bank_a.per_second - SLOT_DATA.overclock_fill_speed_step / 60) < 1e-12 && bank_a.level > 0 && bank_b.level > bank_a.level, `${JSON.stringify(bank_a)} -> ${JSON.stringify(bank_b)}`);

	// Each tool ladder's rung list, in the client, against the world's copies: one copy short leaves the box's largest
	// option locked, and every copy opens it.
	const rungs = await evaluate(async (copies) => {
		const ts = await import("/src/tool-sizes.js");
		const ap = await import("/src/archipelago.js");
		const { tools } = await import("/src/tools.js");
		const box = (id) => tools.find((tool) => tool.id === id).$options;
		const largest = {
			"Progressive Brush Size": () => ts.brush_locked({ shape: "circle", size: 7 }),
			"Progressive Brush Shape": () => ts.brush_locked({ shape: "diagonal", size: 2 }),
			"Progressive Eraser Size": () => ts.eraser_locked(10),
			"Progressive Airbrush Size": () => ts.airbrush_locked(24),
			"Progressive Line Width": () => ts.stroke_locked(5),
			"Progressive Rectangle Fill": () => ts.fill_style_locked(box("TOOL_RECTANGLE"), { stroke: false, fill: true }),
			"Progressive Polygon Fill": () => ts.fill_style_locked(box("TOOL_POLYGON"), { stroke: false, fill: true }),
			"Progressive Ellipse Fill": () => ts.fill_style_locked(box("TOOL_ELLIPSE"), { stroke: false, fill: true }),
			"Progressive Rounded Rectangle Fill": () => ts.fill_style_locked(box("TOOL_ROUNDED_RECTANGLE"), { stroke: false, fill: true }),
		};
		const result = {};
		for (const [ladder, n] of Object.entries(copies)) {
			const at = (k) => { ts.set_tool_ladders((name) => (name === ladder ? k : 0), tools); return largest[ladder] ? largest[ladder]() : "no option"; };
			result[ladder] = { short: at(n - 1), every: at(n) };
		}
		ts.set_tool_ladders(ap.slotData.tool_ladders ? ap.rungs : null, tools); // back to the copies received
		return result;
	}, CONTRACT.tool_ladders);
	const off = Object.entries(rungs).filter(([, r]) => !r.short || r.every !== "").map(([ladder, r]) => `${ladder}: ${JSON.stringify(r)}`);
	check("each tool ladder's last copy opens its box's largest option, and not one copy sooner", Object.keys(rungs).length === 9 && off.length === 0, off.join("; ") || "all 9");

	// The second seed, with starting_color_depth 1: the page reloads and logs in to it. The world's state holds its start
	// inventory, Magnifier, the starting tool and a color item of each channel, which the server sends at location -2 with
	// flags 0. A !getitem width comes at location -1 from the slot itself, with flags 0 (MultiServer.py:1663), beside a
	// found height. Then every color and canvas item, Pick Color, 2 accuracy copies, and 5 speed copies, 3 progression and
	// 2 useful: the 3 get 51,840 pixels right in the world's 6 h, and the 5 would get 207,360. Last, the rest of the speed
	// and accuracy copies. The reloaded page restores SEED42's canvas, and the login into SEED43 leaves that session's
	// record as it is and goes on in a new one (task 7.5).
	await remove_init_script(first_server);
	await add_init_script(fake_server(START_CONFIG));
	await reload_paint(ready, { hide_connection_window: false });
	await connect();
	const start = await logic_now();
	check("start inventory, sent at location -2 with flags 0, counts toward logic's ceiling as the world counts it: the start of a seed with starting_color_depth 1", start.session === "SEED43-0-1" && same(LOGIC.start_inventory.slice(0, 2), ["Magnifier", "Brush"]) && start.counted === "1,1,1,0,0,0,0,0" && close(start.ceiling, world_ceiling([1, 0, 0, 0, 0, false])), JSON.stringify({ ...start, world: world_ceiling([1, 0, 0, 0, 0, false]), start_inventory: LOGIC.start_inventory }));
	await give([{ item: id_of("Progressive Canvas Width"), location: -1, player: 1, flags: 0 }, ...found("Progressive Canvas Height", 1)]);
	const cheat = await logic_now();
	check("...and so does a cheat item, sent at location -1 with flags 0, beside a found copy marked progression", cheat.counted === "1,1,1,1,1,0,0,0" && close(cheat.ceiling, world_ceiling([1, 1, 1, 0, 0, false])), JSON.stringify({ ...cheat, world: world_ceiling([1, 1, 1, 0, 0, false]) }));
	const colors = START_SLOT_DATA.shade_counts.length - 1; // color items in each channel, the start's among them
	const widths = Math.ceil((START_SLOT_DATA.final_width - START_SLOT_DATA.start_width) / START_SLOT_DATA.canvas_width_increment);
	const heights = Math.ceil((START_SLOT_DATA.final_height - START_SLOT_DATA.start_height) / START_SLOT_DATA.canvas_height_increment);
	const useful_speed = START_SLOT_DATA.auto_copy_speed_items - LOGIC.speed_progression;
	await give([...["Red", "Green", "Blue"].flatMap((channel) => found(`Progressive Color Depth (${channel})`, colors - 1)), ...found("Progressive Canvas Width", widths - 1), ...found("Progressive Canvas Height", heights - 1), ...found("Progressive Pick Color", 1), ...found("Progressive Auto Copy Accuracy", 2), ...found("Progressive Auto Copy Speed", 3), ...found("Progressive Auto Copy Speed", useful_speed, 2)]);
	const useful = await logic_now(), useful_state = [colors, widths, heights, 3, 2, true];
	check(`...and a speed copy marked useful doesn't count: with 3 progression and ${useful_speed} useful speed copies and 2 accuracy copies the ceiling is the world's for the 3`, useful_speed > 0 && useful.held.split(",")[5] === String(3 + useful_speed) && useful.counted === `${colors},${colors},${colors},${widths},${heights},3,2,1` && close(useful.ceiling, world_ceiling(useful_state)), JSON.stringify({ ...useful, world: world_ceiling(useful_state) }));
	await give([...found("Progressive Auto Copy Speed", LOGIC.speed_progression - 3), ...found("Progressive Auto Copy Accuracy", LOGIC.accuracy_progression - 2), ...found("Progressive Auto Copy Accuracy", CONTRACT.accuracy_items - LOGIC.accuracy_progression, 2)]);
	const every = await logic_now();
	check("...and with every copy the ceiling reads, the start's color items among them, the ceiling is the whole logic percent", every.counted === `${colors},${colors},${colors},${widths},${heights},${LOGIC.speed_progression},${LOGIC.accuracy_progression},1` && Math.abs(every.ceiling - START_SLOT_DATA.logic_percent) < 1e-9, JSON.stringify({ ...every, logic_percent: START_SLOT_DATA.logic_percent }));

	check("no page errors", page_errors.length === 0, page_errors.slice(0, 5).join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
