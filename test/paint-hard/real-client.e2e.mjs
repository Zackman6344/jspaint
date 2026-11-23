// End-to-end test of Pain-T through its real Archipelago client: what reaches the server and what survives a dropped
// connection. Before the page loads, window.WebSocket is replaced by a stand-in for MultiServer that answers RoomInfo,
// GetDataPackage (built from the APWorld's items.py), Connect and Get, records LocationChecks, and can drop the
// connection; the page logs in through its own Connect button. Adapted from the Phase 3 review's harness.
// Usage: node test/paint-hard/real-client.e2e.mjs [--headful]. It reads items.py and test/client_contract.json from the
// APWorld checkout beside this one; set PAIN_T_ITEMS_PY and PAIN_T_CONTRACT to read them from elsewhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { miss_margin, miss_percent } from "../../src/misses.js";
import { check, evaluate, finish, mouse, open_paint, overclock_id, page, page_errors, sleep } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORLD = path.join(ROOT, "..", "paint-hard-apworld", "worlds", "paint_hard");
const ITEMS_PY = process.env.PAIN_T_ITEMS_PY || path.join(WORLD, "items.py");
// What the world writes for the client beyond items.py: each tool ladder's copies, the accuracy copies, the margin copies
// at the default miss_margin_step, and the slot data at the default options (its test_client_contract.py keeps the
// file true).
const CONTRACT_JSON = process.env.PAIN_T_CONTRACT || path.join(WORLD, "test", "client_contract.json");
const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_JSON, "utf8"));

// The item table, from items.py itself, so a name that differs between the two repos fails here.
const ITEMS = {};
for (const m of fs.readFileSync(ITEMS_PY, "utf8").matchAll(/^\s*"([^"]+)":\s*PaintItemData\((\d+),/gm)) ITEMS[m[1]] = Number(m[2]);
const id_of = (name) => { if (!(name in ITEMS)) throw new Error(`not in items.py: ${name}`); return ITEMS[name]; };

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
const LATE_ITEM = { item: id_of("Progressive Canvas Width"), location: 2199000 + 9000 + names.length, player: 1, flags: 0 };
const START_ITEMS = names.map((name, i) => ({ item: id_of(name), location: 2199000 + 9000 + i, player: 1, flags: 0 }));

// Locations as a default 800x600 seed has them: 18 early checks, 25 Matched Pixels, a check every 0.01% up to 80%.
const LOCATIONS = [];
for (let k = 1; k <= 18; k++) LOCATIONS.push(2198900 + k);
for (let n = 1; n <= 25; n++) LOCATIONS.push(2198950 + n);
for (let i = 1; i <= 8000; i++) LOCATIONS.push(2199000 + i);
// The world's own slot data at its defaults, with only what this test needs changed. Each changed key has to be one the
// world writes, so a rename on that side can't hide behind a value typed here. miss_margin_step is 5 rather than the
// default 1, so a client that read the key and went on at a step of 1 would show.
const OVERRIDES = { overclock_seconds: 2, miss_margin_step: 5, version: "1.0.0" };
const SLOT_DATA = { ...CONTRACT.slot_data, ...OVERRIDES };
const CONFIG = { seed: "SEED42", items: START_ITEMS, late_item: LATE_ITEM, locations: LOCATIONS, slot_data: SLOT_DATA, package: { checksum: "items-py", item_name_to_id: ITEMS, location_name_to_id: {} } };

// The stand-in server, in the page. It keeps what was checked in sessionStorage, so a reload sees it.
const FAKE_SERVER = `(() => {
	const CONFIG = ${JSON.stringify(CONFIG)};
	// The seconds the game's Overclock fillers have given, added up over every page's totals (auto-copy.js).
	window.spent_stored = () => Object.keys(localStorage).filter((key) => key.startsWith("pain-t-overclock-page:SEED42-0-1:")).reduce((sum, key) => sum + JSON.parse(localStorage.getItem(key)).spent, 0);
	const store = (() => { try { return JSON.parse(sessionStorage.getItem("fake-ap") || "null"); } catch { return null; } })() || { checked: [] };
	const save = () => { try { sessionStorage.setItem("fake-ap", JSON.stringify(store)); } catch { } };
	const ap = window.__ap = {
		log: [], sockets: [], received: 0,
		drop() { const s = ap.sockets.at(-1); if (s) s._drop(); },
		// One more item for this slot, as another player's check would send it.
		push(item = CONFIG.late_item.item) { const s = ap.sockets.at(-1); if (!s) return; s._reply([{ cmd: "ReceivedItems", index: ap.received, items: [{ ...CONFIG.late_item, item }] }]); ap.received++; },
	};
	class FakeWebSocket {
		constructor(url) {
			this.url = String(url); this.readyState = 0; ap.sockets.push(this);
			setTimeout(() => { this.readyState = 1; this.onopen?.({}); this._reply([{ cmd: "RoomInfo", version: { major: 0, minor: 6, build: 6, class: "Version" }, generator_version: { major: 0, minor: 6, build: 6, class: "Version" }, tags: [], password: false, permissions: { release: 2, collect: 2, remaining: 2 }, hint_cost: 10, location_check_points: 1, games: ["Archipelago", "Pain-T"], datapackage_checksums: { "Pain-T": CONFIG.package.checksum }, seed_name: CONFIG.seed, time: Date.now() / 1000 }]); }, 10);
		}
		send(text) {
			for (const p of JSON.parse(text)) {
				ap.log.push({ t: performance.now(), cmd: p.cmd, locations: p.locations, status: p.status });
				if (p.cmd === "GetDataPackage") this._reply([{ cmd: "DataPackage", data: { games: { "Pain-T": CONFIG.package } } }]);
				else if (p.cmd === "Connect") {
					const missing = CONFIG.locations.filter((id) => !store.checked.includes(id));
					this._reply([{ cmd: "Connected", team: 0, slot: 1, players: [{ team: 0, slot: 1, alias: p.name, name: p.name, class: "NetworkPlayer" }], missing_locations: missing, checked_locations: [...store.checked], slot_data: CONFIG.slot_data, slot_info: { 1: { name: p.name, game: "Pain-T", type: 1, group_members: [], class: "NetworkSlot" } }, hint_points: 0 }, { cmd: "ReceivedItems", index: 0, items: CONFIG.items }]);
					ap.received = CONFIG.items.length;
				} else if (p.cmd === "LocationChecks") {
					const fresh = p.locations.filter((id) => CONFIG.locations.includes(id) && !store.checked.includes(id));
					store.checked.push(...fresh); save();
					if (fresh.length) this._reply([{ cmd: "RoomUpdate", checked_locations: fresh }]);
				} else if (p.cmd === "Get") this._reply([{ cmd: "Retrieved", keys: Object.fromEntries(p.keys.map((k) => [k, k.startsWith("_read_hints") ? [] : null])) }]);
			}
		}
		close() { this.readyState = 3; }
		_reply(packets) { setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(packets) }); }, 2); }
		_drop() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1006 }); }
	}
	Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	window.WebSocket = FakeWebSocket;
})();`;

const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
const shift_m = async () => {
	for (const type of ["keyDown", "keyUp"]) await page("Input.dispatchKeyEvent", { type, key: "M", code: "KeyM", windowsVirtualKeyCode: 77, text: type === "keyDown" ? "M" : undefined, modifiers: 8 });
	await sleep(150);
};
const panel_text = () => evaluate(() => { const p = document.querySelector(".auto-copy-panel"); return p && p.offsetParent !== null ? p.querySelector(".window-content").innerText.replace(/\s+/g, " ").trim() : null; });
const session = () => evaluate(async () => (await import("/src/archipelago.js")).session_name());
const window_shown = () => evaluate(() => [...document.querySelectorAll(".window")].some((w) => /Archipelago Connection Options/.test(w.textContent) && w.offsetParent !== null));
const connect = async () => {
	await evaluate(() => { $("[name=aphost]").val("fake.test"); $("[name=apport]").val("38281"); $("[name=apslot]").val("Painter"); $("button").filter((i, b) => b.textContent === "Connect!").trigger("click"); });
	for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
	await sleep(500);
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
	await page("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_SERVER });
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
	const named = await evaluate(async () => {
		const ap = await import("/src/archipelago.js");
		const brush = [...document.querySelectorAll(".tool-options .chooser-option")].length;
		return { top: paint_hard_auto_copy.top_tier(), banked: paint_hard_auto_copy.overclock_banked(), sim: ap.mode_unlocked("Similarity"), diff: ap.mode_unlocked("Difference"), pick: !document.getElementById("TOOL_PICK_COLOR").classList.contains("disabled"), brush_rung: ap.rungs("Progressive Brush Size"), brush_box: brush, miss: paint_hard_auto_copy.miss_chance(), margin: paint_hard_auto_copy.miss_margin(), loop: paint_hard_auto_copy.loop() };
	});
	check("items.py's names reach the client: 10 speed tiers, 2 Overclocks (4 s), both views, Pick Color, a Brush Size", named.top === 10 && named.banked === 4 && named.sim && named.diff && named.pick && named.brush_rung === 1, JSON.stringify(named));
	// The world's miss_margin_step reaches the client too: one Progressive Miss Margin at step 5 takes 5 off 255.
	check("...and Phase 4's: the world's accuracy copies leave no misses, one margin copy at step 5 a margin of 250, and Auto Copy Loop is on", named.miss === 0 && named.margin === 250 && SLOT_DATA.miss_margin_step === 5 && named.loop, JSON.stringify({ miss: named.miss, margin: named.margin, loop: named.loop, miss_margin_step: SLOT_DATA.miss_margin_step }));
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
	// update() still scores the whole canvas on every packet, up to about 60 ms here, until task 7.2 limits it to a new
	// canvas size. Before the Phase 3 review's fix each packet also rebuilt the rounding tables, 300-400 ms at 8,000 items.
	let held = 0;
	for (let i = 0; i < 20 && held < names.length + 9; i++) {
		held = await evaluate(async () => (await import("/src/archipelago.js")).received().length);
		if (held < names.length + 9) await sleep(100);
	}
	check("...no task over 100 ms while it runs at 1,024 a second with 8,000 items and a packet a second", held >= names.length + 9 && run.long_tasks.every((t) => t.ms < 100), `${held} items; ${JSON.stringify(run.long_tasks)}`);
	check("...and a short start", run.first_long_tasks.every((t) => t.ms < 500), JSON.stringify(run.first_long_tasks));

	// The connection drops: the items stay with the client, and so does the session's name.
	await evaluate(() => __ap.drop());
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
	await shift_m(); // pause
	await page("Page.reload", {});
	await sleep(500);
	for (let i = 0; i < 200 && !(await evaluate(ready).catch(() => false)); i++) await sleep(100);
	await sleep(500);
	await overclock_id();
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

	check("no page errors", page_errors.length === 0, page_errors.slice(0, 5).join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
