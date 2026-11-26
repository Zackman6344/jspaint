// A smoke test of the harness in each browser it drives (Phase 7, stage S4): Chrome, Edge and Brave over the DevTools
// Protocol, Firefox over WebDriver BiDi. Paint opens, a stand-in game draws its goal, and M copies pixels under the points
// point_on() aims at: pixel centers in Chromium, whole-number points in Firefox, which delivers no other. The canvas reads
// back, and a reload keeps it. A mouse at whole-number points, as at display scaling 100%, reaches every pixel of the
// canvas for a click, an M press and a selection's grab. The harness's helpers work alike in each browser: init
// scripts, a tab in the background, persistent storage, page errors. The look-up of the browser's processes takes only
// the run's own. A dialog, a closed tab, a call that never answers and a page that doesn't leave its document each end
// in an error, where a suite would wait without end. The two origins serve the client and a folder of the run's own,
// with and without CORS, with delays, statuses, cache times, uploads and request counts, streaming what they serve.
// They go on after a request they can't read or fail on, and refuse another site's.
// Last, the browser closes with every process it started, and calls to it fail at once.
// Usage: node test/paint-hard/smoke.e2e.mjs [--browser=chrome|edge|brave|firefox] [--headful]. PAIN_T_BROWSER picks the
// browser too, and PAIN_T_TMP the folder its profile and the run's files go in.
import child_process from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN, SECOND_ORIGIN, TEST_FILES, add_init_script, browser_processes, check, chromium, close_browser, close_tab, evaluate, finish, firefox, grant_persistent_storage, keyboard, limits, mouse, new_tab, open_paint, page, page_errors, point_on, reload_paint, remove_init_script, request_count, requests, sleep, version } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// The browser this run was asked for, read here rather than from the harness.
const at = process.argv.findIndex((arg) => arg === "--browser" || arg.startsWith("--browser="));
const ASKED = ((at < 0 ? null : process.argv[at].startsWith("--browser=") ? process.argv[at].slice("--browser=".length) : process.argv[at + 1]) || process.env.PAIN_T_BROWSER || "chrome").toLowerCase();
const PRODUCT = { chrome: /^(Headless)?Chrome\//, edge: /^Edg\//, brave: /^(Headless)?Chrome\//, firefox: /^Firefox\// }[ASKED];
const AGENT = { chrome: /Chrome\/(?!.*Edg\/)/, edge: /Edg\//, brave: /Chrome\/(?!.*Edg\/)/, firefox: /Firefox\// }[ASKED];
const TMP = path.resolve(process.env.PAIN_T_TMP || os.tmpdir());

const FULL_COLOR = [];
for (const channel of ["Red", "Green", "Blue"]) for (let k = 0; k < 254; k++) FULL_COLOR.push(`Progressive Color Depth (${channel})`);
const ITEMS = ["Magnifier", "Brush", ...FULL_COLOR, ...Array(10).fill("Progressive Auto Copy Speed"), ...Array(9).fill("Progressive Auto Copy Accuracy"), "Auto Copy Loop"];
const SLOT_DATA = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 2, miss_margin_step: 1, version: "1.0.0", trap_blacklist: [] };
const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const canvas_px = (x, y) => evaluate((x, y) => Array.from(main_ctx.getImageData(x, y, 1, 1).data), x, y);
// What M puts in canvas pixel (x, y): the goal pixel there, rounded as Pick Color rounds it.
const wanted = (x, y) => evaluate(async (x, y) => {
	const { legalizeColor } = await import("/src/$ColorBox.js");
	const [r, g, b, a] = goal_ctx.getImageData(x, y, 1, 1).data;
	return legalizeColor(`rgba(${r},${g},${b},${a / 255})`).match(/\d+/g).map(Number).concat(255);
}, x, y);
const is_white = (px) => px.every((v) => v === 255);
const session_now = () => evaluate(() => ({ id: window.paint_hard_session?.id ?? null, size: `${main_canvas.width}x${main_canvas.height}`, digest: (() => { const data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data; let h = 2166136261; for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); })() }));
const focus_page = async () => { await mouse.click(5, 895); await sleep(100); };
// What a call came to within `ms`: its value, "refused: <why>", or "no answer in <s> s".
const within = (promise, ms) => Promise.race([promise.then((value) => value, (error) => `refused: ${String(error?.message ?? error).split("\n")[0]}`), sleep(ms).then(() => `no answer in ${ms / 1000} s`)]);
// One request from Node to the main origin, with headers of its own if any: the status answered, or the error.
const status_of = (pathname, method = "GET", body = null, headers = {}) => new Promise((resolve) => {
	const request = http.request(`${ORIGIN}${pathname}`, { method, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
	request.on("error", (error) => resolve(String(error)));
	request.end(body ?? undefined);
});
// The harness's look-up of the browser's processes, with Windows' answer changed by `plant` on its way back.
const look_up_with = (plant) => {
	const real = child_process.execFileSync;
	child_process.execFileSync = function (file, args, options) {
		const answer = real.call(this, file, args, options);
		if (!/powershell/i.test(String(file))) return answer;
		try { return JSON.stringify(plant([].concat(JSON.parse(answer)))); } catch { return answer; }
	};
	syncBuiltinESMExports();
	try { return browser_processes(); } finally { child_process.execFileSync = real; syncBuiltinESMExports(); }
};
// Holds the page's session behind its Web Lock until the test lets go: the browser grants the lock at once, and the
// page hears of it only then, so its restore stays unsettled.
const HOLD_RESTORE = `(() => {
	const request = navigator.locks.request.bind(navigator.locks);
	const let_go = new Promise((resolve) => { window.__smoke_let_go = resolve; });
	navigator.locks.request = (name, ...rest) => {
		const granted = rest.pop();
		return request(name, ...rest, /^pain-t-session:/.test(name) ? (lock) => let_go.then(() => granted(lock)) : granted);
	};
})();`;

try {
	// 1. The browser asked for, with its profile and the run's files under PAIN_T_TMP, as Windows sees its processes.
	await open_paint(ready);
	const agent = await evaluate(() => navigator.userAgent);
	check(`the browser is the one asked for, ${ASKED}, by its own version and the page's user agent`, PRODUCT.test(version()) && AGENT.test(agent), `${version()}; ${agent}`);
	const processes = browser_processes();
	const profile = processes.map((p) => p.command_line.match(/(?:--user-data-dir=|-profile )"?(.*?pain-t-e2e-[A-Za-z0-9]{6})/)?.[1]).find(Boolean) ?? null;
	check(`its profile and the files the run serves sit under PAIN_T_TMP, ${TMP}`, !!profile && path.resolve(profile).startsWith(TMP + path.sep) && TEST_FILES.startsWith(TMP + path.sep), JSON.stringify({ processes: processes.length, profile, files: TEST_FILES, spawned_by_this_run: processes.some((p) => p.parent === process.pid) }));
	const opened = await evaluate(() => ({ size: `${main_canvas.width}x${main_canvas.height}`, id: window.paint_hard_session?.id ?? null, page: [innerWidth, innerHeight] }));
	check("Paint opens at 800x600 in a 1400x900 page, under a #local: id of its own", opened.size === "800x600" && !!opened.id && opened.page[0] === 1400 && opened.page[1] === 900, JSON.stringify(opened));

	// 2. The look-up takes a process for the run's by its profile, a whole folder name in any letter case, or by a parent
	// in the run that Windows made before it: a PID alone goes to a new process once its own has gone. Windows' answer
	// gets five more entries here, under PIDs no process has, since every PID is a multiple of 4. Two are the run's by
	// those rules. Three aren't: a copy of the run's first process under one of its children, so older than its parent;
	// a child of the first process with no creation time; and a process naming a folder that begins as the profile does.
	const first = processes.find((p) => !processes.some((q) => q.pid === p.parent)), child = processes.find((p) => p.parent === first?.pid);
	const TAKEN = { younger_child: 999999901, other_case: 999999902 }, LEFT = { older_than_its_parent: 999999903, no_creation_time: 999999905, longer_folder_name: 999999906 };
	const planted = look_up_with((all) => {
		const root = all.find((p) => p.ProcessId === first.pid);
		const newest = all.filter((p) => p.Created).map((p) => BigInt(p.Created)).reduce((a, b) => (a > b ? a : b));
		return [...all,
			{ ...root, ProcessId: TAKEN.younger_child, ParentProcessId: root.ProcessId, CommandLine: "x", Created: (newest + 1n).toString() },
			{ ...root, ProcessId: TAKEN.other_case, ParentProcessId: 0, CommandLine: root.CommandLine.toUpperCase() },
			{ ...root, ProcessId: LEFT.older_than_its_parent, ParentProcessId: child.pid, CommandLine: "x" },
			{ ...root, ProcessId: LEFT.no_creation_time, ParentProcessId: root.ProcessId, CommandLine: "x", Created: null },
			{ ...root, ProcessId: LEFT.longer_folder_name, ParentProcessId: 0, CommandLine: root.CommandLine.split(profile).join(`${profile}-kept`) },
		];
	}).map((p) => p.pid);
	const looked_up = { listed: processes.length, created: processes.every((p) => /^\d{17,19}$/.test(p.created ?? "")), taken: Object.keys(TAKEN).filter((name) => planted.includes(TAKEN[name])), left: Object.keys(LEFT).filter((name) => !planted.includes(LEFT[name])) };
	check("the look-up takes a process by the run's profile, in any letter case, or by a parent made before it, each with the time Windows made it", !!child && looked_up.created && looked_up.taken.length === 2 && looked_up.left.length === 3, JSON.stringify(looked_up));

	// 3. A stand-in game with every color, its goal drawn, the canvas at its 600x450 start, shown at magnification 1.
	await evaluate(async (slot, items) => {
		const { fake_session } = await import("/src/archipelago.js");
		fake_session(slot, items);
		const { width, height } = goal_canvas;
		const image = goal_ctx.createImageData(width, height); // no pixel of it white
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * width + x) * 4);
		goal_ctx.putImageData(image, 0, 0);
		$G.triggerHandler("save-goal");
		(await import("/src/functions.js")).set_magnification(1);
	}, SLOT_DATA, ITEMS);
	await sleep(300);
	await focus_page();

	// 4. Where point_on() aims along row 10, columns 40 to 130: at each pixel's center in Chromium, and in Firefox at a
	// whole-number point that Paint maps to the pixel. Paint maps a point with Math.floor((x - left) * pixels / width),
	// which gives each of these 91 columns such a point. Dividing before multiplying, as it did before, put the left
	// edges of 5 of them in the column before: 55 / 600 * 600 is 54.99999999999999.
	const unreachable = await evaluate(() => {
		const kept = window.canvas_bounding_client_rect, out = [];
		for (let x = 40; x <= 130; x++) {
			let reached = false;
			for (let p = Math.floor(kept.left + x) - 2; p <= Math.ceil(kept.left + x) + 2; p++) if (Math.floor((p - kept.left) * main_canvas.width / kept.width) === x) reached = true;
			if (!reached) out.push(x);
		}
		return out;
	});
	const aims = [];
	for (let x = 40; x <= 130; x++) {
		try {
			const p = await point_on("canvas", x, 10);
			aims.push({ x, whole: Number.isInteger(p.x) && Number.isInteger(p.y), center: p.x % 1 === 0.5 && p.y % 1 === 0.5 });
		} catch {
			aims.push({ x, refused: true });
		}
	}
	const refused = aims.filter((a) => a.refused).map((a) => a.x);
	const aimed = firefox ? aims.every((a) => a.refused || a.whole) && refused.join() === unreachable.join() && refused.length === 0 : aims.every((a) => a.center);
	check(`point_on() aims where Paint maps each pixel: ${firefox ? "at whole-number points, one for every column" : "at pixel centers, reaching every pixel"}`, aimed, JSON.stringify({ refused, unreachable_from_whole_points: unreachable, aimed: aims.filter((a) => !a.refused).length }));

	// 5. M copies the goal into the pixel aimed at and no other, at the canvas's corners and between them.
	const copies = [];
	for (const [x, y] of [[0, 0], [10, 10], [37, 12], [300, 200], [599, 449]]) {
		const p = await point_on("canvas", x, y);
		await mouse.move(p.x, p.y);
		await sleep(30);
		await keyboard.press("m");
		const beside = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < 600 && b < 450);
		const untouched = [];
		for (const [a, b] of beside) untouched.push(is_white(await canvas_px(a, b)));
		copies.push({ x, y, point: [p.x, p.y], copied: JSON.stringify(await canvas_px(x, y)) === JSON.stringify(await wanted(x, y)), untouched: untouched.every(Boolean) });
	}
	check("M copies the goal into the canvas pixel point_on() aims at, and no pixel beside it", copies.every((c) => c.copied && c.untouched) && (!firefox || copies.every((c) => c.point.every(Number.isInteger))), JSON.stringify(copies));

	// 6. Holding M over a row copies every pixel passed over, as one step, and Ctrl+Z takes the row back.
	const steps = () => evaluate(() => undos.length);
	const row_matches = () => evaluate(async () => {
		const { legalizeColor } = await import("/src/$ColorBox.js");
		let matched = 0, white = 0;
		for (let x = 20; x <= 219; x++) {
			const [r, g, b, a] = goal_ctx.getImageData(x, 100, 1, 1).data;
			const want = legalizeColor(`rgba(${r},${g},${b},${a / 255})`).match(/\d+/g).map(Number).concat(255);
			const got = main_ctx.getImageData(x, 100, 1, 1).data;
			if (want.every((v, i) => v === got[i])) matched++;
			if (got.every((v) => v === 255)) white++;
		}
		return { matched, white };
	});
	const from_steps = await steps();
	const a = await point_on("canvas", 20, 100), b = await point_on("canvas", 219, 100);
	await mouse.move(a.x, a.y);
	await keyboard.down("m");
	await mouse.move(b.x, b.y, 8);
	await sleep(700);
	await keyboard.up("m");
	await sleep(1200);
	const swept = { ...(await row_matches()), steps: (await steps()) - from_steps };
	check("holding M over row 100 copies every pixel passed over, 200 of them, as one undo step", swept.matched === 200 && swept.steps === 1, JSON.stringify(swept));
	await keyboard.press("z", ["Control"]);
	const undone = await row_matches();
	check("...and Ctrl+Z takes the row back to white", undone.white === 200, JSON.stringify(undone));

	// 7. A reload keeps the session: its id, and the canvas as painted, restored at its size.
	await sleep(500); // a save if one falls due, at play's 5 s pace; otherwise the reload brings the copy the page leaves
	const before_reload = await session_now();
	await reload_paint(ready);
	const after_reload = await session_now();
	check("a reload keeps the session: its #local: id, and the canvas read back as painted at its size", !!before_reload.id && after_reload.id === before_reload.id && after_reload.size === "600x450" && after_reload.digest === before_reload.digest, JSON.stringify({ before_reload, after_reload }));

	// 8. An init script runs before Paint's own scripts at each load, its var a global as in a page's script, until
	// removed; a tab of its own opens in the background without it. A navigation that doesn't leave the tab's document,
	// here to the address it has, fragment and all, throws at the harness's limit, 2 s here: a test that went on would
	// read the page it meant to leave. A call that waits on the tab as it closes is refused, and so is one sent at once
	// after the close. Chromium by itself never answers the first, and left the second unanswered in 2 of 6 tries.
	const script = await add_init_script(`var smoke_global = "a var"; window.smoke_init = { before_paint: typeof jQuery === "undefined", runs: (window.smoke_init?.runs ?? 0) + 1 };`);
	await reload_paint(ready);
	const with_script = await evaluate(() => ({ init: window.smoke_init ?? null, global: typeof smoke_global === "string" ? smoke_global : null }));
	const tab = await new_tab();
	await tab.open();
	let in_tab = null;
	for (let i = 0; i < 100; i++) {
		in_tab = await tab.evaluate(() => ({ paint: typeof main_canvas !== "undefined" && main_canvas.width > 0, hidden: document.hidden, init: window.smoke_init ?? null })).catch(() => null);
		if (in_tab?.paint) break;
		await sleep(100);
	}
	const page_shown = await evaluate(() => !document.hidden);
	const tab_address = await tab.evaluate(() => location.href).catch(() => null);
	const usual_leave = limits.leave;
	limits.leave = 2000;
	const stayed = { address: tab_address, open: await tab.open(tab_address ?? undefined).then(() => "returned", (error) => error.message) };
	limits.leave = usual_leave;
	const tab_waiting = within(tab.evaluate(() => new Promise(() => { })), 6000);
	await sleep(150);
	await close_tab(tab);
	const tab_at_once = within(tab.evaluate(() => "answered"), 6000);
	const tab_calls = { waiting_as_it_closed: await tab_waiting, sent_at_once: await tab_at_once };
	const tab_gone = tab_calls.waiting_as_it_closed.startsWith("refused") && tab_calls.sent_at_once.startsWith("refused");
	await remove_init_script(script);
	await reload_paint(ready);
	const without_script = await evaluate(() => ({ init: window.smoke_init ?? null, global: typeof smoke_global === "string" ? smoke_global : null }));
	check("an init script runs before Paint's own scripts after a reload, its var declarations globals as in a page's script", with_script.init?.before_paint === true && with_script.init.runs === 1 && with_script.global === "a var", JSON.stringify(with_script));
	check("...and once removed, runs no more", without_script.init === null && without_script.global === null, JSON.stringify(without_script));
	check("a new tab opens Paint in the background, hidden, with the page still in front", in_tab?.paint === true && in_tab.hidden === true && page_shown, JSON.stringify({ in_tab, page_shown }));
	check("...without the page's init scripts, and closes: a call waiting on it and one sent at once after are refused", in_tab?.init === null && tab_gone, JSON.stringify({ init: in_tab?.init, ...tab_calls }));
	check("a navigation that doesn't leave its document throws at the harness's limit, 2 s here", /#local:/.test(stayed.address ?? "") && /didn't leave its document within 2 s/.test(stayed.open), JSON.stringify(stayed));

	// 9. open_paint() returns once the session's first restore has landed or failed. Until then the page holds its saves
	// and leaves no copy of the canvas as it goes, so what a test painted would be lost at a reload. The restore is held
	// behind its Web Lock here: 4 s on, open_paint() still waits, and it returns once the test lets go.
	const hold = await add_init_script(HOLD_RESTORE);
	let returned = false;
	const opening = open_paint(ready).then(() => { returned = true; }, (error) => error);
	await sleep(4000);
	const held = { returned, settled: await evaluate(() => window.paint_hard_session?.ready ?? null).catch(() => null) };
	await evaluate(() => window.__smoke_let_go());
	const failure = await opening;
	if (failure) throw failure;
	const let_go = await evaluate(() => window.paint_hard_session?.ready ?? null);
	await remove_init_script(hold);
	check("open_paint() waits for the session's first restore, held 4 s here, and returns once it has settled", held.returned === false && held.settled === false && let_go === true, JSON.stringify({ held, settled_at_its_return: let_go }));

	// 10. Persistent storage: not granted on a fresh profile, where Chromium answers false and Firefox asks and gets no
	// answer, and granted by the harness. Firefox's answer after the grant can be slow: past 5 s in 2 of 36 runs three
	// at a time, persisted() true by then. The grant changes that one permission: notifications, which a new profile
	// asks about, are still asked about after it.
	const persist_now = (ms) => evaluate((ms) => Promise.race([navigator.storage.persist().then(String), new Promise((resolve) => setTimeout(() => resolve(`no answer in ${ms / 1000} s`), ms))]), ms);
	const notifications = () => evaluate(() => navigator.permissions.query({ name: "notifications" }).then((status) => status.state, (error) => error.name));
	const persist_before = await persist_now(1000), notifications_before = await notifications();
	await grant_persistent_storage();
	const persisted = { before: persist_before, after: await persist_now(20000), persisted: await evaluate(() => navigator.storage.persisted()), notifications: [notifications_before, await notifications()] };
	check("persist() isn't granted at first, and answers true once the harness grants persistent storage", persisted.before !== "true" && persisted.after === "true" && persisted.persisted === true, JSON.stringify(persisted));
	check("...and the grant leaves the origin's other permissions as they were: notifications are still asked about", persisted.notifications.join() === "prompt,prompt", persisted.notifications.join());

	// 11. Page errors reach the test, thrown and rejected alike, all but Paint's own "not connected", which every stroke
	// throws without a server.
	const errors_from = page_errors.length;
	await evaluate(() => {
		setTimeout(() => { throw new Error("smoke: thrown"); }, 0);
		Promise.reject(new Error("smoke: rejected"));
		setTimeout(() => { throw new Error("Not connected (smoke)"); }, 0);
	});
	for (let i = 0; i < 30 && page_errors.slice(errors_from).filter((text) => /smoke:/.test(text)).length < 2; i++) await sleep(100);
	await sleep(300);
	const noted = page_errors.splice(errors_from);
	check("page errors reach the test, thrown and rejected alike, all but Paint's own \"not connected\"", noted.some((text) => /smoke: thrown/.test(text)) && noted.some((text) => /smoke: rejected/.test(text)) && !noted.some((text) => /\(smoke\)/.test(text)), JSON.stringify(noted.map((text) => text.split("\n")[0])));
	await evaluate(() => { for (const w of document.querySelectorAll(".window")) if (/Internal application error/.test(w.textContent)) w.querySelector(".window-close-button")?.click(); });

	// 12. A dialog the page opens is dismissed and reaches the test as a page error, and the page answers the next call.
	// Chromium holds a page at its dialog until the harness answers it: a suite would wait on that page without end.
	const dialogs_from = page_errors.length;
	await evaluate(() => { setTimeout(() => alert("smoke: a dialog"), 0); });
	await sleep(400);
	const after_dialog = await within(evaluate(() => 1 + 1), 6000);
	if (after_dialog !== 2 && chromium) await within(page("Page.handleJavaScriptDialog", { accept: true }), 3000); // so the run goes on
	const dialogs = page_errors.splice(dialogs_from);
	check("a dialog the page opens is dismissed and noted as a page error, and the page answers the next call", after_dialog === 2 && dialogs.length === 1 && dialogs[0] === "a dialog opened (alert): smoke: a dialog", JSON.stringify({ after_dialog, dialogs }));

	// 13. No call waits longer than the harness's limit for its answer, 2 s here and 120 s in a suite: a promise that
	// never settles is refused at it, and the next call answers.
	const usual_limit = limits.call;
	limits.call = 2000;
	const never_began = Date.now();
	const never = { call: await within(evaluate(() => new Promise(() => { })), 8000), ms: Date.now() - never_began };
	limits.call = usual_limit;
	never.next = await within(evaluate(() => 1 + 1), 6000);
	check("a call whose promise never settles is refused at the harness's limit, 2 s here, and the next call answers", /^refused: .*no answer in 2 s/.test(never.call) && never.ms >= 1900 && never.next === 2, JSON.stringify(never));

	// 14. The two origins. Files written here in the run's folder, the client's own files, the type each comes with, the
	// switches, the request counts and an upload.
	const files = path.join(TEST_FILES, "smoke");
	fs.mkdirSync(files, { recursive: true });
	const blob = Buffer.alloc(1 << 20);
	for (let i = 0; i < blob.length; i++) blob[i] = (i * 31 + (i >> 8)) & 255;
	fs.writeFileSync(path.join(files, "a.bin"), blob);
	for (const name of ["b.jpg", "c.webp", "d.png", "count.txt"]) fs.writeFileSync(path.join(files, name), name);
	fs.writeFileSync(path.join(files, "e.json"), "{}");
	const goal_png = fs.readFileSync(path.join(ROOT, "images", "archipelago", "800x600.png"));
	const fetched = await evaluate(async (second) => {
		const hex = (buffer) => [...new Uint8Array(buffer)].map((v) => v.toString(16).padStart(2, "0")).join("");
		const read = async (url, init) => {
			const t = performance.now();
			try {
				const r = await fetch(url, init);
				const body = await r.arrayBuffer();
				return { status: r.status, type: r.headers.get("content-type"), length: Number(r.headers.get("content-length")), bytes: body.byteLength, sha: hex(await crypto.subtle.digest("SHA-256", body)), ms: performance.now() - t };
			} catch (error) {
				return { error: error.name, ms: performance.now() - t };
			}
		};
		const out = { with_cors: await read(`${second}/__test__/smoke/a.bin?cors=1`), without_cors: await read(`${second}/__test__/smoke/a.bin`), client: await read(`${second}/images/archipelago/800x600.png?cors=1`) };
		out.types = {};
		for (const name of ["b.jpg", "c.webp", "d.png", "e.json"]) out.types[name] = (await read(`/__test__/smoke/${name}`)).type;
		out.delayed = await read("/__test__/smoke/e.json?delay=700");
		out.plain = await read("/__test__/smoke/e.json");
		out.statuses = [(await read("/__test__/smoke/a.bin?status=404")).status, (await read("/__test__/smoke/a.bin?status=503")).status];
		out.cache = [(await fetch("/__test__/smoke/e.json?cache=600")).headers.get("cache-control"), (await fetch("/__test__/smoke/e.json")).headers.get("cache-control")];
		for (let i = 0; i < 3; i++) await read("/__test__/smoke/count.txt");
		const body = new Uint8Array(1 << 20);
		for (let i = 0; i < body.length; i++) body[i] = (i * 7 + (i >> 10)) & 255;
		const posted = await fetch("/__test__/smoke/up/sent.bin", { method: "POST", body, headers: { "content-type": "application/octet-stream" } });
		out.upload = { status: posted.status, answer: await posted.json().catch(() => null), sent: hex(await crypto.subtle.digest("SHA-256", body)), back: (await read("/__test__/smoke/up/sent.bin")).sha };
		return out;
	}, SECOND_ORIGIN);
	check("the second origin serves the run's files to the page with Access-Control-Allow-Origin, byte for byte", fetched.with_cors.status === 200 && fetched.with_cors.bytes === blob.length && fetched.with_cors.sha === sha256(blob), JSON.stringify(fetched.with_cors));
	check("...and the page can't read them without it", fetched.without_cors.error === "TypeError", JSON.stringify(fetched.without_cors));
	check("...and serves the client's own files too", fetched.client.status === 200 && fetched.client.sha === sha256(goal_png), JSON.stringify(fetched.client));
	check("files come with their types: JPEG, WebP, PNG and JSON", JSON.stringify(fetched.types) === JSON.stringify({ "b.jpg": "image/jpeg", "c.webp": "image/webp", "d.png": "image/png", "e.json": "application/json" }), JSON.stringify(fetched.types));
	check("a delay switch holds the answer at least that long, 700 ms", fetched.delayed.status === 200 && fetched.delayed.ms >= 690 && fetched.plain.ms < 690, JSON.stringify({ delayed: Math.round(fetched.delayed.ms), plain: Math.round(fetched.plain.ms) }));
	check("a status switch answers that status, 404 and 503", fetched.statuses.join() === "404,503", fetched.statuses.join());
	check("a cache switch answers max-age, 600 s here, where every other answer says no-store", fetched.cache.join() === "max-age=600,no-store", fetched.cache.join());
	const counts = { count_txt: request_count("/__test__/smoke/count.txt", "main"), a_second: request_count("/__test__/smoke/a.bin", "second"), a_main: request_count("/__test__/smoke/a.bin", "main"), a_both: request_count("/__test__/smoke/a.bin") };
	check("requests are counted by path and origin", counts.count_txt === 3 && counts.a_second === 2 && counts.a_main === 2 && counts.a_both === 4, JSON.stringify(counts));
	const stored = fs.existsSync(path.join(files, "up", "sent.bin")) ? sha256(fs.readFileSync(path.join(files, "up", "sent.bin"))) : null;
	check("a POST under /__test__/ stores its body in the run's folder, where Node and a GET read it back", fetched.upload.status === 201 && fetched.upload.answer?.bytes === 1 << 20 && stored === fetched.upload.sent && fetched.upload.back === fetched.upload.sent, JSON.stringify({ ...fetched.upload, stored }));

	// 15. The servers go on after a request they can't serve. One they can't read answers 400: a NUL in its path, or a
	// status switch outside 200 to 599. A POST under a name that is a file throws in the server and answers 500. A
	// request whose connection closes before its answer, as a page's do when it reloads, gets none, and its file is
	// never opened. The next request answers 200. The servers serve the run's own pages alone: a request with another
	// site's Origin, as a page open in another browser would send it, or for another Host gets 403. `requests` logs the
	// 500 as it was answered, and the abandoned request with no status.
	const unread = [await status_of("/__test__/smoke/a%00.bin"), await status_of("/__test__/smoke/e.json?status=1000")];
	const failed_on = await status_of("/__test__/smoke/a.bin/x.bin", "POST", "x");
	const abandoned = http.get(`${ORIGIN}/__test__/smoke/e.json?delay=400&smoke=abandoned`);
	abandoned.on("error", () => { });
	await sleep(100);
	abandoned.destroy();
	await sleep(700);
	const went_on = { unread, failed_on, logged: requests.find((r) => r.path === "/__test__/smoke/a.bin/x.bin")?.status, abandoned: requests.find((r) => r.search.includes("smoke=abandoned"))?.status, next: await status_of("/__test__/smoke/e.json") };
	check("the servers go on after a request they can't read, which answers 400, one they fail on, which answers 500 and is logged with that status, and one abandoned before its answer, which gets none", went_on.unread.join() === "400,400" && went_on.failed_on === 500 && went_on.logged === 500 && went_on.abandoned === null && went_on.next === 200, JSON.stringify(went_on));
	const from_elsewhere = { origin: await status_of("/__test__/smoke/e.json?cors=1", "GET", null, { origin: "https://another-site.example" }), host: await status_of("/__test__/smoke/e.json", "GET", null, { host: "another-site.example" }), own_origin: await status_of("/__test__/smoke/e.json", "GET", null, { origin: ORIGIN }) };
	check("...and they refuse a request with another site's Origin and one for another Host, 403 each, and serve one with the run's own Origin", from_elsewhere.origin === 403 && from_elsewhere.host === 403 && from_elsewhere.own_origin === 200, JSON.stringify(from_elsewhere));

	// 16. A 256 MiB file goes out streamed, with its length: Node holds under half of it at a time while it goes. Read
	// whole, it would hold all of it, and a file past 2 GiB couldn't be read at all. The file is an empty one extended,
	// zeros the disk never has to write.
	const big = path.join(files, "big.bin"), BIG = 256 << 20;
	const fd = fs.openSync(big, "w");
	fs.ftruncateSync(fd, BIG);
	fs.closeSync(fd);
	const streamed = await new Promise((resolve, reject) => {
		const base = process.memoryUsage().arrayBuffers;
		http.get(`${ORIGIN}/__test__/smoke/big.bin`, (res) => {
			let bytes = 0, peak = 0;
			res.on("data", (chunk) => { bytes += chunk.length; peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); });
			res.on("end", () => resolve({ status: res.statusCode, length: Number(res.headers["content-length"]), bytes, held_mib: +(peak / 2 ** 20).toFixed(1) }));
		}).on("error", reject);
	});
	fs.rmSync(big, { force: true });
	check("a 256 MiB file streams with its length, Node holding under half of it at a time", streamed.status === 200 && streamed.length === BIG && streamed.bytes === BIG && streamed.held_mib < 128, JSON.stringify(streamed));

	// 17. The pointer as a mouse moves it at display scaling 100%, by whole-number client points and never through
	// point_on(). Paint maps a point with Math.floor((x - left) * pixels / width), which reaches every pixel of the canvas
	// shown at magnification 1. Dividing before multiplying, as it did before, put 26 columns and 7 rows of the 600x450
	// canvas out of a mouse's reach at a whole-number offset: a click, an M press or a selection's grab there landed one
	// pixel left or up. A stand-in game with Pencil and Select, a goal with no white pixel, a white canvas.
	await evaluate(async (slot, items) => {
		const { fake_session } = await import("/src/archipelago.js"), fn = await import("/src/functions.js");
		fake_session(slot, items);
		const { width, height } = goal_canvas;
		const image = goal_ctx.createImageData(width, height);
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 200, (y * 2 + 50) % 200, (x + y * 3) % 200, 255], (y * width + x) * 4);
		goal_ctx.putImageData(image, 0, 0);
		$G.triggerHandler("save-goal");
		fn.reset_canvas_and_history();
		fn.set_magnification(1);
		selected_colors.foreground = "#000000";
		selected_colors.background = "#ffffff";
		$(window).trigger("option-changed");
	}, SLOT_DATA, [...ITEMS, "Pencil", "Select"]);
	await sleep(300);
	await focus_page();
	const shown = await evaluate(async () => {
		window.dispatchEvent(new Event("resize"));
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const r = window.canvas_bounding_client_rect;
		return { left: r.left, top: r.top, width: r.width, height: r.height, pixels: [main_canvas.width, main_canvas.height], dpr: devicePixelRatio };
	});
	// The whole-number client point in canvas pixel (x, y): with the canvas at a whole-number offset, its top left corner.
	const at_pixel = (x, y) => [Math.ceil(shown.left + x), Math.ceil(shown.top + y)];
	// The canvas pixels that aren't white along a row or down a column.
	const marked = (axis, at) => evaluate((axis, at) => {
		const row = axis === "row", data = row ? main_ctx.getImageData(0, at, main_canvas.width, 1).data : main_ctx.getImageData(at, 0, 1, main_canvas.height).data, out = [];
		for (let i = 0; i < data.length / 4; i++) if (data[i * 4] !== 255 || data[i * 4 + 1] !== 255 || data[i * 4 + 2] !== 255) out.push(row ? [i, at] : [at, i]);
		return out;
	}, axis, at);
	// Every whole-number point across row 10 and down column 10, and what Paint's status bar showed after each.
	const sweep = async (points) => {
		await evaluate(() => {
			window.__smoke_moves = [];
			window.__smoke_move ??= (event) => { window.__smoke_moves.push([event.clientX, event.clientY, $status_position.text()]); };
			addEventListener("pointermove", window.__smoke_move);
		});
		for (const [x, y] of points) await mouse.move(x, y);
		await sleep(100);
		return evaluate(() => { removeEventListener("pointermove", window.__smoke_move); return window.__smoke_moves; });
	};
	const never_shown = (moves, axis, count) => { const seen = new Set(moves.map((move) => Number(move[2].split(",")[axis]))); return Array.from({ length: count }, (_, k) => k).filter((k) => !seen.has(k)); };
	const across = Array.from({ length: 600 }, (_, k) => at_pixel(k, 10)), down = Array.from({ length: 450 }, (_, k) => at_pixel(10, k));
	await mouse.move(...at_pixel(300, 300));
	const moved_across = await sweep(across), moved_down = await sweep(down);
	const reach = { shown, columns_missed: never_shown(moved_across, 0, 600), rows_missed: never_shown(moved_down, 1, 450), as_sent: moved_across.length === 600 && moved_down.length === 450 && moved_across.every((move, i) => move[0] === across[i][0]) && moved_down.every((move, i) => move[1] === down[i][1]) };
	// A Pencil click at the point of each of 12 pixels, 7 of them out of reach before, each on a row or a column of its own.
	await evaluate(async () => (await import("/src/functions.js")).select_tool(get_tool_by_id("TOOL_PENCIL")));
	const clicks = [];
	for (const [i, x] of [54, 55, 79, 97, 110, 300, 599].entries()) {
		await mouse.click(...at_pixel(x, 20 + 4 * i));
		await sleep(60);
		clicks.push({ aimed: [x, 20 + 4 * i], painted: await marked("row", 20 + 4 * i) });
	}
	for (const [i, y] of [114, 115, 119, 230, 300].entries()) {
		await mouse.click(...at_pixel(200 + 4 * i, y));
		await sleep(60);
		clicks.push({ aimed: [200 + 4 * i, y], painted: await marked("column", 200 + 4 * i) });
	}
	const elsewhere = (list) => list.filter((c) => c.painted.length !== 1 || c.painted[0][0] !== c.aimed[0] || c.painted[0][1] !== c.aimed[1]);
	reach.clicks_elsewhere = elsewhere(clicks);
	check("a mouse at whole-number points, as at display scaling 100% and magnification 1, reaches every column and row of the 600x450 canvas, and a Pencil click there paints the pixel it points at", shown.dpr === 1 && shown.pixels.join() === "600,450" && shown.width === 600 && shown.height === 450 && reach.as_sent && reach.columns_missed.length === 0 && reach.rows_missed.length === 0 && reach.clicks_elsewhere.length === 0, JSON.stringify(reach));
	// M has its own copy of the mapping (auto-copy.js).
	const presses = [];
	for (const [i, x] of [54, 55, 79, 300].entries()) {
		await mouse.move(...at_pixel(x, 60 + 4 * i));
		await sleep(40);
		await keyboard.press("m");
		await sleep(60);
		presses.push({ aimed: [x, 60 + 4 * i], painted: await marked("row", 60 + 4 * i) });
	}
	check("...and an M press there copies the goal into the pixel it points at", elsewhere(presses).length === 0, JSON.stringify(presses));
	// A selection from (100, 100) to (399, 299), grabbed at an offset that maps one short when the offset is divided
	// first, and at one that maps right, each dragged to a column every mapping gets right, so only the grab is in question.
	await evaluate(async () => (await import("/src/functions.js")).select_tool(get_tool_by_id("TOOL_SELECT")));
	const selection_now = () => evaluate(() => (typeof selection !== "undefined" && selection ? { x: selection.x, y: selection.y, width: selection.width, height: selection.height } : null));
	await mouse.move(...at_pixel(100, 100));
	await mouse.down();
	await mouse.move(...at_pixel(399, 299), 6);
	await mouse.up();
	await sleep(200);
	const made = await selection_now();
	const short = (pixels) => Array.from({ length: pixels }, (_, k) => k).filter((k) => ~~(k / pixels * pixels) !== k);
	const grabs = { made };
	if (made) {
		const short_x = short(made.width), short_y = short(made.height), short_columns = short(600), short_rows = short(450);
		const row = Array.from({ length: made.height - 45 }, (_, k) => k + 40).find((k) => !short_y.includes(k) && !short_rows.includes(made.y + k));
		const dx_for = (k, from) => Array.from({ length: 33 }, (_, d) => d + 7).find((d) => !short_columns.includes(from + k + d));
		const drag = async (k) => {
			const before = await selection_now(), dx = dx_for(k, before.x);
			await mouse.move(...at_pixel(before.x + k, before.y + row));
			await mouse.down();
			await mouse.move(...at_pixel(before.x + k + dx, before.y + row), 4);
			await mouse.up();
			await sleep(150);
			const after = await selection_now();
			return { grabbed_at: k, dragged: dx, moved: after ? [after.x - before.x, after.y - before.y] : null };
		};
		const short_k = short_x.find((k) => k >= 20 && k < made.width - 60);
		const fine_k = Array.from({ length: made.width - 90 }, (_, k) => k + 30).find((k) => !short_x.includes(k) && !short_x.includes(k - 1));
		grabs.fine = await drag(fine_k);
		grabs.short = await drag(short_k);
		await evaluate(async () => (await import("/src/functions.js")).deselect());
	}
	check("...and a selection grabbed at any offset moves as far as it is dragged", !!made && made.width >= 250 && made.height >= 150 && [grabs.fine, grabs.short].every((g) => g?.moved?.[0] === g.dragged && g.moved[1] === 0), JSON.stringify(grabs));

	check("no page errors", page_errors.length === 0, page_errors.slice(0, 5).join(" | "));

	// 18. Calls to the browser fail at once when it closes, rather than wait for answers that won't come: one waiting on
	// the page as it closes, and one made after.
	const waiting = evaluate(() => new Promise((resolve) => setTimeout(resolve, 60000))).then(() => "answered", () => "refused");
	await sleep(200);
	await close_browser({ look: true });
	const in_flight = await Promise.race([waiting, sleep(3000).then(() => "no answer in 3 s")]);
	const after_close = await Promise.race([evaluate(() => 1).then(() => "answered", () => "refused"), sleep(3000).then(() => "no answer in 3 s")]);
	check("calls to the browser fail at once when it closes: one waiting on the page, and one made after", in_flight === "refused" && after_close === "refused", JSON.stringify({ in_flight, after_close }));

	// 19. Firefox read the user.js the harness wrote into the profile: prefs.js, which Firefox writes as it closes, holds
	// the one line of the six that it carries over from there, the welcome page turned off. Nothing reads the other five:
	// no default-browser check, no telemetry and no update check show in a page or in the profile.
	const carried = 'user_pref("browser.aboutwelcome.enabled", false);';
	if (firefox) {
		const prefs = profile && fs.existsSync(path.join(profile, "prefs.js")) ? fs.readFileSync(path.join(profile, "prefs.js"), "utf8") : "";
		check("Firefox read the profile's user.js: after the close its prefs.js holds the welcome page turned off", prefs.includes(carried), `${prefs.length} characters in prefs.js`);
	} else console.log("SKIP  Firefox read the profile's user.js  (Firefox only: Chromium takes its settings from the command line)");
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish({ check_close: true });
}
