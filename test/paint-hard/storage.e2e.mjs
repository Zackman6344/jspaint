// End-to-end test of sessions in IndexedDB (task 7.4 of the fork's ROADMAP, Phase 7): Paint's database "pain-t" holds a
// record for each #local: session, its canvas a PNG from toBlob and its goal stored once by SHA-256; records from before
// move over from localStorage; saves come at most every max(5 s, 50 times what the last held the page), 60 s at most,
// with one in flight; a change not yet saved goes out as the page goes; persistent storage is asked once from the
// Connect click and never waited on; a full store keeps the last good record with one message; where IndexedDB is
// blocked, sessions keep to localStorage as before; a duplicated tab goes on under an id of its own; File > Manage
// Storage lists and removes sessions, and keeps a session another tab has open; data packages are cached in the same
// database; and with site data blocked Paint still loads and plays. From the fix round of session 7a: a database that
// fails to open, or doesn't answer, has nothing written beside the records it may hold (ruling R9); the session's Web
// Lock is asked for as the browser answers it (R10); each save closes the connection (R8) and asks for durability
// "strict" (R4); canvas reads blocked, then allowed, with no reload; and Import's rules.
// sessions.e2e.mjs checks the restore itself (task 7.5). It runs in Chrome and Firefox (decision 16).
// Usage: node test/paint-hard/storage.e2e.mjs [--browser=chrome|edge|firefox] [--headful]. PAIN_T_ONLY=<section>,...
// runs only those sections, each of which opens pages of its own. The first two, remove and persist, want a new
// profile, and the last two, restart and version, change it. What a run leaves out it prints as a SKIP line: the
// sections PAIN_T_ONLY doesn't name, above the tally, and a check the browser can't make, where the check would be.
// Firefox fills a store only under a quota it takes for the whole run: PAIN_T_ONLY=full with
// PAIN_T_FIREFOX_PREFS={"dom.quotaManager.temporaryStorage.fixedLimit":51200} runs the full section's real full store.
import fs from "node:fs";
import path from "node:path";
import { ORIGIN, SECOND_ORIGIN, TEST_FILES, add_init_script, browser_processes, check, chromium, close_tab, evaluate, finish, firefox, grant_persistent_storage, new_tab, open_paint, override_quota, page, page_errors, reload_paint, remove_init_script, restart_browser, same, sleep, version } from "./harness.mjs";
import { RECORDS, forget, local_keys, record_of, writes_of } from "./session-records.mjs";
import { CONTRACT, ITEMS, LOCATIONS, click_connect, connect, fake_server, id_of, window_shown } from "./stand-in-server.mjs";

const SECTIONS = ["remove", "persist", "idb", "migrate", "photo", "two", "goal", "quota", "blocked", "pace", "unload", "reads", "duplicate", "switch", "import", "insecure", "packages", "nostorage", "unopened", "beside", "silent", "lock", "files", "durable", "full", "cachewait", "allow", "imports", "importtab", "later", "listing", "manage", "restart", "version"];
const only = process.env.PAIN_T_ONLY ? process.env.PAIN_T_ONLY.split(",") : SECTIONS;
for (const name of only) if (!SECTIONS.includes(name)) throw new Error(`PAIN_T_ONLY names ${name}, not one of ${SECTIONS.join(", ")}`);
const left_out = SECTIONS.filter((name) => !only.includes(name));
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);

// Saves paced from 200 ms, where play waits 5 s (the pace section checks that), so a save follows each change.
const FAST = "window.paint_hard_save_every_ms = 200;";
fs.writeFileSync(path.join(TEST_FILES, "blank.html"), "<!doctype html><meta charset=utf-8><title>blank</title><p>blank</p>");
const BLANK = `${ORIGIN}/__test__/blank.html`;

const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy && window.paint_hard_session?.ready === true;
// The page's init scripts, as one set at a time: each section names what its pages get.
let scripts = [];
const use_scripts = async (...sources) => {
	for (const id of scripts) await remove_init_script(id);
	scripts = [];
	for (const source of sources) scripts.push(await add_init_script(source));
};

// A game for the stand-in server: its seed, its goal's size and the canvas items it sends at Connect, beside Magnifier
// and Brush. The rest of its slot data is the world's own at the defaults, the 5x5 start among it.
const SLOT = CONTRACT.slot_data;
const config_for = (seed, final_width, final_height, widths, heights) => ({
	seed,
	items: ["Magnifier", "Brush", ...Array(widths).fill("Progressive Canvas Width"), ...Array(heights).fill("Progressive Canvas Height")].map((name, i) => ({ item: id_of(name), location: 2199000 + 9000 + i, player: 1, flags: 1 })),
	late_item: { item: id_of("Progressive Canvas Width"), location: 2199000 + 9900, player: 1, flags: 1 },
	locations: LOCATIONS,
	slot_data: { ...SLOT, final_width, final_height, version: "1.1.0" },
	package: { checksum: "items-py", item_name_to_id: ITEMS, location_name_to_id: {} },
});
const serve = (seed, final_width = 800, final_height = 600, widths = 2, heights = 1) => fake_server(config_for(seed, final_width, final_height, widths, heights));

const id_now = () => evaluate(() => window.paint_hard_session?.id ?? null);
const session_now = () => evaluate(() => ({ id: window.paint_hard_session.id, backend: window.paint_hard_session.backend, copied_from: window.paint_hard_session.copied_from, goal: window.paint_hard_session.goal, size: `${main_canvas.width}x${main_canvas.height}` }));
const page_area = (area) => evaluate((area) => ({ size: `${main_canvas.width}x${main_canvas.height}`, digest: __t.canvas(main_ctx, ...area) }), area);
const wait_goal = async () => {
	for (let i = 0; i < 50 && !(await evaluate(() => goal_ctx.getImageData(goal_canvas.width - 1, goal_canvas.height - 1, 1, 1).data[3] === 255)); i++) await sleep(100);
};
const wait_ready = async (run = evaluate, tries = 100) => {
	for (let i = 0; i < tries && !(await run(() => window.paint_hard_session?.ready === true).catch(() => false)); i++) await sleep(100);
};
// Paints the pattern, shifted by `shift`, over rows y0 to y1 as one undo step. Returns the rectangle and its digest.
// Offline, Paint's own undoable() stops at its send, before the session-update that asks for the autosave, until task
// 7.8's send() that returns; logged in, it gets there. Offline, the test asks for that save itself.
const PAINT = `window.__paint = async (y0, y1, shift, rgb) => {
	const fn = await import("/src/functions.js");
	const width = main_canvas.width, image = main_ctx.createImageData(width, y1 - y0);
	for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) image.data.set([...(rgb ?? __t.pattern(x + shift, y)), 255], ((y - y0) * width + x) * 4);
	try {
		fn.undoable({ name: "Test rows" }, () => main_ctx.putImageData(image, 0, y0));
	} catch (error) {
		if (!/not connected/i.test(error.message)) throw error;
		(await import("/src/helpers.js")).$G.triggerHandler("session-update");
	}
	const area = [0, y0, width, y1 - y0];
	return { area, digest: __t.canvas(main_ctx, ...area) };
};`;
const paint_rows = (y0, y1, shift = 0) => evaluate((y0, y1, shift) => window.__paint(y0, y1, shift), y0, y1, shift);
// Makes the canvas a photo-like picture of a size, through the session load's own path, and asks for a save. Returns its
// digest and how long it is as the data URL localStorage would have held.
const photo_canvas = (width, height, seed = 1) => evaluate(async (width, height, seed) => {
	const c = document.createElement("canvas");
	c.width = width;
	c.height = height;
	const ctx = c.getContext("2d"), image = ctx.createImageData(width, height);
	let s = seed * 2654435761 >>> 0 || 1;
	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i += 4) {
			s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
			image.data[i] = Math.min(255, Math.max(0, x * 255 / width + (s & 63) - 32));
			image.data[i + 1] = Math.min(255, Math.max(0, y * 255 / height + ((s >>> 8) & 63) - 32));
			image.data[i + 2] = Math.min(255, Math.max(0, 128 + 90 * Math.sin(x / 37 + seed) * Math.cos(y / 23) + ((s >>> 16) & 31) - 16));
			image.data[i + 3] = 255;
		}
	}
	ctx.putImageData(image, 0, 0);
	const fn = await import("/src/functions.js");
	fn.open_session_canvas(await createImageBitmap(c));
	(await import("/src/helpers.js")).$G.triggerHandler("session-update");
	return { digest: __t.canvas(main_ctx, 0, 0, width, height), data_url: main_canvas.toDataURL("image/png").length };
}, width, height, seed);
// Waits up to `ms` for a session's record to hold a rectangle's digest.
const wait_record = async (id, area, digest, ms = 5000) => {
	let record = null;
	for (const began = Date.now(); Date.now() - began < ms; await sleep(100)) {
		record = await record_of(id, area);
		if (record?.area === digest) break;
	}
	return record;
};
const ask_save = () => evaluate(async () => (await import("/src/helpers.js")).$G.triggerHandler("session-update"));
// A goal of the test's own drawn into the goal canvas, with the save-goal a goal the page draws comes with. Returns its
// digest.
const draw_goal = (color) => evaluate(async (color) => {
	goal_ctx.fillStyle = color;
	goal_ctx.fillRect(0, 0, goal_canvas.width, goal_canvas.height);
	goal_ctx.fillStyle = "#ffffff";
	goal_ctx.fillRect(10, 10, 30, 20);
	(await import("/src/helpers.js")).$G.triggerHandler("save-goal");
	return __t.digest(goal_ctx.getImageData(0, 0, goal_canvas.width, goal_canvas.height).data);
}, color);
// The canvas decode held back until the test lets it go, as in sessions.e2e.mjs: createImageBitmap is the restore's last
// step before it draws. wait_held() waits up to 15 s until the restore has read its record from IndexedDB and waits on
// that decode, and gives whether it got there.
const HOLD_DECODE = `(() => {
	const real = window.createImageBitmap, held = [];
	window.createImageBitmap = (...args) => new Promise((resolve, reject) => held.push(() => real.apply(window, args).then(resolve, reject)));
	window.__release_decodes = () => { for (const go of held.splice(0)) go(); };
	window.__decodes_held = () => held.length;
})();`;
const wait_held = async () => {
	for (let i = 0; i < 150; i++) {
		if (await evaluate(() => window.__decodes_held?.() > 0 && window.paint_hard_session?.backend === "idb").catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};
// Waits up to 20 s until no page holds a session's Web Lock. A session that ends lets go of its own once its last save
// has landed. Whether the lock went.
const lock_let_go = async (id) => {
	for (let i = 0; i < 200; i++) {
		if (await evaluate(async (name) => !(await navigator.locks.query()).held.some((lock) => lock.name === name), `pain-t-session:${id}`)) return true;
		await sleep(100);
	}
	return false;
};
// Takes the page to another session by its address, as a link from Manage Storage or Back does, and waits up to 10 s
// until that session's restore has settled.
const go_to_session = async (id) => {
	await evaluate((id) => { location.hash = "local:" + id; }, id);
	for (let i = 0; i < 100 && !(await evaluate((id) => window.paint_hard_session.id === id && window.paint_hard_session.ready === true, id)); i++) await sleep(100);
};
// Windows on the page whose title or text matches, counted as they open, by an observer the page gets with this.
const COUNT_WINDOWS = `(() => {
	window.__opened = [];
	new MutationObserver((changes) => {
		for (const change of changes) for (const node of change.addedNodes) if (node.nodeType === 1 && node.classList.contains("window")) window.__opened.push(node);
	}).observe(document, { childList: true, subtree: true });
})();`;
const opened = (pattern) => evaluate((source) => window.__opened.filter((w) => new RegExp(source).test(w.textContent)).length, pattern);
const shown = (pattern) => evaluate((source) => [...document.querySelectorAll(".window")].some((w) => w.offsetParent !== null && new RegExp(source).test(w.textContent)), pattern);
const close_windows = () => evaluate(() => { for (const w of document.querySelectorAll(".window")) if (!/Archipelago Connection Options/.test(w.textContent) && w.offsetParent !== null) w.querySelector(".window-close-button")?.click(); });
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
// Every call to persist(), with its time, and each answer the browser gave; with window.__hold_persist set, a
// persist() that never answers; and each answer estimate() gave, which reaches this list before it reaches its asker.
// Firefox runs a tab's init scripts in an about:blank document too, on the way from the harness's first blank page to
// Paint, and that document has no StorageManager.
const LOG_PERSIST = `(() => {
	window.__persist = [];
	window.__persist_answers = [];
	window.__estimates = [];
	if (typeof StorageManager === "undefined") return;
	const persist = StorageManager.prototype.persist;
	StorageManager.prototype.persist = function () {
		window.__persist.push(performance.now());
		if (window.__hold_persist) return new Promise(() => { });
		const answer = persist.call(this);
		answer.then((kept) => window.__persist_answers.push(kept), (error) => window.__persist_answers.push("error: " + error?.name));
		return answer;
	};
	const estimate = StorageManager.prototype.estimate;
	StorageManager.prototype.estimate = function () {
		const answer = estimate.call(this);
		answer.then(({ usage, quota }) => window.__estimates.push({ usage, quota }), () => { });
		return answer;
	};
})();`;
// Whether Manage Storage's line on keeping the storage says what the browser says: that it keeps the storage until you
// remove it, or that it may clear it.
const says_as_the_browser = (line, persisted) => /keeps this storage until you remove it/.test(line) === persisted && /may clear this storage/.test(line) === !persisted;
// For the page: a canvas of the test pattern shifted by `salt`, as a PNG Blob; a put into one of Paint's stores behind
// Paint's back; rows painted as __paint paints them, with the digest of the pixels put, read from nothing, since a page
// whose canvas reads are blocked reads them back wrong; and File > Import Session with its file dialog answered.
const KIT = `window.__kit = {
	canvas(width, height, salt) {
		const c = document.createElement("canvas");
		c.width = width; c.height = height;
		const ctx = c.getContext("2d"), image = ctx.createImageData(width, height);
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([...__t.pattern(x + salt, y + salt * 3), 255], (y * width + x) * 4);
		ctx.putImageData(image, 0, 0);
		return c;
	},
	blob: (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/png")),
	async put(store, value) {
		const db = await __t.db();
		try {
			await new Promise((resolve, reject) => {
				const t = db.transaction(store, "readwrite");
				t.objectStore(store).put(value);
				t.oncomplete = resolve;
				t.onabort = () => reject(t.error);
			});
		} finally { db.close(); }
	},
	async paint(y0, y1, shift) {
		const fn = await import("/src/functions.js");
		const width = main_canvas.width, image = main_ctx.createImageData(width, y1 - y0);
		for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) image.data.set([...__t.pattern(x + shift, y), 255], ((y - y0) * width + x) * 4);
		try {
			fn.undoable({ name: "Test rows" }, () => main_ctx.putImageData(image, 0, y0));
		} catch (error) {
			if (!/not connected/i.test(error.message)) throw error;
			(await import("/src/helpers.js")).$G.triggerHandler("session-update");
		}
		return { area: [0, y0, width, y1 - y0], digest: __t.digest(image.data) };
	},
	import(name, text) {
		systemHooks.showOpenFileDialog = async () => ({ file: new File([text], name, { type: "application/json" }) });
		return window.import_local_session();
	},
};`;
// A session of no game behind Paint's back, its canvas the test pattern at a size, saved `age` ms ago.
const put_session = (id, width, height, salt, age = 0) => evaluate(async (id, width, height, salt, age) => {
	const canvas = window.__kit.canvas(width, height, salt);
	await window.__kit.put("sessions", { id, version: 2, canvas: await window.__kit.blob(canvas), width, height, final_width: 800, final_height: 600, goal: null, colors: ["rgb(0,0,0)", "rgb(255,255,255)"], connection: {}, game: null, saved_at: Date.now() - age });
	return __t.digest(canvas.getContext("2d").getImageData(0, 0, width, height).data);
}, id, width, height, salt, age);
// The windows showing on the page now, but the connection window, each as its text.
const boxes = () => evaluate(() => [...document.querySelectorAll(".window")].filter((w) => w.offsetParent !== null && !/Archipelago Connection Options/.test(w.textContent)).map((w) => w.textContent.replace(/\s+/g, " ").trim()));
const held_locks = () => evaluate(async () => (await navigator.locks.query()).held.map((lock) => lock.name));
const stored_ids = () => evaluate(async () => ((await __t.read("sessions")) ?? []).map((record) => record.id).sort());
const whole = () => evaluate(() => `${main_canvas.width}x${main_canvas.height}:${__t.canvas(main_ctx, 0, 0, main_canvas.width, main_canvas.height)}`);
const export_now = () => evaluate(async () => {
	systemHooks.showSaveFileDialog = async ({ getBlob }) => { window.__exported = await (await getBlob()).text(); };
	await window.export_local_session();
	return window.__exported;
});
// Every "Session save failed" line Paint logs, as the kind of failure it took the error for and the error's name.
const SAVE_LOG = `(() => {
	window.__failed = [];
	const log = console.log;
	console.log = function (...args) {
		if (args[0] === "Session save failed:") window.__failed.push(args[1] + " " + (args[2]?.name ?? String(args[2])));
		return log.apply(this, args);
	};
})();`;
// The page's open of its database, with a version, fires its error event as Chrome's "Internal error opening backing
// store" does, while `when` holds in the page. The tests' own reads open the database without a version.
const failing_open = (when) => `(() => {
	const open = IDBFactory.prototype.open;
	IDBFactory.prototype.open = function (name, ...rest) {
		if (name !== "pain-t" || !rest.length || !(${when})) return open.call(this, name, ...rest);
		const request = { error: new DOMException("Internal error opening backing store for indexedDB.open.", "UnknownError"), result: undefined };
		setTimeout(() => request.onerror?.({ preventDefault() { }, target: request }), 20);
		return request;
	};
})();`;
// Opens Paint at an address the main tab navigates to, from a page of another document, and waits up to 20 s until it
// holds the suite's ready condition.
const go_to = async (url) => {
	await evaluate(() => { window.__going = true; });
	await evaluate((url) => { location.href = url; }, url);
	for (let i = 0; i < 200 && !(await evaluate(() => !window.__going && typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy && window.paint_hard_session?.ready === true).catch(() => false)); i++) await sleep(100);
	await sleep(500);
};

const section = async (name, run) => {
	if (!only.includes(name)) return;
	const began = Date.now();
	try {
		await run();
	} catch (error) {
		check(`${name}: ran without exceptions`, false, error?.stack || String(error));
	}
	console.log(`(${name}: ${((Date.now() - began) / 1000).toFixed(1)} s)`);
};

try {
	console.log(`browser: ${version()}`);

	// A session as localStorage kept one before task 7.4, planted under an id: a 300x200 canvas, a 120x90 goal, a palette
	// color, a connection with a password, and a game.
	const plant = (id, host) => evaluate(async (id, host) => {
		const canvas = document.createElement("canvas"), goal = document.createElement("canvas");
		canvas.width = 300; canvas.height = 200; goal.width = 120; goal.height = 90;
		const ctx = canvas.getContext("2d"), image = ctx.createImageData(300, 200);
		for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) image.data.set([...__t.pattern(x, y), 255], (y * 300 + x) * 4);
		ctx.putImageData(image, 0, 0);
		const g = goal.getContext("2d");
		g.fillStyle = "#3366cc"; g.fillRect(0, 0, 120, 90); g.fillStyle = "#cc6633"; g.fillRect(30, 20, 50, 40);
		const goal_uri = goal.toDataURL("image/png");
		localStorage.setItem("image#" + id, JSON.stringify(JSON.stringify({ canvas: canvas.toDataURL("image/png"), goal: goal_uri, connection_info: { host, port: "1234", slot: "Old", pass: "secret" }, colors: ["rgb(0,0,0)", "rgb(255,255,255)", "#13579b"], game: { seed: "OLD", team: 0, slot: 1 } })));
		const bytes = await (await fetch(goal_uri)).arrayBuffer();
		const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
		return { digest: __t.digest(image.data), goal_sha: sha };
	}, id, host);

	// 1. File > Manage Storage: the sessions, newest first, with thumbnails at most 64 pixels a side, their sizes and when
	// they were saved; a session from before, still in localStorage; the storage the site uses; whether the browser keeps
	// it, and Keep. Remove takes a session's goal with it only when no other session refers to it and this page doesn't
	// use it.
	await section("remove", async () => {
		const made = [];
		for (const [seed, w, h] of [["STORAGE-RM-B", 800, 800], ["STORAGE-RM-B", 800, 800], ["STORAGE-RM-A", 800, 600]]) {
			await use_scripts(PAINT, RECORDS, FAST, LOG_PERSIST, serve(seed, w, h, 2, 1));
			await open_paint(ready, { hide_connection_window: false });
			await connect();
			await wait_goal();
			const id = await id_now();
			const painted = await paint_rows(0, 105, made.length * 11);
			const saved = await wait_record(id, painted.area, painted.digest);
			made.push({ id, goal: saved?.goal_sha });
			await sleep(50);
		}
		const [b1, b2, a] = made;
		const old_id = "oldsession1";
		await plant(old_id, "old.test");
		await evaluate(async () => (await import("/src/manage-storage.js")).manage_storage());
		let listed = null;
		for (let i = 0; i < 50; i++) {
			listed = await evaluate(() => [...document.querySelectorAll(".storage-manager tr")].map((tr) => ({ id: tr.dataset.session, thumbs: [...tr.querySelectorAll(".thumbnail-container > *")].map((t) => `${t.width ?? t.naturalWidth}x${t.height ?? t.naturalHeight}`), text: tr.querySelector(".session-details")?.textContent ?? "" })));
			if (listed.length >= 4 && listed.every((row) => row.thumbs.length === 2)) break;
			await sleep(100);
		}
		// The window's last lines, with what the browser told it: the estimate() the usage line was written from, and whether
		// the browser keeps the storage.
		const footer = await evaluate(async () => {
			const keep = document.querySelector(".storage-manager .keep-button");
			return { usage: document.querySelector(".storage-manager .storage-usage")?.textContent ?? "", kept: document.querySelector(".storage-manager .storage-kept")?.textContent ?? "", keep: !!keep, keep_off: keep?.disabled ?? null, persisted: await navigator.storage.persisted(), estimate: window.__estimates.at(-1) ?? null };
		});
		const order = listed.map((row) => row.id);
		check("Manage Storage lists the sessions in IndexedDB newest first, each with its canvas and goal as thumbnails at most 64 pixels a side, its size and when it was saved", JSON.stringify(order.slice(0, 3)) === JSON.stringify([a.id, b2.id, b1.id]) && listed.slice(0, 3).every((row) => row.thumbs[0] === "64x33" && /^205x105, \d+ kB, saved /.test(row.text)) && listed[2].thumbs[1] === "64x64" && listed[0].thumbs[1] === "64x48" && /\(this tab\)$/.test(listed[0].text), JSON.stringify(listed));
		check("...then the sessions still in localStorage from before, which move when opened", listed.length === 4 && listed[3].id === old_id && /moves when you open it/.test(listed[3].text), JSON.stringify(listed[3]));
		// The figures are the browser's own, in kB below 0.1 MB, in MB to a tenth below 1,000 MB and in GB to a tenth from
		// there, and the line under them says what the browser says of keeping the storage, whichever that is, with Keep off
		// where it keeps it already.
		const figure = (bytes) => bytes < 99950 ? `${bytes ? Math.max(1, Math.round(bytes / 1e3)) : 0} kB` : bytes < 999.95e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
		check("...how much storage the site uses of what the browser allows it, and whether the browser keeps it, with Keep", !!footer.estimate && footer.estimate.quota > 0 && footer.usage === `This site uses ${figure(footer.estimate.usage)} of the ${figure(footer.estimate.quota)} your browser allows it.` && says_as_the_browser(footer.kept, footer.persisted) && footer.keep && footer.keep_off === footer.persisted, JSON.stringify(footer));
		const remove = async (id) => {
			await evaluate((id) => document.querySelector(`.storage-manager tr[data-session="${id}"] .remove-button`)?.click(), id);
			for (let i = 0; i < 30 && (await evaluate((id) => !!document.querySelector(`.storage-manager tr[data-session="${id}"]`), id)); i++) await sleep(100);
			return { record: await record_of(id), goals: ((await evaluate(() => __t.read("goals"))) ?? []).map((goal) => goal.sha256) };
		};
		const after_b1 = await remove(b1.id);
		const after_b2 = await remove(b2.id);
		const after_a = await remove(a.id);
		const after_old = await remove(old_id);
		check("Remove takes a session's record, and its goal only once no session refers to it: an 800x800 goal two sessions share stays when one goes, and goes with the other", b1.goal === b2.goal && b1.goal !== a.goal && after_b1.record === null && after_b1.goals.includes(b1.goal) && after_b2.record === null && !after_b2.goals.includes(b2.goal) && after_b2.goals.includes(a.goal), JSON.stringify({ b: b1.goal, a: a.goal, after_b1, after_b2 }));
		check("...never the goal this page uses, though its own session goes", after_a.record === null && after_a.goals.includes(a.goal), JSON.stringify(after_a));
		check("...and a session from before goes from localStorage", after_old.record === null && !(await local_keys()).includes(`image#${old_id}`), JSON.stringify(after_old));
		// Keep asks the browser once, and the window goes on saying what the browser says. On a profile this new Chrome
		// answers no, and Firefox asks the player, whom no one answers here. Chrome answers yes by itself once a profile has
		// opened the site often enough, false at its 1st to 4th page and true by its 15th in S5's probe, so this section and
		// the next come first. Where the browser keeps the storage already, Keep is off and asks nothing, and the check's
		// name says so.
		const asked_before = await evaluate(() => window.__persist.length);
		await evaluate(() => document.querySelector(".storage-manager .keep-button:not([disabled])")?.click());
		await sleep(300);
		const kept_now = () => evaluate(async () => ({ kept: document.querySelector(".storage-manager .storage-kept")?.textContent ?? "", off: document.querySelector(".storage-manager .keep-button")?.disabled ?? null, persisted: await navigator.storage.persisted() }));
		let keep = await kept_now();
		for (let i = 0; i < 30 && !says_as_the_browser(keep.kept, keep.persisted); i++) {
			await sleep(100);
			keep = await kept_now();
		}
		keep.asked = (await evaluate(() => window.__persist.length)) - asked_before;
		check(`...and Keep asks the browser to keep the storage${footer.persisted ? ", which it keeps already here, so Keep is off and asks nothing" : ""}`, keep.asked === (footer.persisted ? 0 : 1) && says_as_the_browser(keep.kept, keep.persisted) && (!keep.persisted || keep.off === true), JSON.stringify({ kept_before: footer.persisted, ...keep }));
		await close_windows();
	});

	// 2. Persistent storage: asked once a page, from the Connect click once a record exists, or right after the first save
	// lands from then, and never waited on. Chrome answers false on a new profile and true once granted; Firefox asks the
	// player, whom no one answers here, and answers true once granted.
	await section("persist", async () => {
		await use_scripts(PAINT, RECORDS, FAST, LOG_PERSIST, serve("STORAGE-PERSIST"));
		await open_paint(ready, { hide_connection_window: false });
		const id = await id_now();
		await sleep(500);
		const at_load = await evaluate(() => window.__persist.length);
		await click_connect();
		const at_click = await evaluate(() => window.__persist.length);
		for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
		for (let i = 0; i < 30 && !(await evaluate(() => window.__persist.length)); i++) await sleep(100);
		const first = await evaluate((id) => ({ calls: [...window.__persist], puts: __t.puts.filter((p) => p.id === id).map((p) => p.at), persistence: window.paint_hard_session.persistence }), id);
		await evaluate(() => __ap.drop());
		for (let i = 0; i < 30 && !(await window_shown()); i++) await sleep(100);
		await connect();
		const again = await evaluate(() => window.__persist.length);
		check("persistent storage isn't asked as the page loads, nor at a Connect click before anything is stored, and is asked once, right after the first save lands", at_load === 0 && at_click === 0 && first.calls.length === 1 && first.puts.length >= 1 && first.calls[0] > first.puts[0], JSON.stringify({ at_load, at_click, ...first }));
		check("...once a page: a second Connect asks nothing more", again === 1, JSON.stringify({ again }));
		// The page keeps the browser's answer, whichever it is. Chrome answers at once, no on a profile this new, and has 3 s
		// here. Firefox waits on the player, and has 1 s to show that it gives none.
		let answer = null;
		for (let i = 0; i < (chromium ? 30 : 10); i++) {
			answer = await evaluate(() => ({ kept: window.paint_hard_session.persistence.answer, browser: window.__persist_answers }));
			if (answer.browser.length) break;
			await sleep(100);
		}
		const gave = answer.browser.length ? answer.browser[0] : null; // true, false, or "error: <name>", which Paint keeps as false
		check(`...and its answer is kept, whichever the browser gives without the grant: ${gave === null ? "none here, as Firefox waits on the player" : gave}`, gave === null ? !chromium && answer.kept === null : answer.kept === (typeof gave === "boolean" ? gave : false), JSON.stringify(answer));
		// With the grant, the reloaded page asks at the click, a record being there, and keeps true.
		await grant_persistent_storage();
		await reload_paint(ready, { hide_connection_window: false });
		await click_connect();
		const granted_click = await evaluate(() => window.__persist.length);
		let granted = null;
		for (let i = 0; i < 250; i++) {
			granted = await evaluate(() => window.paint_hard_session.persistence);
			if (granted.answer !== null) break;
			await sleep(100);
		}
		check("...true once the browser grants it, asked at the click when a record is there", granted_click === 1 && granted.asked === 1 && granted.answer === true, JSON.stringify({ granted_click, granted }));
		// Nothing waits on it: with persist() never answering, Connect logs in and saves go on.
		await reload_paint(ready, { hide_connection_window: false });
		await evaluate(() => { window.__hold_persist = true; });
		await click_connect();
		for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
		const logged_in = !(await window_shown());
		const painted = await paint_rows(0, 105, 5);
		const saved = await wait_record(id, painted.area, painted.digest);
		check("...and nothing waits on it: with persist() never answering, Connect logs in and the session saves", logged_in && (await evaluate(() => window.__persist.length)) === 1 && saved?.area === painted.digest, JSON.stringify({ logged_in, saved: saved?.area, painted: painted.digest }));
		await forget(id);
	});

	// 3. A session saves to IndexedDB and comes back from it, with nothing in localStorage, and its record holds what
	// version 2 holds: never the password.
	await section("idb", async () => {
		await use_scripts(PAINT, RECORDS, FAST, serve("STORAGE-IDB"));
		await open_paint(ready, { hide_connection_window: false });
		await evaluate(() => $("[name=appass]").val("hunter2"));
		await connect();
		await wait_goal();
		const id = await id_now();
		const painted = await paint_rows(0, 105);
		const saved = await wait_record(id, painted.area, painted.digest);
		await reload_paint(ready, { hide_connection_window: false });
		const back = { ...(await session_now()), page: await page_area(painted.area), local: await local_keys(), password: await evaluate(() => $("[name=appass]").val()) };
		check("a session saves to IndexedDB, and a reload brings it back from there, with no session record in localStorage", saved?.from === "idb" && back.id === id && back.backend === "idb" && back.page.digest === painted.digest && back.local.length === 0, JSON.stringify({ from: saved?.from, back }));
		const keys = ["canvas", "colors", "connection", "final_height", "final_width", "game", "goal", "height", "id", "saved_at", "version", "width"];
		check("...as a version 2 record: the canvas as a PNG and its size, the game's size, the goal by its SHA-256, the palette, the host, port and slot without the password, the game, and when it was saved", saved?.version === 2 && JSON.stringify(saved.keys) === JSON.stringify(keys) && saved.type === "image/png" && saved.size === "205x105" && saved.width === 205 && saved.height === 105 && JSON.stringify(saved.final) === "[800,600]" && /^[0-9a-f]{64}$/.test(saved.goal_sha) && saved.goal === "800x600" && JSON.stringify(saved.connection) === JSON.stringify({ host: "fake.test", port: "38281", slot: "Painter" }) && saved.game?.seed === "STORAGE-IDB" && typeof saved.saved_at === "number" && back.password === "", JSON.stringify({ keys: saved?.keys, version: saved?.version, type: saved?.type, size: saved?.size, final: saved?.final, goal_sha: saved?.goal_sha, goal: saved?.goal, connection: saved?.connection, game: saved?.game, password_field: back.password }));
		await forget(id);
	});

	// 4. A session kept in localStorage from before moves to IndexedDB as its tab loads, and its keys go once the copy has
	// committed; where the copy fails, they stay.
	await section("migrate", async () => {
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		const id = await id_now();
		const planted = await plant(id, "old.test");
		await reload_paint(ready);
		for (let i = 0; i < 30 && (await record_of(id))?.from !== "idb"; i++) await sleep(100);
		const moved = { page: await page_area([0, 0, 300, 200]), record: await record_of(id, [0, 0, 300, 200]), local: await local_keys(), host: await evaluate(() => $("[name=aphost]").val()), palette: await evaluate(() => [...palette]) };
		check("a session kept in localStorage before moves to IndexedDB as its tab loads: canvas, goal by its SHA-256, palette, connection without the password, and game, and its keys leave localStorage once the copy has committed", moved.page.size === "300x200" && moved.page.digest === planted.digest && moved.record?.from === "idb" && moved.record.area === planted.digest && moved.record.goal_sha === planted.goal_sha && moved.record.goal === "120x90" && moved.record.colors?.[2] === "#13579b" && JSON.stringify(moved.record.connection) === JSON.stringify({ host: "old.test", port: "1234", slot: "Old" }) && moved.record.game?.seed === "OLD" && moved.local.length === 0 && moved.host === "old.test", JSON.stringify({ planted, page: moved.page, record: moved.record && { from: moved.record.from, area: moved.record.area, goal_sha: moved.record.goal_sha, goal: moved.record.goal, colors: moved.record.colors, connection: moved.record.connection, game: moved.record.game }, local: moved.local, host: moved.host }));
		await forget(id);

		// The copy refused, as by a full store: the keys stay, and the canvas still comes back.
		const id2 = await id_now();
		await use_scripts(`(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...args) { if (this.name === "sessions") throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); return put.apply(this, args); }; })();`, PAINT, RECORDS, FAST);
		const planted2 = await plant(id2, "kept.test");
		await reload_paint(ready);
		await sleep(500);
		const refused = { page: await page_area([0, 0, 300, 200]), record: await record_of(id2, [0, 0, 300, 200]), local: await local_keys() };
		check("...and where that copy fails, as in a full store, the localStorage keys stay as they were and the canvas still comes back", refused.page.digest === planted2.digest && refused.record?.from === "local" && refused.record.area === planted2.digest && refused.local.includes(`image#${id2}`), JSON.stringify({ planted: planted2.digest, page: refused.page, record: refused.record && { from: refused.record.from, area: refused.record.area }, local: refused.local }));
		await use_scripts(PAINT, RECORDS, FAST);
		await reload_paint(ready);
		await forget(id2);
	});

	// 5. A photo-like 2000x1500 session, which localStorage's 5,242,880 characters can't hold as a data URL.
	await section("photo", async () => {
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		const id = await id_now();
		const made = await photo_canvas(2000, 1500);
		const saved = await wait_record(id, [0, 0, 2000, 1500], made.digest, 15000);
		await reload_paint(ready);
		const back = await page_area([0, 0, 2000, 1500]);
		check(`a photo-like 2000x1500 session, ${saved ? mb(saved.bytes) : "?"} as a PNG and ${made.data_url.toLocaleString("en-US")} characters as a data URL, past the 5,242,880 localStorage holds, saves to IndexedDB and comes back whole after a reload`, saved?.from === "idb" && saved.area === made.digest && made.data_url > 5242880 && back.size === "2000x1500" && back.digest === made.digest, JSON.stringify({ made, saved: saved && { from: saved.from, area: saved.area, bytes: saved.bytes }, back }));
		await forget(id);
	});

	// 6. Sessions side by side in one browser: three photo-like 800x600 sessions logged into one game, more than
	// localStorage's 5,242,880 characters would hold as its records, are all kept, and each tab gets its own back; and their
	// goal is one record that all three refer to.
	await section("two", async () => {
		await use_scripts(PAINT, RECORDS, FAST, serve("STORAGE-TWO", 800, 600, 8, 6));
		const sessions = [];
		for (const seed of [1, 2, 3]) {
			await open_paint(ready, { hide_connection_window: false });
			await connect();
			await wait_goal();
			const id = await id_now();
			await sleep(300);
			const made = await photo_canvas(800, 600, seed);
			const saved = await wait_record(id, [0, 0, 800, 600], made.digest, 8000);
			// What localStorage held for a session before task 7.4: the record as JSON, written as a JSON string.
			const local = await evaluate(() => JSON.stringify(JSON.stringify({ canvas: main_canvas.toDataURL("image/png"), goal: goal_canvas.toDataURL("image/png"), connection_info: { host: "fake.test", port: "38281", slot: "Painter" }, colors: palette })).length);
			sessions.push({ id, made, saved, local });
		}
		const [p, ...rest] = sessions;
		const back = [];
		for (const s of sessions) {
			await evaluate((id) => { location.hash = "local:" + id; }, s.id);
			for (let i = 0; i < 50 && (await id_now()) !== s.id; i++) await sleep(100);
			await wait_ready();
			back.push((await page_area([0, 0, 800, 600])).digest);
		}
		const local = sessions.reduce((sum, s) => sum + s.local, 0);
		const goals = (await evaluate(async () => ((await __t.read("goals")) ?? []).map((goal) => ({ sha256: goal.sha256, width: goal.width, height: goal.height, bytes: goal.blob?.size ?? null })))) ?? [];
		const sharing = goals.filter((goal) => goal.width === 800 && goal.height === 600).length;
		check(`three photo-like 800x600 sessions in one browser, ${local.toLocaleString("en-US")} characters as localStorage's records where it holds 5,242,880, are all kept, and each comes back as its own`, sessions.every((s, i) => s.saved?.from === "idb" && s.saved.area === s.made.digest && back[i] === s.made.digest) && new Set(sessions.map((s) => s.made.digest)).size === 3 && local > 5242880, JSON.stringify({ sessions: sessions.map((s) => ({ id: s.id, made: s.made.digest, saved: s.saved?.area, local: s.local })), back }));
		check("...and their goal, the same image, is one record in the goals store, under its SHA-256, that all three refer to", /^[0-9a-f]{64}$/.test(p.saved?.goal_sha ?? "") && rest.every((s) => s.saved?.goal_sha === p.saved.goal_sha) && sharing === 1 && goals.some((goal) => goal.sha256 === p.saved.goal_sha), JSON.stringify({ shas: sessions.map((s) => s.saved?.goal_sha), goals }));
		for (const s of sessions) await forget(s.id);
	});

	// 7. The goal is encoded once for each goal drawn, not at every save, and a goal no session refers to any more goes.
	await section("goal", async () => {
		await use_scripts(PAINT, RECORDS, FAST, serve("STORAGE-GOAL"), `(() => {
			window.__goal_encodes = 0;
			const to_blob = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toBlob = function (...args) { if (typeof goal_canvas !== "undefined" && this === goal_canvas) window.__goal_encodes++; return to_blob.apply(this, args); };
		})();`);
		await open_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_goal();
		const id = await id_now();
		let last = null;
		for (let k = 0; k < 3; k++) {
			last = await paint_rows(0, 105, k * 7);
			await wait_record(id, last.area, last.digest);
			await sleep(300);
		}
		const first = { encodes: await evaluate(() => window.__goal_encodes), writes: await writes_of(id), record: await record_of(id) };
		// Another goal drawn, as File > Open Goal Image draws one into older seeds.
		await evaluate(async () => {
			goal_ctx.fillStyle = "#2a6f3c";
			goal_ctx.fillRect(0, 0, goal_canvas.width, goal_canvas.height);
			(await import("/src/helpers.js")).$G.triggerHandler("save-goal");
		});
		for (let i = 0; i < 30 && (await record_of(id))?.goal_sha === first.record?.goal_sha; i++) await sleep(100);
		const second = { encodes: await evaluate(() => window.__goal_encodes), record: await record_of(id), goals: ((await evaluate(() => __t.read("goals"))) ?? []).map((goal) => goal.sha256) };
		check(`the goal is encoded once for each goal drawn: once at the login for ${first.writes} saves`, first.encodes === 1 && first.writes >= 4 && first.record?.goal === "800x600", JSON.stringify({ encodes: first.encodes, writes: first.writes, goal: first.record?.goal }));
		check("...and a goal drawn over it is encoded once more and stored, and the goal it replaced, which no session refers to now, goes", second.encodes === 2 && second.record?.goal_sha !== first.record?.goal_sha && second.goals.includes(second.record?.goal_sha) && !second.goals.includes(first.record?.goal_sha), JSON.stringify({ encodes: second.encodes, old: first.record?.goal_sha, now: second.record?.goal_sha, goals: second.goals }));
		// The session's record and its goal removed while this page goes on with the session, as another tab's Manage Storage
		// removes them: behind Paint's back here, by the test's own forget().
		await sleep(400);
		await forget(id);
		const removed = { record: await record_of(id), goals: ((await evaluate(() => __t.read("goals"))) ?? []).map((goal) => goal.sha256) };
		const again = await paint_rows(0, 105, 40);
		const third = await wait_record(id, again.area, again.digest);
		check("...and a session removed with its goal while this page goes on with it, as from another tab's Manage Storage, is stored again with its goal at the page's next save, with no new encode", /^[0-9a-f]{64}$/.test(second.record?.goal_sha ?? "") && second.record.goal_found === true && removed.record === null && !removed.goals.includes(second.record.goal_sha) && third?.area === again.digest && third.goal_sha === second.record.goal_sha && third.goal_found === true && third.goal_digest === second.record.goal_digest && (await evaluate(() => window.__goal_encodes)) === 2, JSON.stringify({ before: second.record && { goal_sha: second.record.goal_sha, goal_found: second.record.goal_found, goal_digest: second.record.goal_digest }, removed, after: third && { area: third.area, goal_sha: third.goal_sha, goal_found: third.goal_found, goal_digest: third.goal_digest }, want: again.digest, encodes: await evaluate(() => window.__goal_encodes) }));
		await forget(id);
	});

	// 8. A store that refuses a save, as a full one does: the last good record stays, one message says so for three failed
	// saves, and the next save that fits lands. The same for a store that fails for another reason, or cuts a save short
	// with AbortError, with a message of its own. A goal drawn before a save that fails is stored by the next that lands.
	await section("quota", async () => {
		// Refused under session-records.mjs's count of the writes, which sees each try.
		await use_scripts(`(() => {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (...args) {
				if (this.name === "sessions" && window.__quota_full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
				if (this.name === "sessions" && window.__storage_broken) throw new DOMException("Internal error.", "UnknownError");
				if (this.name === "sessions" && window.__aborted) throw new DOMException("The transaction was aborted.", "AbortError");
				return put.apply(this, args);
			};
		})();`, PAINT, RECORDS, FAST, COUNT_WINDOWS);
		await open_paint(ready);
		const id = await id_now();
		const good = await paint_rows(0, 100);
		const before = await wait_record(id, good.area, good.digest);
		await sleep(400);
		await evaluate(() => { window.__quota_full = true; });
		const tries_before = await evaluate(() => __t.writes.length);
		for (let k = 1; k <= 3; k++) {
			await paint_rows(0, 100, k * 13);
			await sleep(600);
		}
		const full = { tries: (await evaluate(() => __t.writes.length)) - tries_before, record: await record_of(id, good.area), messages: await opened("Storage Error") };
		check("a save the store refuses with QuotaExceededError keeps the last good record, and one message says so for three failed saves", full.tries === 3 && !!before && full.record?.raw === before.raw && full.messages === 1, JSON.stringify({ tries: full.tries, kept: full.record?.raw === before?.raw, messages: full.messages }));
		await close_windows();
		await evaluate(() => { window.__quota_full = false; });
		const fits = await paint_rows(0, 100, 77);
		const after = await wait_record(id, fits.area, fits.digest);
		check("...and the next save that fits lands", after?.area === fits.digest, JSON.stringify({ after: after?.area, want: fits.digest }));
		// Refused with UnknownError, as when the browser's own storage fails.
		await sleep(400);
		await evaluate(() => { window.__storage_broken = true; });
		for (let k = 1; k <= 2; k++) {
			await paint_rows(0, 100, 80 + k);
			await sleep(600);
		}
		const broken = { record: await record_of(id, fits.area), said: await opened("couldn't save this tab's canvas"), boxes: await opened("Storage Error") };
		await close_windows();
		await evaluate(() => { window.__storage_broken = false; });
		const mended = await paint_rows(0, 100, 99);
		const landed = await wait_record(id, mended.area, mended.digest);
		check("...a save the store refuses for another reason keeps the last good record too, with one message of its own for two failed saves, and the next save lands", !!after && broken.record?.raw === after.raw && broken.said === 1 && broken.boxes === 1 && landed?.area === mended.digest, JSON.stringify({ kept: broken.record?.raw === after?.raw, said: broken.said, boxes: broken.boxes, landed: landed?.area, want: mended.digest }));
		// Cut short with AbortError, as when the browser ends a save's transaction itself: that message again, once.
		await sleep(400);
		await evaluate(() => { window.__aborted = true; });
		for (let k = 1; k <= 2; k++) {
			await paint_rows(0, 100, 90 + k);
			await sleep(600);
		}
		const aborted = { record: await record_of(id, mended.area), said: await opened("couldn't save this tab's canvas"), boxes: await opened("Storage Error") };
		await close_windows();
		await evaluate(() => { window.__aborted = false; });
		const resumed = await paint_rows(0, 100, 33);
		const goalless = await wait_record(id, resumed.area, resumed.digest);
		check("...and so does a save cut short with AbortError: the last good record stays, with that message once more for two failed saves", !!landed && aborted.record?.raw === landed.raw && aborted.said === 2 && aborted.boxes === 1 && goalless?.area === resumed.digest, JSON.stringify({ kept: aborted.record?.raw === landed?.raw, said: aborted.said, boxes: aborted.boxes, landed: goalless?.area, want: resumed.digest }));
		// A goal drawn while the store refuses: the save that fails keeps it to store, and the next that lands stores it.
		await sleep(400);
		await evaluate(() => { window.__quota_full = true; });
		const goal_tries_before = await evaluate(() => __t.writes.length);
		const goal_digest = await draw_goal("#7a3b9c");
		await sleep(700);
		const refused = { tries: (await evaluate(() => __t.writes.length)) - goal_tries_before, record: await record_of(id), boxes: await opened("Storage Error") };
		await close_windows();
		await evaluate(() => { window.__quota_full = false; });
		const fitted = await paint_rows(0, 100, 55);
		const with_goal = await wait_record(id, fitted.area, fitted.digest);
		check("...and a goal drawn before a save the store refuses is stored by the next save that lands", !!goalless && goalless.goal_sha === null && refused.tries >= 1 && refused.record?.raw === goalless.raw && refused.boxes === 2 && with_goal?.area === fitted.digest && /^[0-9a-f]{64}$/.test(with_goal.goal_sha ?? "") && with_goal.goal_found === true && with_goal.goal_digest === goal_digest, JSON.stringify({ before: goalless && { goal_sha: goalless.goal_sha }, refused: { tries: refused.tries, kept: refused.record?.raw === goalless?.raw, boxes: refused.boxes }, after: with_goal && { area: with_goal.area, goal_sha: with_goal.goal_sha, goal_found: with_goal.goal_found, goal_digest: with_goal.goal_digest }, want: goal_digest }));
		await forget(id);
	});

	// 9. With IndexedDB blocked, as with site data blocked, sessions keep to localStorage as before, its Storage Error box
	// and all.
	await section("blocked", async () => {
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, `IDBFactory.prototype.open = function () { throw new DOMException("The user denied permission to access the database.", "SecurityError"); };`);
		await open_paint(ready);
		const id = await id_now();
		const painted = await paint_rows(0, 100);
		const saved = await wait_record(id, painted.area, painted.digest);
		await reload_paint(ready);
		const back = { ...(await session_now()), page: await page_area(painted.area) };
		check("with IndexedDB blocked, sessions keep to localStorage as before: a save goes there and a reload brings it back", saved?.from === "local" && back.backend === "local" && back.id === id && back.page.digest === painted.digest && !JSON.stringify(saved.connection ?? {}).includes("pass"), JSON.stringify({ from: saved?.from, area: saved?.area, back }));
		await evaluate(() => {
			const set_item = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key, value) { if (String(key).startsWith("image#")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); return set_item.call(this, key, value); };
		});
		await paint_rows(0, 100, 9);
		await sleep(800);
		check("...and a full localStorage still brings up its Storage Error box", (await opened("Storage Error")) >= 1, String(await opened("Storage Error")));
		await close_windows();
		await use_scripts(PAINT, RECORDS, FAST);
		await evaluate((id) => { for (const s of ["", "_goal", "_connection_info", "_colors"]) localStorage.removeItem("image#" + id + s); }, id);
	});

	// 10. Saves come no sooner than the longer of 5 s and 50 times what the last save held the page, in its own calls and
	// in long tasks while its PNG was made, one at a time.
	await section("pace", async () => {
		await use_scripts(PAINT, RECORDS);
		await open_paint(ready);
		const id = await id_now();
		await paint_rows(0, 100);
		for (let i = 0; i < 30 && !(await evaluate((id) => __t.puts.some((p) => p.id === id), id)); i++) await sleep(100);
		await sleep(1000);
		const second = await paint_rows(0, 100, 3);
		await wait_record(id, second.area, second.digest, 9000);
		const starts = await evaluate(() => __t.encodes);
		check(`saves come no sooner than 5 s apart: a change 1 s after a save waited for one that began ${starts.length > 1 ? ((starts[1] - starts[0]) / 1000).toFixed(2) : "?"} s after it`, starts.length === 2 && starts[1] - starts[0] >= 4990, JSON.stringify(starts.map((t) => Math.round(t))));
		await forget(id);

		// The canvas's toBlob held up 120 ms on the page's thread: the next save waits 50 times that, counted once, though
		// Chrome reports the same 120 ms as a long task.
		await use_scripts(PAINT, RECORDS, "window.paint_hard_save_every_ms = 500;", `(() => {
			const to_blob = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toBlob = function (...args) { if (typeof main_canvas !== "undefined" && this === main_canvas) { const until = performance.now() + 120; while (performance.now() < until) { } } return to_blob.apply(this, args); };
		})();`);
		await open_paint(ready);
		const id2 = await id_now();
		await paint_rows(0, 100);
		for (let i = 0; i < 30 && !(await evaluate((id) => __t.puts.some((p) => p.id === id), id2)); i++) await sleep(100);
		await sleep(500);
		const slow = await paint_rows(0, 100, 5);
		await wait_record(id2, slow.area, slow.digest, 12000);
		const slow_starts = await evaluate(() => __t.encodes);
		const every = await evaluate(() => window.paint_hard_session.save_every);
		check(`...and no sooner than 50 times what the last save held the page: ${every.cost.toFixed(0)} ms of it made the next wait ${slow_starts.length > 1 ? ((slow_starts[1] - slow_starts[0]) / 1000).toFixed(2) : "?"} s`, slow_starts.length === 2 && every.cost >= 120 && every.cost < 200 && slow_starts[1] - slow_starts[0] >= 50 * 120, JSON.stringify({ starts: slow_starts.map((t) => Math.round(t)), every }));
		await forget(id2);

		// In Chrome a PNG's own making can hold the page: with no idle moment for about a second, Chrome makes the whole PNG at
		// once on the page's thread, in a long task that begins 1 s or more after the toBlob call and ends some 12 ms before
		// the PNG comes. Here a 120 ms task stands in for it, 1 s after the PNG is ready, just before the save hears of it.
		// Firefox reports no long tasks, and makes its PNGs off the page's thread.
		if (chromium) {
			// The PNG comes `png_after` ms after it is ready, and the 120 ms task runs as it comes (busy_at "end"), or `busy_at`
			// ms after the toBlob call.
			const hold_png = (busy_at, png_after) => `(() => {
				const to_blob = HTMLCanvasElement.prototype.toBlob;
				HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
					if (typeof main_canvas === "undefined" || this !== main_canvas) return to_blob.call(this, callback, ...rest);
					const busy = () => { const until = performance.now() + 120; while (performance.now() < until) { } };
					if (${busy_at !== "end"}) setTimeout(busy, ${busy_at === "end" ? 0 : busy_at});
					return to_blob.call(this, (blob) => setTimeout(() => { if (${busy_at === "end"}) busy(); setTimeout(() => callback(blob), 0); }, ${png_after}), ...rest);
				};
			})();`;
			const two_saves = async () => {
				await open_paint(ready);
				const id = await id_now();
				await paint_rows(0, 100);
				for (let i = 0; i < 30 && !(await evaluate((id) => __t.puts.some((p) => p.id === id), id)); i++) await sleep(100);
				await sleep(500);
				const second = await paint_rows(0, 100, 5);
				await wait_record(id, second.area, second.digest, 12000);
				const starts = await evaluate(() => __t.encodes), every = await evaluate(() => window.paint_hard_session.save_every);
				await forget(id);
				return { starts: starts.map((t) => Math.round(t)), gap: starts.length > 1 ? starts[1] - starts[0] : null, every };
			};
			await use_scripts(PAINT, RECORDS, "window.paint_hard_save_every_ms = 500;", hold_png("end", 1000));
			const made = await two_saves();
			check(`...in Chrome, a long task that ends as the PNG comes counts as the save's, where it began 1 s or more after toBlob: ${made.every.cost.toFixed(0)} ms of one made the next wait ${made.gap === null ? "?" : (made.gap / 1000).toFixed(2)} s`, made.starts.length === 2 && made.every.cost >= 120 && made.every.cost < 200 && made.gap >= 50 * 120, JSON.stringify(made));
			// The same 120 ms begun at once as the PNG is ready, ending as it comes: other work's, which only held the PNG up
			// (ST3).
			await use_scripts(PAINT, RECORDS, "window.paint_hard_save_every_ms = 500;", hold_png("end", 0));
			const at_once = await two_saves();
			check(`...and one that began less than 1 s after toBlob doesn't, though it ends as the PNG comes: the next save came ${at_once.gap === null ? "?" : (at_once.gap / 1000).toFixed(2)} s after`, at_once.starts.length === 2 && at_once.every.cost < 50 && at_once.gap < 3000, JSON.stringify(at_once));
			// A forced encode of 1,300 ms, 65 s at 50 times: the wait stops at 60 s, whatever a save cost (ruling R4). One save
			// is enough: the next would come a minute on.
			await use_scripts(PAINT, RECORDS, "window.paint_hard_save_every_ms = 500;", hold_png("end", 1000).replace("+ 120;", "+ 1300;"));
			await open_paint(ready);
			const long_id = await id_now();
			const long = await paint_rows(0, 100);
			await wait_record(long_id, long.area, long.digest, 8000);
			await sleep(300);
			const capped = await evaluate(() => window.paint_hard_session.save_every);
			check(`...and however long a save held the page, the next waits 60 s at most: ${capped.cost.toFixed(0)} ms of a forced encode, ${(capped.cost * 50 / 1000).toFixed(0)} s at 50 times, made it wait ${(capped.every / 1000).toFixed(1)} s`, capped.cost >= 1250 && capped.cost < 1700 && capped.every === 60000, JSON.stringify(capped));
			await forget(long_id);
			// The same 120 ms begun 1 s after toBlob, as Chrome's own would begin, and ending some 880 ms before the PNG comes,
			// 2 s after toBlob: some other work's.
			await use_scripts(PAINT, RECORDS, "window.paint_hard_save_every_ms = 500;", hold_png(1000, 2000));
			const other = await two_saves();
			check(`...and one that began 1 s after toBlob and ended 400 ms or more before the PNG came doesn't: the next save came ${other.gap === null ? "?" : (other.gap / 1000).toFixed(2)} s after`, other.starts.length === 2 && other.every.cost < 50 && other.gap < 5000, JSON.stringify(other));
		} else {
			skip("...in Chrome, a long task that ends as the PNG comes counts as the save's, where it began 1 s or more after toBlob", `${version()} reports no long tasks`);
			skip("...and one that began less than 1 s after toBlob doesn't, though it ends as the PNG comes", `${version()} reports no long tasks`);
			skip("...and however long a save held the page, the next waits 60 s at most", `${version()} reports no long tasks, and its saves cost their own calls alone`);
			skip("...and one that began 1 s after toBlob and ended 400 ms or more before the PNG came doesn't", `${version()} reports no long tasks`);
		}

		// The canvas's PNG held back 1.5 s off the page's thread: one save in flight at a time, and the changes made meanwhile
		// saved after it.
		await use_scripts(PAINT, RECORDS, FAST, `(() => {
			window.__encoding = 0;
			window.__most_encoding = 0;
			const to_blob = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
				if (typeof main_canvas === "undefined" || this !== main_canvas) return to_blob.call(this, callback, ...rest);
				window.__encoding++;
				window.__most_encoding = Math.max(window.__most_encoding, window.__encoding);
				return to_blob.call(this, (blob) => setTimeout(() => { window.__encoding--; callback(blob); }, 1500), ...rest);
			};
		})();`);
		await open_paint(ready);
		const id3 = await id_now();
		let last = null;
		for (let k = 0; k < 4; k++) {
			last = await paint_rows(0, 100, k * 5);
			await sleep(300);
		}
		const landed = await wait_record(id3, last.area, last.digest, 12000);
		const flights = await evaluate(() => window.__most_encoding);
		check("...one in flight at a time, and the changes made while it was out are saved after it", flights === 1 && landed?.area === last.digest, JSON.stringify({ flights, landed: landed?.area, want: last.digest }));
		await forget(id3);
	});

	// 11. A change not yet saved goes out as the page goes, as a copy in sessionStorage, kept through a reload made inside
	// the time a save waits: 5 s in play, and 60 s for this section's pages, which no run is slow enough to outlast. The
	// copy comes back in place of an older record and never over a newer one, goes once IndexedDB holds it, and takes
	// 4,000,000 characters at most.
	await section("unload", async () => {
		// As the page goes: each encode of the canvas as a data URL and each copy left in sessionStorage, counted in
		// localStorage, which the next page reads.
		const COUNT_UNLOAD = `(() => {
			const bump = (key) => localStorage.setItem(key, String(Number(localStorage.getItem(key) ?? 0) + 1));
			addEventListener("pagehide", () => { window.__leaving = true; }, { capture: true });
			const to_data_url = HTMLCanvasElement.prototype.toDataURL;
			HTMLCanvasElement.prototype.toDataURL = function (...args) { if (window.__leaving && this === main_canvas) bump("zz-encodes"); return to_data_url.apply(this, args); };
			const set_item = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key, value) { if (this === sessionStorage && String(key).startsWith("pain-t-unsaved:")) { bump("zz-copies"); localStorage.setItem("zz-copy-chars", String(String(value).length)); } return set_item.call(this, key, value); };
		})();`;
		const counted = () => evaluate(() => { const counts = { encodes: Number(localStorage.getItem("zz-encodes") ?? 0), copies: Number(localStorage.getItem("zz-copies") ?? 0), chars: Number(localStorage.getItem("zz-copy-chars") ?? 0) }; for (const key of ["zz-encodes", "zz-copies", "zz-copy-chars"]) localStorage.removeItem(key); return counts; });
		const first_put = async (id) => { for (let i = 0; i < 30 && !(await evaluate((id) => __t.puts.some((p) => p.id === id), id)); i++) await sleep(100); };
		const copy_left = (id) => evaluate((id) => sessionStorage.getItem("pain-t-unsaved:" + id) !== null, id);
		const puts_of = (id) => evaluate((id) => __t.puts.filter((p) => p.id === id).length, id);
		await use_scripts(PAINT, RECORDS, COUNT_UNLOAD, "window.paint_hard_save_every_ms = 60000;");
		await open_paint(ready);
		const id = await id_now();
		await paint_rows(0, 100);
		await first_put(id);
		await sleep(300);
		await counted();
		const puts_before = await puts_of(id);
		const late = await paint_rows(0, 100, 9);
		const puts_at_reload = await puts_of(id);
		await reload_paint(ready);
		const back = { id: await id_now(), page: await page_area(late.area), ...(await counted()) };
		check("a change made just before a reload, inside the time a save waits, comes back after it", puts_at_reload === puts_before && back.id === id && back.page.digest === late.digest, JSON.stringify({ back, want: late.digest, puts_before, puts_at_reload }));
		const held = { record: await wait_record(id, late.area, late.digest, 8000) };
		for (let i = 0; i < 20 && (await copy_left(id)); i++) await sleep(100);
		held.copy_left = await copy_left(id);
		check(`...from the copy the page left in sessionStorage as it went, ${back.chars.toLocaleString("en-US")} characters, which goes once IndexedDB holds the change`, back.encodes === 1 && back.copies === 1 && held.record?.area === late.digest && held.copy_left === false, JSON.stringify({ encodes: back.encodes, copies: back.copies, record: held.record?.area, want: late.digest, copy_left: held.copy_left }));
		await forget(id);

		// A record still in localStorage from before, and a newer copy a page left as it went.
		await open_paint(ready);
		const id2 = await id_now();
		await plant(id2, "old.test");
		const copy = await evaluate((id) => {
			const canvas = document.createElement("canvas");
			canvas.width = 120; canvas.height = 80;
			const ctx = canvas.getContext("2d"), image = ctx.createImageData(120, 80);
			for (let y = 0; y < 80; y++) for (let x = 0; x < 120; x++) image.data.set([...__t.pattern(x + 9, y + 5), 255], (y * 120 + x) * 4);
			ctx.putImageData(image, 0, 0);
			sessionStorage.setItem("pain-t-unsaved:" + id, JSON.stringify({ id, version: 2, width: 120, height: 80, final_width: 800, final_height: 600, goal: null, colors: ["rgb(0,0,0)", "rgb(255,255,255)"], connection: { host: "copy.test", port: "1", slot: "Copy" }, game: null, saved_at: Date.now(), canvas: canvas.toDataURL("image/png") }));
			return __t.digest(image.data);
		}, id2);
		await reload_paint(ready);
		const both = { page: await page_area([0, 0, 120, 80]), host: await evaluate(() => $("[name=aphost]").val()), record: await wait_record(id2, [0, 0, 120, 80], copy) };
		for (let i = 0; i < 20 && (await local_keys()).length; i++) await sleep(100);
		both.local = await local_keys();
		check("...the copy comes back in place of an older record still in localStorage, whose keys go once IndexedDB holds the copy", both.page.size === "120x80" && both.page.digest === copy && both.host === "copy.test" && both.record?.from === "idb" && both.record.area === copy && both.local.length === 0, JSON.stringify({ page: both.page, host: both.host, record: both.record && { from: both.record.from, area: both.record.area }, local: both.local, want: copy }));
		await forget(id2);

		// A copy 1 ms older than its session's record: the record comes back, and the copy goes.
		await open_paint(ready);
		const id5 = await id_now();
		const newer = await paint_rows(0, 100, 13);
		const newer_saved = await wait_record(id5, newer.area, newer.digest);
		await sleep(300);
		await evaluate((id, saved_at) => {
			const canvas = document.createElement("canvas");
			canvas.width = 120; canvas.height = 80;
			const ctx = canvas.getContext("2d"), image = ctx.createImageData(120, 80);
			for (let y = 0; y < 80; y++) for (let x = 0; x < 120; x++) image.data.set([...__t.pattern(x + 9, y + 5), 255], (y * 120 + x) * 4);
			ctx.putImageData(image, 0, 0);
			sessionStorage.setItem("pain-t-unsaved:" + id, JSON.stringify({ id, version: 2, width: 120, height: 80, final_width: 800, final_height: 600, goal: null, colors: ["rgb(0,0,0)", "rgb(255,255,255)"], connection: { host: "stale.test", port: "1", slot: "Stale" }, game: null, saved_at: saved_at - 1, canvas: canvas.toDataURL("image/png") }));
		}, id5, newer_saved?.saved_at ?? 0);
		await reload_paint(ready);
		const older = { id: await id_now(), page: await page_area(newer.area), host: await evaluate(() => $("[name=aphost]").val()), copy_left: await copy_left(id5) };
		await sleep(1500); // a copy taken would be saved over the record 100 ms after the restore
		older.record = await record_of(id5, newer.area);
		check("...and a copy 1 ms older than the session's record doesn't come back over it, and goes", typeof newer_saved?.saved_at === "number" && older.id === id5 && older.page.size === "800x600" && older.page.digest === newer.digest && older.host !== "stale.test" && older.copy_left === false && older.record?.area === newer.digest, JSON.stringify({ saved_at: newer_saved?.saved_at, painted: newer.digest, page: older.page, host: older.host, copy_left: older.copy_left, record: older.record && { size: older.record.size, area: older.record.area } }));
		await forget(id5);

		// What leaves such a copy: a tab leaves its session with a change not yet saved, another tab opens the session,
		// paints, saves and closes, and the first tab comes back.
		await open_paint(ready);
		const id6 = await id_now();
		const first = await paint_rows(0, 100, 21);
		await wait_record(id6, first.area, first.digest);
		await sleep(300);
		const unsaved = await paint_rows(0, 100, 22);
		await evaluate((url) => { location.href = url; }, BLANK);
		for (let i = 0; i < 100 && !(await evaluate(() => document.title === "blank").catch(() => false)); i++) await sleep(100);
		const gone = { copy_left: await copy_left(id6) }; // the blank page is the same tab's, at the same origin
		const tab = await new_tab();
		for (const script of [RECORDS, PAINT, FAST]) await tab.add_init_script(script);
		await tab.open(`${ORIGIN}/#local:${id6}`);
		await wait_ready(tab.evaluate);
		const other = await tab.evaluate((area) => ({ id: window.paint_hard_session.id, copied_from: window.paint_hard_session.copied_from, restored: __t.canvas(main_ctx, ...area) }), first.area);
		const second = await tab.evaluate((y0, y1, shift) => window.__paint(y0, y1, shift), 0, 100, 23);
		let second_saved = null;
		for (let i = 0; i < 80 && second_saved?.area !== second.digest; i++) {
			await sleep(100);
			second_saved = await tab.evaluate((id, area) => __t.record(id, area), id6, second.area);
		}
		await close_tab(tab);
		await sleep(500);
		await open_paint(ready, { hash: `local:${id6}` });
		const returned = { id: await id_now(), copied_from: (await session_now()).copied_from, page: await page_area(second.area), copy_left: await copy_left(id6) };
		await sleep(1500);
		returned.record = await record_of(id6, second.area);
		check("...so a tab that comes back to a session another tab saved since it left gets that tab's canvas, where it left an older copy as it went, and the record keeps it", gone.copy_left === true && other.id === id6 && other.copied_from === null && other.restored === first.digest && second_saved?.area === second.digest && returned.id === id6 && returned.copied_from === null && returned.page.digest === second.digest && returned.copy_left === false && returned.record?.area === second.digest, JSON.stringify({ copy_left_as_the_tab_went: gone.copy_left, other, digests: { first: first.digest, unsaved: unsaved.digest, second: second.digest }, second_saved: second_saved?.area, returned: { ...returned, record: returned.record && { area: returned.record.area, saved_at: returned.record.saved_at } } }));
		await forget(id6);

		// A photo-like 1200x1000 canvas, whose PNG is past the 3,000,000 bytes that 4,000,000 characters hold.
		await open_paint(ready);
		const id3 = await id_now();
		const big = await photo_canvas(1200, 1000, 4);
		const big_saved = await wait_record(id3, [0, 0, 1200, 1000], big.digest, 10000);
		await sleep(300);
		await counted();
		await paint_rows(0, 100, 3);
		await reload_paint(ready);
		const skipped = { ...(await counted()), page: await page_area([0, 0, 1200, 1000]) };
		check(`...a canvas whose last PNG was too big for the copy, ${big_saved ? mb(big_saved.bytes) : "?"}, isn't encoded as the page goes, and comes back as last saved`, big_saved?.bytes > 3000000 && skipped.encodes === 0 && skipped.copies === 0 && skipped.page.size === "1200x1000" && skipped.page.digest === big.digest, JSON.stringify({ bytes: big_saved?.bytes, ...skipped, saved: big.digest }));
		await forget(id3);

		// The same picture drawn after a small save: the copy is encoded, comes out too long, and isn't left.
		await open_paint(ready);
		const id4 = await id_now();
		const small = await paint_rows(0, 100);
		await first_put(id4);
		await wait_record(id4, small.area, small.digest);
		await counted();
		const grown = await photo_canvas(1200, 1000, 5);
		await reload_paint(ready);
		const too_long = { ...(await counted()), page: await page_area(small.area) };
		check(`...and a copy that comes out over 4,000,000 characters, ${grown.data_url.toLocaleString("en-US")} for its canvas here, isn't left: the session comes back as last saved`, grown.data_url > 4000000 && grown.data_url < 5200000 && too_long.encodes === 1 && too_long.copies === 0 && too_long.page.size === "800x600" && too_long.page.digest === small.digest, JSON.stringify({ data_url: grown.data_url, ...too_long, saved: small.digest }));
		await forget(id4);
	});

	// 12. With canvas reads blocked, nothing saves and no copy is left as the page goes, where the PNG would come out blank
	// over the record; and a save reads nothing back from the canvas, where upstream checked the whole canvas for blankness
	// at each one.
	await section("reads", async () => {
		await use_scripts(PAINT, RECORDS, FAST, `(() => {
			window.__main_reads = 0;
			const get = CanvasRenderingContext2D.prototype.getImageData;
			CanvasRenderingContext2D.prototype.getImageData = function (...args) { if (typeof main_canvas !== "undefined" && this.canvas === main_canvas) window.__main_reads++; return get.apply(this, args); };
		})();`);
		await open_paint(ready);
		const id = await id_now();
		await paint_rows(0, 100);
		for (let i = 0; i < 30 && !(await evaluate((id) => __t.puts.some((p) => p.id === id), id)); i++) await sleep(100);
		await sleep(500);
		const counted = await evaluate(async (id) => {
			const puts = __t.puts.length, reads = window.__main_reads;
			(await import("/src/helpers.js")).$G.triggerHandler("session-update");
			for (let i = 0; i < 50 && __t.puts.length === puts; i++) await new Promise((resolve) => setTimeout(resolve, 50));
			return { saved: __t.puts.length - puts, reads: window.__main_reads - reads };
		}, id);
		check("a save reads nothing back from the canvas, where upstream read it whole to see that it wasn't blank", counted.saved === 1 && counted.reads === 0, JSON.stringify(counted));
		await forget(id);
		// Reads blocked: every read comes back a bit off, so auto copy calls them blocked.
		const BLOCK_READS = `(() => {
			const get = CanvasRenderingContext2D.prototype.getImageData;
			CanvasRenderingContext2D.prototype.getImageData = function (...args) {
				const image = get.apply(this, args);
				for (let i = 0; i < image.data.length; i += 4) image.data[i] ^= 0x40;
				return image;
			};
		})();`;
		await use_scripts(PAINT, RECORDS, FAST, BLOCK_READS);
		await open_paint(ready);
		const id2 = await id_now();
		await paint_rows(0, 100);
		await sleep(1500);
		const blocked = { noise: await evaluate(() => window.paint_hard_auto_copy.read_noise()), writes: await writes_of(id2) };
		check("with canvas reads blocked, no save goes out, where its PNG would come out blank over the record", blocked.noise === "blocked" && blocked.writes === 0, JSON.stringify(blocked));
		// A session saved with reads allowed, in a tab that then loads with them blocked, where the canvas's PNG and data URL
		// come out white, as a browser that blocks reads gives its placeholder. A change is made, and the tab reloads: a copy
		// left then would come back over the record at the next load, and be saved over it once reads are allowed again.
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		const id3 = await id_now();
		const good = await paint_rows(0, 100);
		const good_saved = await wait_record(id3, good.area, good.digest);
		await sleep(400);
		await use_scripts(PAINT, RECORDS, FAST, BLOCK_READS, `(() => {
			const placeholder = (canvas) => { const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height; const ctx = c.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); return c; };
			const to_data_url = HTMLCanvasElement.prototype.toDataURL, to_blob = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toDataURL = function (...args) { return to_data_url.apply(typeof main_canvas !== "undefined" && this === main_canvas ? placeholder(this) : this, args); };
			HTMLCanvasElement.prototype.toBlob = function (...args) { return to_blob.apply(typeof main_canvas !== "undefined" && this === main_canvas ? placeholder(this) : this, args); };
		})();`);
		await reload_paint(ready);
		// A change, and the page going in the same task, before the save the change asks for has met the blocked reads: a
		// pagehide event, as the page's own unload fires it. A copy left then is taken away once it is read.
		const at_once = await evaluate(async (id) => {
			const noise = window.paint_hard_auto_copy.read_noise();
			await window.__paint(150, 200, 7);
			window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
			const copy = sessionStorage.getItem("pain-t-unsaved:" + id) !== null;
			sessionStorage.removeItem("pain-t-unsaved:" + id);
			return { noise, id_now: window.paint_hard_session.id, copy };
		}, id3);
		check("...and a page that goes in the same task as a change, before any save has met the blocked reads, leaves no copy of the canvas", at_once.noise === "blocked" && at_once.id_now === id3 && at_once.copy === false, JSON.stringify(at_once));
		await paint_rows(200, 300, 9);
		await sleep(600);
		const while_blocked = { noise: await evaluate(() => window.paint_hard_auto_copy.read_noise()), record: (await record_of(id3, good.area))?.area ?? null };
		await reload_paint(ready);
		const copy_left = await evaluate((id) => sessionStorage.getItem("pain-t-unsaved:" + id) !== null, id3);
		check("...and the page leaves no copy of the canvas as it goes", while_blocked.noise === "blocked" && while_blocked.record === good.digest && copy_left === false, JSON.stringify({ ...while_blocked, saved: good.digest, copy_left }));
		await use_scripts(PAINT, RECORDS, FAST);
		await reload_paint(ready);
		await sleep(1000); // a copy taken would be saved over the record 100 ms after the restore
		const allowed = { page: await page_area(good.area), record: await record_of(id3, good.area) };
		check("...so once reads are allowed again, the session comes back as last saved, in the page and in the record", !!good_saved && allowed.page.digest === good.digest && allowed.record?.area === good.digest, JSON.stringify({ saved: good.digest, page: allowed.page, record: allowed.record && { size: allowed.record.size, area: allowed.record.area } }));
		await forget(id3);
	});

	// 13. A duplicated tab, its session's original still open: it goes on under an id of its own, with a copy of the canvas
	// saved under that id, and leaves the original's record as it was. A session that ended while it waited for its lock
	// changes nothing, and neither does one that ended while its canvas decoded, when its restore then runs out of time.
	await section("duplicate", async () => {
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		const id = await id_now();
		const painted = await paint_rows(0, 100);
		const original = await wait_record(id, painted.area, painted.digest);
		await sleep(400);
		const tab = await new_tab();
		await tab.add_init_script(RECORDS);
		await tab.add_init_script(FAST);
		const began = Date.now();
		await tab.open(`${ORIGIN}/#local:${id}`);
		await wait_ready(tab.evaluate);
		const took = Date.now() - began;
		const copy = await tab.evaluate((area) => ({ id: window.paint_hard_session.id, copied_from: window.paint_hard_session.copied_from, hash: location.hash, digest: __t.canvas(main_ctx, ...area) }), painted.area);
		let stored = null;
		for (let i = 0; i < 40 && stored?.area !== painted.digest; i++) {
			await sleep(100);
			stored = await record_of(copy.id, painted.area);
		}
		const left = await record_of(id, painted.area);
		check("a duplicated tab, its session's original still open, goes on under an id of its own, with a copy of the canvas saved under that id", copy.id !== id && copy.copied_from === id && copy.hash === `#local:${copy.id}` && copy.digest === painted.digest && stored?.area === painted.digest, JSON.stringify({ id, copy, stored: stored?.area, ready_after_ms: took }));
		check("...and leaves the original's record as it was", !!original && left?.raw === original.raw, JSON.stringify({ before: original?.raw, after: left?.raw }));
		await close_tab(tab);

		// A duplicated tab starts with a copy of its original's sessionStorage: here with a copy its original left as it went,
		// newer than the record.
		const tab2 = await new_tab();
		await tab2.add_init_script(RECORDS);
		await tab2.add_init_script(FAST);
		await tab2.add_init_script(`(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 100; canvas.height = 60;
			const ctx = canvas.getContext("2d"), image = ctx.createImageData(100, 60);
			for (let y = 0; y < 60; y++) for (let x = 0; x < 100; x++) image.data.set([...__t.pattern(x + 31, y + 17), 255], (y * 100 + x) * 4);
			ctx.putImageData(image, 0, 0);
			window.__left = __t.digest(image.data);
			sessionStorage.setItem("pain-t-unsaved:${id}", JSON.stringify({ id: "${id}", version: 2, width: 100, height: 60, final_width: 800, final_height: 600, goal: null, colors: ["rgb(0,0,0)", "rgb(255,255,255)"], connection: { host: "left.test", port: "1", slot: "Left" }, game: null, saved_at: Date.now(), canvas: canvas.toDataURL("image/png") }));
		})();`);
		await tab2.open(`${ORIGIN}/#local:${id}`);
		await wait_ready(tab2.evaluate);
		const copy2 = await tab2.evaluate((id) => ({ id: window.paint_hard_session.id, copied_from: window.paint_hard_session.copied_from, size: `${main_canvas.width}x${main_canvas.height}`, digest: __t.canvas(main_ctx, 0, 0, 100, 60), want: window.__left, copy_left: sessionStorage.getItem("pain-t-unsaved:" + id) !== null }), id);
		check("...where it starts with the copy its original left in sessionStorage as it went, it takes that copy, and lets go of it", copy2.copied_from === id && copy2.id !== id && copy2.size === "100x60" && copy2.digest === copy2.want && copy2.copy_left === false, JSON.stringify(copy2));
		await close_tab(tab2);

		// A tab whose address changes again while it still waits for its first session's lock.
		const tab3 = await new_tab();
		await tab3.add_init_script(RECORDS);
		await tab3.add_init_script(FAST);
		await tab3.open(`${ORIGIN}/#local:${id}`);
		for (let i = 0; i < 200 && !(await tab3.evaluate(() => !!window.paint_hard_session?.id).catch(() => false)); i++) await sleep(50);
		// Until the first session's restore has settled, which follows its wait for the lock: 2 s, and longer in a tab in
		// the background, whose timers the browser slows.
		await tab3.evaluate((id) => { window.__first = window.paint_hard_session.restored; location.hash = "local:" + id; }, `${id}x`);
		await tab3.evaluate(() => Promise.race([window.__first, new Promise((resolve) => setTimeout(resolve, 15000))]).then(() => null));
		await sleep(500);
		const stayed = await tab3.evaluate(() => ({ id: window.paint_hard_session.id, hash: location.hash, ready: window.paint_hard_session.ready, copied_from: window.paint_hard_session.copied_from }));
		check("...and a tab whose address changes while it still waits for its first session's lock stays in the session the address names", stayed.id === `${id}x` && stayed.hash === `#local:${id}x` && stayed.ready === true && stayed.copied_from === null, JSON.stringify({ ...stayed, want: `${id}x` }));
		await close_tab(tab3);
		await forget(copy2.id);
		await forget(`${id}x`);
		await forget(copy.id);
		await forget(id);

		// A session that ended while its canvas still decoded, and whose restore then runs out of its time, 5 s here: no
		// message, and the tab stays in the session its address names.
		await open_paint(ready);
		const late_id = await id_now(), named_id = `${late_id}y`;
		const late = await paint_rows(0, 100, 17);
		await wait_record(late_id, late.area, late.digest);
		await sleep(400);
		await use_scripts(PAINT, RECORDS, FAST, HOLD_DECODE, "window.paint_hard_restore_timeout_ms = 5000;");
		await reload_paint(() => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy, { restored: false });
		const at_decode = await wait_held();
		const as_it_ended = await evaluate((id) => {
			const session = window.paint_hard_session, was = { ready: session.ready, outcome: session.outcome };
			window.__first = session.restored;
			location.hash = "local:" + id;
			return was;
		}, named_id);
		const first_restore = await evaluate(() => Promise.race([window.__first, new Promise((resolve) => setTimeout(() => resolve("still waiting after 15 s"), 15000))]));
		await sleep(300);
		const named = await evaluate(() => ({ id: window.paint_hard_session.id, hash: location.hash, outcome: window.paint_hard_session.outcome, message: [...document.querySelectorAll(".window")].some((w) => w.offsetParent !== null && /stopped waiting|couldn't restore/.test(w.textContent)) }));
		check("...and a session that ended while its canvas decoded, and whose restore then times out, shows no message and leaves the tab in the session its address names", at_decode && as_it_ended.ready === false && as_it_ended.outcome === "nothing stored" && first_restore === "timed out" && named.id === named_id && named.hash === `#local:${named_id}` && named.message === false, JSON.stringify({ at_decode, as_it_ended, first_restore, ...named, want: named_id }));
		await evaluate(() => window.__release_decodes?.());
		await sleep(300);
		await close_windows();
		await use_scripts(PAINT, RECORDS, FAST);
		await forget(late_id);
		await forget(named_id);
		if (named.id !== named_id) await forget(named.id);
	});

	// 14. A session that ends with a save still in flight, as when the address changes to another session: its last save
	// holds the canvas and the connection as they were when it ended, and its record goes in after the one in flight. The
	// session's lock goes once that save has landed, and a page that comes back to the session waits for it, so it goes on
	// under the session's own id. A session the page leaves before its lock has come lets go of the lock as it comes.
	await section("switch", async () => {
		// The page's request for the lock named in window.__late_lock gets the lock from the browser as ever, and the
		// page's callback is kept back, the lock held meanwhile, until the test calls __late.come(): the lock comes late.
		const LATE_LOCK = `(() => {
			window.__late = { asked: 0, got: 0, came: 0, come: null };
			if (!navigator.locks?.request) return;
			const request = navigator.locks.request.bind(navigator.locks);
			navigator.locks.request = function (name, ...rest) {
				const callback = rest.pop();
				if (name !== window.__late_lock) return request(name, ...rest, callback);
				window.__late.asked++;
				return request(name, ...rest, (lock) => new Promise((resolve) => {
					window.__late.got++;
					window.__late.come = resolve;
				}).then(() => {
					window.__late.came++;
					return callback(lock);
				}));
			};
		})();`;
		// The canvas's PNG comes back late: by 2.5 s for the first asked for once __hold_first is set, by 300 ms for the rest.
		await use_scripts(PAINT, RECORDS, FAST, LATE_LOCK, `(() => {
			const to_blob = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
				if (typeof main_canvas === "undefined" || this !== main_canvas) return to_blob.call(this, callback, ...rest);
				const wait = window.__hold_first ? 2500 : 300;
				window.__hold_first = false;
				return to_blob.call(this, (blob) => setTimeout(() => callback(blob), wait), ...rest);
			};
		})();`);
		await open_paint(ready);
		const b_id = await id_now();
		await evaluate(() => $("[name=aphost]").val("b.test"));
		const b = await paint_rows(0, 100, 40);
		await wait_record(b_id, b.area, b.digest);
		const a_id = `${b_id}a`;
		await evaluate((id) => { location.hash = "local:" + id; }, a_id);
		for (let i = 0; i < 50 && (await id_now()) !== a_id; i++) await sleep(100);
		await wait_ready();
		await evaluate(() => $("[name=aphost]").val("a.test"));
		const first = await paint_rows(0, 100, 50);
		await wait_record(a_id, first.area, first.digest);
		await sleep(500);
		await evaluate(() => { window.__hold_first = true; });
		const puts_of = (id) => evaluate((id) => __t.puts.filter((p) => p.id === id).length, id);
		const flight = { pace: await evaluate(() => window.paint_hard_session.save_every.every), encodes: await evaluate(() => __t.encodes.length), puts: await puts_of(a_id) };
		const flying = await paint_rows(0, 100, 60);
		// Its save is out once its PNG is asked for, however long the pace made it wait: the PNG is then held back 2.5 s.
		for (let i = 0; i < 400 && (await evaluate(() => __t.encodes.length)) === flight.encodes; i++) await sleep(50);
		const newest = await paint_rows(0, 100, 70);
		// Whether that save was still out as the address changed: its PNG asked for, and no record put since.
		flight.out = await evaluate((a, b, was) => {
			const out = __t.encodes.length === was.encodes + 1 && __t.puts.filter((p) => p.id === a).length === was.puts;
			location.hash = "local:" + b;
			return out;
		}, a_id, b_id, flight);
		// The ended session lets go of its lock once its last save has landed. A save that lands out of turn has 4 s more.
		flight.lock_let_go = await lock_let_go(a_id);
		for (let i = 0; i < 80 && (await puts_of(a_id)) < flight.puts + 2; i++) await sleep(50);
		await wait_ready();
		flight.landed_after = (await puts_of(a_id)) - flight.puts;
		const kept = await record_of(a_id, newest.area);
		const now = { form: await evaluate(() => $("[name=aphost]").val()), page: await page_area(b.area) };
		check("a session that ends with a save still in flight keeps its newest canvas: its last save's record goes in after the one in flight", flight.out && flight.lock_let_go && flight.landed_after === 2 && kept?.area === newest.digest && now.page.digest === b.digest, JSON.stringify({ flight, kept: kept?.area, newest: newest.digest, in_flight: flying.digest, page: now.page, b: b.digest }));
		check("...with the connection as it was when the session ended, though the next session's restore has filled the form in since", kept?.connection?.host === "a.test" && now.form === "b.test", JSON.stringify({ kept: kept?.connection, form: now.form }));
		// The page comes back to the session it left, whose lock has gone with its last save.
		const here = async () => ({ ...(await session_now()), hash: await evaluate(() => location.hash), page: (await page_area(newest.area)).digest });
		await go_to_session(a_id);
		const came_back = await here();
		check("...and the page comes back to the session it left under the session's own id, its lock let go once it ended", came_back.id === a_id && came_back.copied_from === null && came_back.hash === `#local:${a_id}` && came_back.page === newest.digest, JSON.stringify({ ...came_back, want: a_id, newest: newest.digest }));
		// And back at once after leaving it with a change not yet saved, while its last save is still out, its PNG 300 ms
		// late: the page waits for the lock. Whether that save was still out as the address came back is read in the task
		// that brings it back: its PNG asked for, and no record put since before the change.
		const latest = await evaluate(async (a, b) => {
			const puts = () => __t.puts.filter((p) => p.id === a).length, was = { puts: puts(), encodes: __t.encodes.length };
			const painted = await window.__paint(0, 100, 80);
			let out = null;
			await new Promise((resolve) => {
				location.hash = "local:" + b;
				const timer = setInterval(() => {
					if (window.paint_hard_session.id !== b) return; // the first change's handler has run once the page is in the other session
					clearInterval(timer);
					out = __t.encodes.length > was.encodes && puts() === was.puts;
					location.hash = "local:" + a;
					resolve();
				}, 5);
			});
			return { ...painted, out };
		}, a_id, b_id);
		for (let i = 0; i < 100 && !(await evaluate((b) => window.paint_hard_session.id !== b && window.paint_hard_session.ready === true, b_id)); i++) await sleep(100);
		const at_once = { ...(await session_now()), hash: await evaluate(() => location.hash), page: (await page_area(latest.area)).digest };
		check("...and at once after leaving it with a change to save, its last save still out, where the page waits for that lock", latest.out === true && at_once.id === a_id && at_once.copied_from === null && at_once.hash === `#local:${a_id}` && at_once.page === latest.digest, JSON.stringify({ last_save_out: latest.out, ...at_once, want: a_id, latest: latest.digest }));
		// And a session the page leaves before its lock has come, the lock kept back until the page has left: the session
		// lets go of the lock as it comes, where a lock kept would send every later visit to that session on as a copy.
		// Nothing holds the lock or waits for it then, with 3 s for it to go.
		const c_id = `${b_id}c`;
		const early = await evaluate(async (from, to, name) => {
			const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
			// How many hold the lock, and how many requests wait for it.
			const state = async () => {
				const locks = await navigator.locks.query();
				return { held: locks.held.filter((lock) => lock.name === name).length, pending: locks.pending.filter((lock) => lock.name === name).length };
			};
			window.__late_lock = name;
			location.hash = "local:" + to;
			for (let i = 0; i < 1000 && !(window.paint_hard_session.id === to && window.__late.got); i++) await wait(5);
			const asked = { ...(await state()), in: window.paint_hard_session.id === to, requests: window.__late.asked, came: window.__late.came };
			location.hash = "local:" + from;
			for (let i = 0; i < 1000 && window.paint_hard_session.id === to; i++) await wait(5);
			const ended = { ...(await state()), left: window.paint_hard_session.id !== to, came: window.__late.came };
			window.__late.come?.();
			let after = null;
			for (let i = 0; i < 60; i++) {
				await wait(50);
				after = { ...(await state()), came: window.__late.came };
				if (after.came && !after.held && !after.pending) break;
			}
			window.__late_lock = null;
			return { asked, ended, after };
		}, a_id, c_id, `pain-t-session:${c_id}`);
		check("...and a session the page left before its lock came lets go of the lock as it comes", early.asked.in && early.asked.requests === 1 && early.asked.held === 1 && early.asked.came === 0 && early.ended.left && early.ended.held === 1 && early.ended.came === 0 && early.after.came === 1 && early.after.held === 0 && early.after.pending === 0, JSON.stringify(early));
		for (let i = 0; i < 100 && !(await evaluate((c) => window.paint_hard_session.id !== c && window.paint_hard_session.ready === true, c_id)); i++) await sleep(100);
		for (const copy of new Set([came_back.id, at_once.id, await id_now()])) if (copy !== a_id) await forget(copy);
		await forget(a_id);
		await forget(b_id);
		await forget(c_id);
	});

	// 15. Export Session leaves the password out, and Import Session puts the session into IndexedDB, over a newer save,
	// once the session it ends has made its last save.
	await section("import", async () => {
		// With __hold_next set, the next PNG of the canvas comes back 1 s late.
		await use_scripts(PAINT, RECORDS, FAST, `(() => {
			window.__held = 0;
			const to_blob = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
				if (typeof main_canvas === "undefined" || this !== main_canvas || !window.__hold_next) return to_blob.call(this, callback, ...rest);
				window.__hold_next = false;
				window.__held++;
				return to_blob.call(this, (blob) => setTimeout(() => callback(blob), 1000), ...rest);
			};
		})();`);
		await open_paint(ready);
		const id = await id_now();
		await evaluate(() => $("[name=appass]").val("hunter2"));
		const kept = await paint_rows(0, 100);
		await wait_record(id, kept.area, kept.digest);
		const exported = await evaluate(async () => {
			systemHooks.showSaveFileDialog = async ({ getBlob }) => { window.__exported = await (await getBlob()).text(); };
			await window.export_local_session();
			return window.__exported;
		});
		const newer = await paint_rows(0, 100, 21);
		await wait_record(id, newer.area, newer.digest);
		await evaluate(() => {
			systemHooks.showOpenFileDialog = async () => ({ file: new File([window.__exported], "backup.appaint", { type: "application/json" }) });
			window.import_local_session();
		});
		let back = null;
		for (let i = 0; i < 50; i++) {
			await sleep(100);
			back = await page_area(kept.area);
			if (back.digest === kept.digest && (await evaluate(() => window.paint_hard_session.ready))) break;
		}
		const record = await record_of(id, kept.area);
		check("Export Session leaves the password out", !!exported && !exported.includes("hunter2") && JSON.parse(JSON.parse(exported).data).connection_info?.pass === undefined, exported ? JSON.stringify(JSON.parse(JSON.parse(exported).data).connection_info) : "nothing exported");
		check("...and Import Session puts the session it holds into IndexedDB, over the newer save", back.digest === kept.digest && record?.from === "idb" && record.area === kept.digest && (await local_keys()).length === 0, JSON.stringify({ back, record: record && { from: record.from, area: record.area }, kept: kept.digest }));
		// The same import over a change not yet saved, with the last save of the session it ends held back 1 s: the import
		// waits for that save, which would land over it otherwise.
		await sleep(400);
		const last = await evaluate(async () => {
			window.__hold_next = true;
			const painted = await window.__paint(0, 100, 37);
			window.import_local_session();
			return painted;
		});
		let waited = null;
		for (let i = 0; i < 60; i++) {
			await sleep(100);
			waited = await page_area(kept.area);
			if (waited.digest === kept.digest && (await evaluate(() => window.paint_hard_session.ready))) break;
		}
		const imported = { held: await evaluate(() => window.__held), record: await record_of(id, kept.area) };
		check("...after the last save of the session it ends, here held back 1 s, so that save can't land over the import", imported.held === 1 && waited.digest === kept.digest && imported.record?.area === kept.digest, JSON.stringify({ held: imported.held, page: waited, record: imported.record && { area: imported.record.area }, imported: kept.digest, last: last.digest }));
		await forget(id);
	});

	// 16. Where the page can't hash (no secure context, so no crypto.subtle), the goal is stored under its session's key.
	await section("insecure", async () => {
		await use_scripts(PAINT, RECORDS, FAST, serve("STORAGE-INSECURE"), `Object.defineProperty(Crypto.prototype, "subtle", { get: () => undefined, configurable: true });`);
		await open_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_goal();
		const id = await id_now();
		const painted = await paint_rows(0, 105);
		const saved = await wait_record(id, painted.area, painted.digest);
		check("where the page can't hash, as outside a secure context, the goal is stored under its session's key, and the session saves", saved?.goal_sha === `session:${id}` && saved.goal === "800x600", JSON.stringify({ goal_sha: saved?.goal_sha, goal: saved?.goal }));
		await forget(id);
	});

	// 17. Data packages are cached in the packages store, one record a game and checksum: a second login asks the server
	// for none, a game's new checksum takes the place of its old package, a package cached in localStorage before moves
	// over, and with IndexedDB blocked localStorage stays the cache.
	await section("packages", async () => {
		const asked = () => evaluate(() => __ap.log.filter((entry) => entry.cmd === "GetDataPackage").length);
		const cached = () => evaluate(async () => ({ idb: ((await __t.read("packages")) ?? []).filter((p) => p.game === "Pain-T").map((p) => ({ checksum: p.checksum, items: Object.keys(p.package?.item_name_to_id ?? {}).length })), local: localStorage.getItem("datapackage_cache") }));
		const wait_cached = async (holds) => {
			let now = null;
			for (let i = 0; i < 30; i++) {
				now = await cached();
				if (holds(now)) break;
				await sleep(100);
			}
			return now;
		};
		const empty_store = () => evaluate(async () => { for (const p of (await __t.read("packages")) ?? []) await __t.drop("packages", [p.game, p.checksum]); localStorage.removeItem("datapackage_cache"); });
		const size_now = () => evaluate(() => `${main_canvas.width}x${main_canvas.height}`);
		const items = Object.keys(ITEMS).length, ids = [];
		await use_scripts(PAINT, RECORDS, FAST, serve("STORAGE-PACKAGES"));
		await open_paint(ready, { hide_connection_window: false });
		await empty_store();
		ids.push(await id_now());
		await connect();
		const first = { asked: await asked(), ...(await wait_cached((now) => now.idb.length === 1)) };
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		const again = { asked: await asked(), size: await size_now() };
		check(`a login caches the game's data package, ${items} item names, in IndexedDB's packages store under its checksum, with none in localStorage`, first.asked === 1 && JSON.stringify(first.idb) === JSON.stringify([{ checksum: "items-py", items }]) && first.local === null, JSON.stringify(first));
		check("...and the next page's login asks the server for no package, its items named from the cache", again.asked === 0 && again.size === "205x105", JSON.stringify(again));
		// The same game under another checksum, as after an update of its world.
		await evaluate((config) => { __ap.use(config); __ap.drop(); }, { ...config_for("STORAGE-PACKAGES", 800, 600, 2, 1), package: { checksum: "items-py-2", item_name_to_id: ITEMS, location_name_to_id: {} } });
		for (let i = 0; i < 30 && !(await window_shown()); i++) await sleep(100);
		await connect();
		const changed = { asked: await asked(), ...(await wait_cached((now) => now.idb.length === 1 && now.idb[0].checksum === "items-py-2")) };
		check("...a game's new checksum is asked for once, and takes the place of its old package", changed.asked === 1 && JSON.stringify(changed.idb) === JSON.stringify([{ checksum: "items-py-2", items }]), JSON.stringify(changed));
		// A package cached in localStorage before task 7.4, beside another game's.
		await empty_store();
		await evaluate((ITEMS) => localStorage.setItem("datapackage_cache", JSON.stringify({ games: { "Pain-T": { checksum: "items-py", item_name_to_id: ITEMS, location_name_to_id: {} }, "Other Game": { checksum: "other", item_name_to_id: { Thing: 1 }, location_name_to_id: {} } } })), ITEMS);
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		const moved = { asked: await asked(), size: await size_now(), ...(await wait_cached((now) => now.idb.length === 1 && now.local === null)) };
		check("...a package cached in localStorage before is used without asking the server, and moves to IndexedDB, its localStorage key gone", moved.asked === 0 && moved.size === "205x105" && JSON.stringify(moved.idb) === JSON.stringify([{ checksum: "items-py", items }]) && moved.local === null, JSON.stringify({ ...moved, local: moved.local && moved.local.length }));
		// With IndexedDB blocked, localStorage is the cache, as before.
		await use_scripts(PAINT, RECORDS, FAST, serve("STORAGE-PACKAGES"), `IDBFactory.prototype.open = function () { throw new DOMException("The user denied permission to access the database.", "SecurityError"); };`);
		await open_paint(ready, { hide_connection_window: false });
		ids.push(await id_now());
		await connect();
		const local_first = { asked: await asked(), local: await evaluate(() => Object.entries(JSON.parse(localStorage.getItem("datapackage_cache") ?? "{}").games ?? {}).map(([game, p]) => `${game}:${p.checksum}`)) };
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		const local_again = { asked: await asked(), size: await size_now() };
		check("...and with IndexedDB blocked, localStorage stays the cache: a package asked for once is there for the next page's login", local_first.asked === 1 && local_first.local.includes("Pain-T:items-py") && local_again.asked === 0 && local_again.size === "205x105", JSON.stringify({ local_first, local_again }));
		await evaluate((ids) => { localStorage.removeItem("datapackage_cache"); for (const id of ids) for (const s of ["", "_goal", "_connection_info", "_colors"]) localStorage.removeItem("image#" + id + s); }, ids);
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		for (const id of ids) await forget(id);
	});

	// 18. With site data blocked, where naming localStorage or sessionStorage throws and IndexedDB won't open: Paint still
	// loads, says once that storage is off, and logs in and plays with nothing stored.
	await section("nostorage", async () => {
		await use_scripts(`(() => {
			const denied = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
			Object.defineProperty(window, "localStorage", { get: denied, configurable: true });
			Object.defineProperty(window, "sessionStorage", { get: denied, configurable: true });
			IDBFactory.prototype.open = denied;
			window.__alerts = [];
			window.alert = (message) => { window.__alerts.push(String(message)); };
		})();`, PAINT, RECORDS, FAST, COUNT_WINDOWS, serve("STORAGE-NONE"));
		const errors_before = page_errors.length;
		const loaded = { opened: await open_paint(ready, { hide_connection_window: false }).then(() => true, (error) => error.message) };
		await sleep(1500); // auto copy's first merge, a second after the page loads, reads its storage
		// A name whose script stopped before setting it throws even at typeof.
		Object.assign(loaded, await evaluate(() => ({ alerts: window.__alerts.length, modules: (() => { try { return main_canvas.width > 0 && !!window.paint_hard_auto_copy; } catch { return false; } })(), backend: window.paint_hard_session?.backend ?? null })), { said: await opened("enable local storage"), errors: page_errors.length - errors_before });
		check("with site data blocked, where naming localStorage throws, Paint's modules still load, with one message that storage is off", loaded.opened === true && loaded.alerts === 0 && loaded.modules && loaded.backend === "local" && loaded.said === 1 && loaded.errors === 0, JSON.stringify({ ...loaded, first_error: page_errors[errors_before]?.split("\n")[0] ?? null }));
		const played = { logged_in: false };
		if (loaded.modules) {
			await connect();
			played.logged_in = !(await window_shown());
			if (played.logged_in) await paint_rows(0, 105);
			await sleep(1500);
			Object.assign(played, { size: await evaluate(() => `${main_canvas.width}x${main_canvas.height}`), said: await opened("enable local storage|Storage Error|couldn't save"), errors: page_errors.length - errors_before });
		}
		check("...and it logs in and plays on with nothing stored, no further message and no page errors", played.logged_in && played.size === "205x105" && played.said === 1 && played.errors === 0, JSON.stringify({ ...played, first_error: page_errors[errors_before]?.split("\n")[0] ?? null }));
		// Chrome refuses the database with an UnknownError event where site data is blocked, as it answers for a database
		// it can't read, while localStorage refuses too: that's no database here, as above, and not one that failed to open.
		await use_scripts(`(() => {
			const denied = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
			Object.defineProperty(window, "localStorage", { get: denied, configurable: true });
			Object.defineProperty(window, "sessionStorage", { get: denied, configurable: true });
			IDBFactory.prototype.open = function () {
				const request = { error: new DOMException("An internal error was encountered in the Indexed Database server", "UnknownError"), result: undefined };
				setTimeout(() => request.onerror?.({ preventDefault() { }, target: request }), 20);
				return request;
			};
			window.__alerts = [];
			window.alert = (message) => { window.__alerts.push(String(message)); };
		})();`, PAINT, RECORDS, FAST, COUNT_WINDOWS);
		const errors_then = page_errors.length;
		await open_paint(ready);
		await sleep(1500);
		const refused = { said: await opened("enable local storage"), unopened: await opened("couldn't open its storage"), backend: await evaluate(() => window.paint_hard_session?.backend ?? null), state: await evaluate(async () => (await import("/src/idb.js")).idb_state()), alerts: await evaluate(() => window.__alerts.length), errors: page_errors.length - errors_then };
		check("...and where the database's open answers UnknownError, as Chrome's does with site data blocked, Paint says the same one message and nothing of its storage failing to open", refused.said === 1 && refused.unopened === 0 && refused.state === "unavailable" && refused.backend === "local" && refused.alerts === 0 && refused.errors === 0, JSON.stringify(refused));
		await use_scripts(PAINT, RECORDS, FAST);
	});

	// 19. A database that fails to open on a page load (ruling R9, RS2): the page writes nothing beside a record the
	// unopened database may hold. The tab goes on under an id of its own, saving to localStorage, and says so once. Once
	// the database opens again, the painting made meanwhile comes back and moves into it, beside the stored session as it
	// was. A next load that still can't open the database keeps an id whose record localStorage holds, and an address the
	// page makes itself keeps its id too.
	await section("unopened", async () => {
		// The page's opens fail while this tab's sessionStorage says so, which holds across its reloads; and each id the page
		// puts in its address is noted.
		const fail_open = (on) => evaluate((on) => { if (on) sessionStorage.setItem("storage-fail-open", "1"); else sessionStorage.removeItem("storage-fail-open"); }, on);
		const ADDRESSES = `(() => {
			window.__addresses = [];
			for (const name of ["pushState", "replaceState"]) {
				const real = History.prototype[name];
				History.prototype[name] = function (state, title, url) {
					const id = String(url ?? "").match(/[#,]local:([^,]*)/)?.[1];
					if (id) window.__addresses.push(id);
					return real.apply(this, arguments);
				};
			}
		})();`;
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, ADDRESSES, failing_open(`(() => { try { return sessionStorage.getItem("storage-fail-open") === "1"; } catch { return false; } })()`));
		await open_paint(ready);
		const id = await id_now();
		const stored = await paint_rows(0, 100, 3);
		const kept = await wait_record(id, stored.area, stored.digest);
		await sleep(300);
		await fail_open(true);
		await reload_paint(ready);
		const first = { ...(await session_now()), hash: await evaluate(() => location.hash), said: await boxes(), locks: await held_locks() };
		const painted = await paint_rows(0, 100, 7);
		const local = await wait_record(first.id, painted.area, painted.digest);
		first.local = await local_keys();
		check("RS2: a load whose database open fails goes on under an id of its own, saving to localStorage, and says once that Paint couldn't open its storage and that a reload tries again: nothing is written under the stored session's id, whose lock it lets go", kept?.from === "idb" && first.id !== id && first.hash === `#local:${first.id}` && first.backend === "local" && first.copied_from === null && first.said.length === 1 && /couldn't open its storage/.test(first.said[0]) && /reload/.test(first.said[0]) && !first.locks.includes(`pain-t-session:${id}`) && first.locks.includes(`pain-t-session:${first.id}`) && local?.from === "local" && local.area === painted.digest && !first.local.includes(`image#${id}`), JSON.stringify({ stored: kept?.from, id, first, saved: local && { from: local.from, area: local.area }, want: painted.digest }));
		await fail_open(false);
		await close_windows();
		await reload_paint(ready);
		const reopened = { ...(await session_now()), page: await page_area(painted.area), said: await boxes() };
		for (let i = 0; i < 30 && (await record_of(first.id))?.from !== "idb"; i++) await sleep(100);
		const moved = await record_of(first.id, painted.area), old = await record_of(id, stored.area);
		check("...and once the database opens again, the painting made on that load comes back under its id and moves into the database, and the stored session is as it was", reopened.id === first.id && reopened.page.digest === painted.digest && reopened.said.length === 0 && moved?.from === "idb" && moved.area === painted.digest && !(await local_keys()).includes(`image#${first.id}`) && !!kept && old?.raw === kept.raw, JSON.stringify({ reopened, moved: moved && { from: moved.from, area: moved.area }, stored_kept: old?.raw === kept?.raw }));
		await forget(id);
		await forget(first.id);
		// The trap in going on under a new id: where the database still won't open at the next load, an id whose record
		// localStorage holds is the tab's own, and its painting comes back under it.
		await open_paint(ready);
		const id2 = await id_now();
		const stored2 = await paint_rows(0, 100, 11);
		await wait_record(id2, stored2.area, stored2.digest);
		await sleep(300);
		await fail_open(true);
		await reload_paint(ready);
		const moved_to = await id_now();
		const painted2 = await paint_rows(0, 100, 13);
		const local2 = await wait_record(moved_to, painted2.area, painted2.digest);
		await close_windows();
		await reload_paint(ready);
		const again = { ...(await session_now()), page: await page_area(painted2.area), said: await boxes() };
		check("RS2: ...and with the database still not opening at the next load, the tab keeps the id whose record localStorage holds, and the painting made on the first such load comes back", local2?.from === "local" && local2.area === painted2.digest && again.id === moved_to && again.backend === "local" && again.page.digest === painted2.digest && again.said.length === 1, JSON.stringify({ id: id2, moved_to, again, want: painted2.digest }));
		// An address the page makes itself, at a load where the database fails to open: no database can hold that id.
		await close_windows();
		await open_paint(ready);
		const made = { ...(await session_now()), addresses: await evaluate(() => [...new Set(window.__addresses)]), said: await boxes() };
		check("RS2: ...and an address the page makes itself at such a load keeps the id it made", made.addresses.length === 1 && made.addresses[0] === made.id && made.backend === "local" && made.said.length === 1, JSON.stringify(made));
		await fail_open(false);
		await close_windows();
		await reload_paint(ready);
		for (const key of new Set([id2, moved_to, made.id, await id_now()])) await forget(key);
	});

	// 20. A record that localStorage holds beside the database's record of the same id, as a load that couldn't open the
	// database leaves one, or a tab still on a version of Paint from before task 7.4 (RS2, FL5): the database's record
	// restores, and the other becomes a session of its own in the database, with one message, its localStorage keys gone.
	await section("beside", async () => {
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS);
		await open_paint(ready);
		const id = await id_now();
		const painted = await paint_rows(0, 100, 5);
		const stored = await wait_record(id, painted.area, painted.digest);
		await sleep(300);
		const before = await stored_ids();
		const planted = await plant(id, "beside.test");
		await reload_paint(ready);
		for (let i = 0; i < 50 && (await local_keys()).includes(`image#${id}`); i++) await sleep(100);
		await sleep(300);
		const added = (await stored_ids()).filter((other) => !before.includes(other));
		const aside = added.length === 1 ? await record_of(added[0], [0, 0, 300, 200]) : null;
		const now = { ...(await session_now()), page: await page_area(painted.area), record: (await record_of(id, painted.area))?.raw ?? null, local: await local_keys(), said: await boxes() };
		check("RS2, FL5: a record that localStorage holds beside the database's record of the same id becomes a session of its own in the database, with one message, and its localStorage keys go, while the database's record restores", !!stored && now.id === id && now.page.digest === painted.digest && now.record === stored.raw && added.length === 1 && aside?.from === "idb" && aside.area === planted.digest && aside.size === "300x200" && aside.goal_sha === planted.goal_sha && !now.local.includes(`image#${id}`) && now.said.length === 1 && /second saved copy/.test(now.said[0]), JSON.stringify({ id, now, added, aside: aside && { from: aside.from, area: aside.area, size: aside.size, goal_sha: aside.goal_sha }, planted }));
		await close_windows();
		for (const key of [id, ...added]) await forget(key);
	});

	// 21. An open of the database with no answer (MS7): after its limit, 1 s here (window.paint_hard_open_timeout_ms), the
	// page takes the database as out for its life, as one that failed: one message, the tab under an id of its own,
	// saving to localStorage. A connection that answers after the limit is closed at once.
	await section("silent", async () => {
		// While this tab's sessionStorage names it, the page's opens get the 1 s limit and are never answered, or answered
		// that many ms after they were asked.
		const HANG_OPEN = `(() => {
			let late = null;
			try { late = sessionStorage.getItem("storage-hang-open"); } catch { }
			if (late === null) return;
			window.paint_hard_open_timeout_ms = 1000;
			window.__late = { answered: false, closed: 0 };
			const open = IDBFactory.prototype.open;
			IDBFactory.prototype.open = function (name, ...rest) {
				if (name !== "pain-t" || !rest.length) return open.call(this, name, ...rest);
				const request = {};
				if (Number(late)) setTimeout(() => {
					const really = open.call(this, name, ...rest);
					really.onupgradeneeded = (event) => { request.result = really.result; request.transaction = really.transaction; request.onupgradeneeded?.(event); };
					really.onsuccess = () => {
						const db = really.result, close = db.close.bind(db);
						db.close = () => { window.__late.closed++; close(); };
						request.result = db;
						window.__late.answered = true;
						request.onsuccess?.({ target: request });
					};
				}, Number(late));
				return request;
			};
		})();`;
		const hang = (late) => evaluate((late) => { if (late === null) sessionStorage.removeItem("storage-hang-open"); else sessionStorage.setItem("storage-hang-open", String(late)); }, late);
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, HANG_OPEN);
		await open_paint(ready);
		const id = await id_now();
		const stored = await paint_rows(0, 100, 4);
		await wait_record(id, stored.area, stored.digest);
		await sleep(300);
		await hang(0);
		await reload_paint(ready);
		const silent = { ...(await session_now()), said: await boxes(), locks: await held_locks() };
		const painted = await paint_rows(0, 100, 8);
		const local = await wait_record(silent.id, painted.area, painted.digest);
		check("MS7: an open of the database with no answer in its limit, 1 s here, leaves the database out for the page's life: one message, no box about a restore that stopped waiting, and the tab goes on under an id of its own, saving to localStorage", silent.id !== id && silent.backend === "local" && silent.copied_from === null && silent.said.length === 1 && /couldn't open its storage/.test(silent.said[0]) && !silent.locks.includes(`pain-t-session:${id}`) && local?.from === "local" && local.area === painted.digest, JSON.stringify({ id, silent, saved: local && { from: local.from, area: local.area } }));
		await close_windows();
		await evaluate(async () => (await import("/src/manage-storage.js")).manage_storage());
		await sleep(1000);
		const listed = await evaluate(() => { const w = document.querySelector(".storage-manager"); return { unlisted: w?.querySelector(".storage-unlisted")?.textContent ?? "", text: w?.textContent.replace(/\s+/g, " ") ?? "", rows: [...(w?.querySelectorAll("tr") ?? [])].map((tr) => tr.dataset.session) }; });
		await close_windows();
		check("MS7: ...and Manage Storage, opened then, lists the session saved to localStorage and says that the sessions kept in the database aren't listed and that a reload tries again, with no All clear", /couldn't open its storage on this page load/.test(listed.unlisted) && /aren't listed/.test(listed.unlisted) && /Reload/.test(listed.unlisted) && !/All clear/.test(listed.text) && listed.rows.includes(silent.id), JSON.stringify({ ...listed, text: listed.text.slice(0, 300), want: silent.id }));
		// An open answered 3 s after it was asked, past the 1 s limit: the page has gone on without it by then.
		await hang(3000);
		await open_paint(ready);
		for (let i = 0; i < 60 && !(await evaluate(() => window.__late.answered)); i++) await sleep(100);
		await sleep(300);
		const late = { ...(await session_now()), late: await evaluate(() => ({ ...window.__late })), state: await evaluate(async () => (await import("/src/idb.js")).idb_state()), said: await boxes() };
		check("MS7: ...and a connection that answers after the limit is closed at once, the page staying without it", late.late.answered === true && late.late.closed === 1 && late.backend === "local", JSON.stringify(late));
		await hang(null);
		await close_windows();
		await reload_paint(ready);
		for (const key of new Set([id, silent.id, late.id])) await forget(key);
	});

	// 22. A tab alone keeps its session's id however slow its page is to start (GP2): the session asks for its Web Lock
	// with ifAvailable, which the browser answers from who holds it, where a request with a 2 s limit ran out on a page
	// too busy to hear the grant. Here the page's thread is held 2.6 s right after the session asks.
	await section("lock", async () => {
		const SLOW_START = `(() => {
			let block = 0;
			try { block = Number(sessionStorage.getItem("storage-block-ms") ?? 0); } catch { }
			if (!block || !navigator.locks?.request) return;
			const request = navigator.locks.request.bind(navigator.locks);
			let held = false;
			navigator.locks.request = (name, ...rest) => {
				const asked = request(name, ...rest);
				if (!held && String(name).startsWith("pain-t-session:")) {
					held = true;
					const until = performance.now() + block;
					while (performance.now() < until) { }
				}
				return asked;
			};
		})();`;
		await use_scripts(PAINT, RECORDS, FAST, SLOW_START);
		await open_paint(ready);
		const id = await id_now();
		const painted = await paint_rows(0, 100, 9);
		await wait_record(id, painted.area, painted.digest);
		await sleep(300);
		await evaluate(() => sessionStorage.setItem("storage-block-ms", "2600"));
		await reload_paint(ready);
		const back = { ...(await session_now()), page: await page_area(painted.area), puts: await evaluate(() => [...new Set(__t.puts.map((p) => p.id))]) };
		await evaluate(() => sessionStorage.removeItem("storage-block-ms"));
		check("GP2: a tab alone keeps its session's id when its page's thread is held 2.6 s right after the session asks for its lock: no copy is made", back.id === id && back.copied_from === null && back.page.digest === painted.digest && back.puts.every((put) => put === id), JSON.stringify({ id, back }));
		for (const key of new Set([id, back.id])) await forget(key);
	});

	// 23. Each save closes the page's connection to its database once its transaction has committed (ruling R8, GP1). A
	// transaction asked for as the connection closes opens the database again. Firefox keeps the file of a canvas that a
	// save replaced until the connection that stored it closes, and counts it in the site's usage: so a session that saves
	// again and again keeps one canvas file there, and the usage stays near it.
	await section("files", async () => {
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		const id = await id_now();
		const painted = await paint_rows(0, 100, 2);
		await wait_record(id, painted.area, painted.digest);
		const retried = await evaluate(async (id) => {
			const idb = await import("/src/idb.js");
			await idb.open_db();
			const asked = idb.transact(["sessions"], "readonly", ({ sessions }) => idb.request_of(sessions.get(id)));
			idb.close_db();
			return asked.then((record) => ({ read: record?.id ?? null }), (error) => ({ error: error?.name ?? String(error) }));
		}, id);
		check("R8: a transaction asked for as the page closes its connection opens the database again and goes on", retried.read === id, JSON.stringify(retried));
		await forget(id);
		if (firefox) {
			// A photo-like 1200x900 canvas, a PNG of some 3 MB, saved again and again for 8 s, its saves 300 ms apart.
			await use_scripts(PAINT, RECORDS, "window.paint_hard_save_every_ms = 300;");
			await open_paint(ready);
			const id2 = await id_now();
			const made = await photo_canvas(1200, 900, 6);
			const first = await wait_record(id2, [0, 0, 1200, 900], made.digest, 15000);
			await sleep(1000);
			const usage = () => evaluate(async () => (await navigator.storage.estimate()).usage);
			const puts_before = await evaluate((id) => __t.puts.filter((p) => p.id === id).length, id2);
			const before = await usage();
			await evaluate(async () => {
				const { $G } = await import("/src/helpers.js");
				let n = 0;
				window.__saving = setInterval(() => { n++; main_ctx.fillStyle = `rgb(${n & 255}, 0, 0)`; main_ctx.fillRect(0, 0, 4, 4); $G.triggerHandler("session-update"); }, 150);
			});
			let most = before;
			for (const until = Date.now() + 8000; Date.now() < until; await sleep(500)) most = Math.max(most, await usage());
			await evaluate(() => clearInterval(window.__saving));
			await sleep(1500);
			most = Math.max(most, await usage());
			const saves = (await evaluate((id) => __t.puts.filter((p) => p.id === id).length, id2)) - puts_before;
			check(`GP1, Firefox: a session saved ${saves} times keeps one canvas file: the site's usage rose at most ${mb(Math.max(0, most - before))} past its first save, for a canvas of ${first ? mb(first.bytes) : "?"}`, !!first && saves >= 8 && most - before <= 1.5 * first.bytes + 1e6, JSON.stringify({ saves, before, most, png: first?.bytes ?? null }));
			await forget(id2);
		} else {
			skip("GP1, Firefox: a session saved again and again keeps one canvas file", `${version()} removes the file of a canvas a save replaced at once`);
		}
	});

	// 24. The writes of sessions and goals ask for durability "strict" (GP3), so that the browser flushes the canvas's file
	// and the commit before it reports a save done: here a move from localStorage and a save.
	await section("durable", async () => {
		// Each readwrite transaction on the page's own connections to Paint's database, which it opens with a version.
		const WRITES = `(() => {
			window.__writes = [];
			const open = IDBFactory.prototype.open;
			IDBFactory.prototype.open = function (name, ...rest) {
				const request = open.call(this, name, ...rest);
				if (name === "pain-t" && rest.length) request.addEventListener("success", () => { request.result.__paint = true; });
				return request;
			};
			const transaction = IDBDatabase.prototype.transaction;
			IDBDatabase.prototype.transaction = function (stores, mode, options) {
				const opened = transaction.apply(this, arguments);
				if (this.__paint && mode === "readwrite") window.__writes.push({ stores: [].concat(stores).join("+"), durability: opened.durability ?? null });
				return opened;
			};
		})();`;
		await use_scripts(PAINT, RECORDS, FAST, WRITES);
		await open_paint(ready);
		const id = await id_now();
		await plant(id, "durable.test");
		await reload_paint(ready);
		for (let i = 0; i < 30 && (await record_of(id))?.from !== "idb"; i++) await sleep(100);
		const painted = await paint_rows(0, 100, 6);
		const saved = await wait_record(id, painted.area, painted.digest);
		const writes = (await evaluate(() => window.__writes)).filter((write) => /sessions/.test(write.stores));
		check("GP3: the page's writes of sessions and goals, a move from localStorage and a save here, are opened with durability \"strict\"", saved?.area === painted.digest && writes.length >= 2 && writes.every((write) => write.durability === "strict"), JSON.stringify({ saved: saved?.area === painted.digest, writes }));
		await forget(id);
	});

	// 25. A store that refuses a save the way browsers refuse one (ST1). A put that fails on its request, logged in, where
	// the save waits on a count behind it: Paint reports that request's error, not the AbortError the abort leaves on the
	// count. And a store the browser's own quota has filled: one Storage Error box, the last good record kept, and the next
	// save once there is room. Chrome and Edge take a quota for an origin before its first write (override_quota()), so
	// that part runs at the second origin, where nothing was written before. Firefox takes its quota for a whole run, from
	// PAIN_T_FIREFOX_PREFS, which would refuse other sections' saves: there that part runs in a run of this section alone.
	await section("full", async () => {
		const FAIL_PUT = `(() => {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (value, ...rest) {
				if (this.name === "sessions" && window.__fail_put) return this.add(value, ...rest);
				return put.call(this, value, ...rest);
			};
		})();`;
		await use_scripts(FAIL_PUT, PAINT, RECORDS, FAST, COUNT_WINDOWS, SAVE_LOG, serve("STORAGE-FULL"));
		await open_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_goal();
		const id = await id_now();
		const first = await paint_rows(0, 105, 4);
		const before = await wait_record(id, first.area, first.digest);
		await sleep(400);
		await evaluate(() => { window.__fail_put = true; window.__failed.length = 0; });
		for (let k = 1; k <= 2; k++) {
			await paint_rows(0, 105, 4 + k * 13);
			await sleep(900);
		}
		const refused = { failed: await evaluate(() => [...window.__failed]), record: (await record_of(id, first.area))?.raw ?? null, said: await boxes() };
		await close_windows();
		await evaluate(() => { window.__fail_put = false; });
		const fits = await paint_rows(0, 105, 50);
		const after = await wait_record(id, fits.area, fits.digest);
		check("ST1: a save whose put fails on its request, as Firefox refuses one, logged in: Paint reports that request's error, ConstraintError here, not the AbortError the abort leaves on the count behind it, once, and the next save lands", !!before && refused.failed.length === 2 && refused.failed.every((line) => line === "other ConstraintError") && refused.record === before.raw && refused.said.length === 1 && /couldn't save this tab's canvas/.test(refused.said[0]) && /ConstraintError/.test(refused.said[0]) && after?.area === fits.digest, JSON.stringify({ ...refused, said: refused.said.map((text) => text.slice(0, 160)), after: after?.area, want: fits.digest }));
		await forget(id);
		// The real full store, at the second origin: 1 MB, then 64 kB, then 4 kB in a database of the test's own until the
		// browser refuses each.
		const quota_pref = /dom\.quotaManager\.temporaryStorage\.fixedLimit/.test(process.env.PAIN_T_FIREFOX_PREFS ?? "");
		if (chromium || quota_pref) {
			if (chromium) await override_quota(6000000, SECOND_ORIGIN);
			await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, SAVE_LOG);
			await go_to(`${SECOND_ORIGIN}/`);
			const id2 = await id_now();
			const good = await paint_rows(0, 100, 3);
			const kept = await wait_record(id2, good.area, good.digest);
			await sleep(400);
			const quota = await evaluate(async () => (await navigator.storage.estimate()).quota);
			const filled = await evaluate(async () => {
				const db = await new Promise((resolve, reject) => { const r = indexedDB.open("storage-filler", 1); r.onupgradeneeded = () => r.result.createObjectStore("blobs", { autoIncrement: true }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
				const stored = {};
				for (const [size, most] of [[1e6, 40], [65536, 200], [4096, 200]]) {
					const bytes = new Uint8Array(size);
					stored[size] = 0;
					for (let n = 0; n < most; n++) {
						for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(bytes.length, i + 65536)));
						const refusal = await new Promise((resolve) => {
							let transaction;
							try {
								transaction = db.transaction("blobs", "readwrite");
								transaction.objectStore("blobs").add({ blob: new Blob([bytes.slice()]) });
							} catch (_error) {
								// Firefox makes the first readwrite transaction after a refused one throw at its add: it is made again.
								resolve("again");
								return;
							}
							transaction.oncomplete = () => resolve(null);
							transaction.onabort = () => resolve(transaction.error?.name ?? "abort");
						});
						if (refusal === "again") continue;
						if (refusal) { stored[`refused at ${size}`] = refusal; break; }
						stored[size]++;
					}
				}
				db.close();
				return stored;
			});
			// A photo-like 800x600 canvas, a PNG of some 1.4 MB, and a change on it. Firefox keeps a small PNG inside the
			// database's own file, where the pages a replaced record freed take it, and refused none of three small saves.
			await evaluate(() => { window.__failed.length = 0; window.__opened.length = 0; });
			await photo_canvas(800, 600, 3);
			await sleep(2500);
			await paint_rows(0, 50, 7);
			await sleep(2000);
			const full = { failed: await evaluate(() => [...window.__failed]), record: (await record_of(id2, good.area))?.raw ?? null, quota_boxes: await opened("Storage Error"), other_boxes: await opened("couldn't save this tab's canvas") };
			await close_windows();
			await evaluate(() => new Promise((resolve) => { const r = indexedDB.deleteDatabase("storage-filler"); r.onsuccess = r.onerror = r.onblocked = () => resolve(); }));
			if (chromium) await override_quota(undefined, SECOND_ORIGIN);
			await sleep(500);
			const fits2 = await paint_rows(0, 100, 77);
			const landed = await wait_record(id2, fits2.area, fits2.digest, 8000);
			check(`ST1: a store the browser's own quota has filled${chromium ? ", here 6 MB by override_quota()" : `, here ${mb(quota)} from PAIN_T_FIREFOX_PREFS`}, refuses the save: the last good record stays, Paint takes it for a full store, with one Storage Error box and no other message, and once there is room the next save lands`, (chromium || quota < 120e6) && filled["refused at 4096"] === "QuotaExceededError" && !!kept && full.record === kept.raw && full.failed.some((line) => /^quota /.test(line)) && full.failed.every((line) => /^(quota|closed) /.test(line)) && full.quota_boxes === 1 && full.other_boxes === 0 && landed?.area === fits2.digest, JSON.stringify({ quota, filled, ...full, kept: full.record === kept?.raw, landed: landed?.area, want: fits2.digest }));
			await forget(id2);
		} else {
			skip("ST1: a store the browser's own quota has filled refuses the save, in Firefox", 'Firefox takes its quota for a whole run: run this section alone with PAIN_T_ONLY=full and PAIN_T_FIREFOX_PREFS={"dom.quotaManager.temporaryStorage.fixedLimit":51200}');
		}
	});

	// 26. The data package cache's limit is one for a login (ST2): the library reads the cache for each of a room's games
	// one after another, and once a read has had no answer in 2 s, the reads after it don't wait. A room of 3 games here,
	// each with a checksum, and the database's opens left unanswered once the page has loaded.
	await section("cachewait", async () => {
		const games = { "Pain-T": { checksum: "storage-cachewait", item_name_to_id: ITEMS, location_name_to_id: {} }, "Other Game 1": { checksum: "other-1", item_name_to_id: { "Thing 1": 900000 }, location_name_to_id: { "Place 1": 910000 } }, "Other Game 2": { checksum: "other-2", item_name_to_id: { "Thing 2": 900001 }, location_name_to_id: { "Place 2": 910001 } } };
		const room = { seed: "STORAGE-CACHEWAIT", items: config_for("STORAGE-CACHEWAIT", 800, 600, 2, 1).items, locations: LOCATIONS, slot_data: { ...SLOT, final_width: 800, final_height: 600, version: "1.1.0" }, packages: games };
		// A stand-in server for a room of several games: RoomInfo names each with its checksum, and GetDataPackage answers
		// for the games asked. Each socket's opening and each command are logged with their times.
		const ROOM = `(() => {
			const CONFIG = ${JSON.stringify(room)};
			const ap = window.__ap = { log: [], opened: [] };
			class FakeWebSocket {
				constructor(url) {
					this.url = String(url); this.readyState = 0; ap.opened.push(performance.now());
					setTimeout(() => { this.readyState = 1; this.onopen?.({}); this._reply([{ cmd: "RoomInfo", version: { major: 0, minor: 6, build: 6, class: "Version" }, generator_version: { major: 0, minor: 6, build: 6, class: "Version" }, tags: [], password: false, permissions: { release: 2, collect: 2, remaining: 2 }, hint_cost: 10, location_check_points: 1, games: ["Archipelago", ...Object.keys(CONFIG.packages)], datapackage_checksums: Object.fromEntries(Object.entries(CONFIG.packages).map(([game, p]) => [game, p.checksum])), seed_name: CONFIG.seed, time: Date.now() / 1000 }]); }, 10);
				}
				send(text) {
					for (const p of JSON.parse(text)) {
						ap.log.push({ t: performance.now(), cmd: p.cmd, games: p.games });
						if (p.cmd === "GetDataPackage") this._reply([{ cmd: "DataPackage", data: { games: Object.fromEntries((p.games ?? Object.keys(CONFIG.packages)).map((game) => [game, CONFIG.packages[game]])) } }]);
						else if (p.cmd === "Connect") this._reply([{ cmd: "Connected", team: 0, slot: 1, players: [{ team: 0, slot: 1, alias: p.name, name: p.name, class: "NetworkPlayer" }], missing_locations: CONFIG.locations, checked_locations: [], slot_data: CONFIG.slot_data, slot_info: { 1: { name: p.name, game: "Pain-T", type: 1, group_members: [], class: "NetworkSlot" } }, hint_points: 0 }, { cmd: "ReceivedItems", index: 0, items: CONFIG.items }]);
						else if (p.cmd === "Get") this._reply([{ ...p, cmd: "Retrieved", keys: Object.fromEntries(p.keys.map((k) => [k, k.startsWith("_read_hints") ? [] : null])) }]);
					}
				}
				close() { this.readyState = 3; }
				_reply(packets) { setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(packets) }); }, 2); }
			}
			Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
			window.WebSocket = FakeWebSocket;
		})();`;
		// From window.__hang_open on, the page's opens of its database are never answered; their own limit is 60 s here.
		const HANG_LATER = `(() => {
			window.paint_hard_open_timeout_ms = 60000;
			const open = IDBFactory.prototype.open;
			IDBFactory.prototype.open = function (name, ...rest) {
				if (name === "pain-t" && rest.length && window.__hang_open) return {};
				return open.call(this, name, ...rest);
			};
		})();`;
		await use_scripts(PAINT, RECORDS, FAST, ROOM, HANG_LATER);
		await open_paint(ready, { hide_connection_window: false });
		const id = await id_now();
		await evaluate(async () => { window.__hang_open = true; (await import("/src/idb.js")).close_db(); });
		await click_connect();
		for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
		await sleep(500);
		const login = await evaluate(() => {
			const opened = window.__ap.opened[0] ?? NaN, connect = window.__ap.log.find((entry) => entry.cmd === "Connect")?.t ?? NaN;
			return { asked: window.__ap.log.filter((entry) => entry.cmd === "GetDataPackage").flatMap((entry) => entry.games ?? ["all"]), socket_to_connect_ms: Math.round(connect - opened) };
		});
		login.logged_in = !(await window_shown());
		check(`ST2: with the cache's reads unanswered, a login into a room of 3 games waits for them once, not once a game: Connect went out ${(login.socket_to_connect_ms / 1000).toFixed(2)} s after the socket opened, where 3 limits are 6 s, with the 3 packages from the server`, login.logged_in && login.asked.length === 3 && login.socket_to_connect_ms >= 1900 && login.socket_to_connect_ms < 4500, JSON.stringify(login));
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		await evaluate((id) => sessionStorage.removeItem("pain-t-unsaved:" + id), id);
		await forget(id);
	});

	// 27. Canvas reads blocked as the page loads, then allowed with no reload, as Firefox's canvas permission allows them
	// (MS1, VH1, and S7's RC1). What the page read and wrote back onto the canvas while reads were blocked is the
	// browser's placeholder, and it stays once they are allowed, so no session saves for the rest of the page. A session
	// with nothing stored says once that it can't save, and to reload once reads are allowed; once they are, the page says
	// once to reload, and the reload finds nothing stored. A session whose record holds a canvas keeps that record as it
	// is, and its message says to reload once reads are allowed.
	await section("allow", async () => {
		// The stand-in for blocked reads of section 12, here until window.__allowed is set.
		const BLOCKED_UNTIL_ALLOWED = `(() => {
			const get = CanvasRenderingContext2D.prototype.getImageData;
			CanvasRenderingContext2D.prototype.getImageData = function (...args) {
				const image = get.apply(this, args);
				if (!window.__allowed) for (let i = 0; i < image.data.length; i += 4) image.data[i] ^= 0x40;
				return image;
			};
		})();`;
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT, BLOCKED_UNTIL_ALLOWED);
		await open_paint(ready);
		const id = await id_now();
		const noise = await evaluate(() => window.paint_hard_auto_copy.read_noise());
		const held = await evaluate(() => window.__kit.paint(0, 100, 4));
		await sleep(1500);
		const blocked = { noise, writes: await writes_of(id), said: await boxes() };
		check("MS1: with canvas reads blocked as the page loads, a session with nothing stored saves nothing, and says once that it can't save its canvas, and to allow canvas reads, then reload", blocked.noise === "blocked" && blocked.writes === 0 && blocked.said.length === 1 && /what you paint before a reload isn't saved/.test(blocked.said[0]) && /then reload this tab\. Paint sends no checks until then\./.test(blocked.said[0]), JSON.stringify(blocked));
		await close_windows();
		await evaluate(() => { window.__allowed = true; });
		await sleep(1000);
		await evaluate(() => window.__kit.paint(100, 160, 5));
		await sleep(1500);
		const unheld = { noise: await evaluate(() => window.paint_hard_auto_copy.read_noise()), writes: await writes_of(id), said: await boxes() };
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT);
		await reload_paint(ready);
		const back = { id: await id_now(), record: await record_of(id), page: await page_area(held.area) };
		check("MS1: ...and once reads are allowed with no reload, neither the held change nor a change after it is saved, the page says once to reload this tab to send checks and save, and the reload finds nothing stored", unheld.noise === null && unheld.writes === 0 && unheld.said.length === 1 && /reload this tab to send checks and save/.test(unheld.said[0]) && back.id === id && back.record === null && back.page.digest !== held.digest, JSON.stringify({ allowed: unheld, back, held: held.digest }));
		await forget(id);
		// A session whose record holds a canvas, at a later load with reads blocked.
		await open_paint(ready);
		const id2 = await id_now();
		const stored = await paint_rows(0, 100, 6);
		const kept = await wait_record(id2, stored.area, stored.digest);
		await sleep(300);
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT, BLOCKED_UNTIL_ALLOWED);
		await reload_paint(ready);
		const at_load = { id: await id_now(), outcome: await evaluate(() => window.paint_hard_session.outcome), noise: await evaluate(() => window.paint_hard_auto_copy.read_noise()) };
		await evaluate(() => window.__kit.paint(100, 160, 8));
		await sleep(1500);
		const held2 = { writes: await writes_of(id2), said: await boxes() };
		check("VH1: a session whose record holds a canvas, loaded with canvas reads blocked, holds a change's save, and says once that its last save stays and to reload once reads are allowed", at_load.id === id2 && at_load.outcome === "restored" && at_load.noise === "blocked" && held2.writes === 0 && held2.said.length === 1 && /Its last save stays as it is/.test(held2.said[0]) && /then reload this tab/.test(held2.said[0]), JSON.stringify({ at_load, ...held2 }));
		await close_windows();
		await evaluate(() => { window.__allowed = true; });
		await evaluate(() => window.__kit.paint(160, 200, 11));
		await sleep(2500);
		const size = await evaluate(() => [main_canvas.width, main_canvas.height]);
		const allowed = { writes: await writes_of(id2), record: await record_of(id2, [0, 0, ...size]) };
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT);
		await reload_paint(ready);
		const reloaded = { id: await id_now(), page: await page_area([0, 0, ...size]) };
		await sleep(1000); // a copy taken would be saved over the record 100 ms after the restore
		reloaded.record = (await record_of(id2))?.raw ?? null;
		check("VH1: ...and once reads are allowed, nothing is written over that record for the rest of the page, nor left as a copy as the page goes: the reload brings the stored canvas back", !!kept && allowed.writes === 0 && allowed.record?.raw === kept.raw && reloaded.id === id2 && reloaded.page.digest === allowed.record.area && reloaded.record === kept.raw, JSON.stringify({ writes: allowed.writes, kept: allowed.record?.raw === kept?.raw, stored: allowed.record?.area ?? null, reloaded, record_kept: reloaded.record === kept?.raw }));
		await forget(id2);
	});

	// 28. Import Session judges a file before anything is stored or the tab's session ends (MS2), and turns away a file of
	// another game than the page has loaded (MS5). A file that keeps the tab's own id saves the change that waits first,
	// then holds the session's saves while it writes: a write the store refuses leaves the session as it was, its canvas
	// and its saves going on (VB1), and the change that waited is stored though the session ends during the write (RK1).
	await section("imports", async () => {
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT);
		await open_paint(ready);
		const id = await id_now();
		const kept = await paint_rows(0, 100, 2);
		const before = await wait_record(id, kept.area, kept.digest);
		await sleep(300);
		// Files named for this tab's own session: one that isn't a session file, one with no palette, one whose canvas is text.
		const files = await evaluate((id) => {
			const canvas = window.__kit.canvas(120, 80, 33).toDataURL("image/png");
			const file = (data) => JSON.stringify({ version: 1, session_id: id, data });
			return [["broken.appaint", file("this is not JSON")], ["nopalette.appaint", file(JSON.stringify({ canvas, goal: null }))], ["text.appaint", file(JSON.stringify({ canvas: "data:text/plain,hello", goal: null, colors: ["rgb(0,0,0)", "rgb(255,255,255)"] }))]];
		}, id);
		const refused = [];
		for (const [name, text] of files) {
			await evaluate((name, text) => window.__kit.import(name, text), name, text);
			await sleep(700);
			refused.push({ name, id: await id_now(), said: await boxes(), record: (await record_of(id, kept.area))?.raw ?? null });
			await close_windows();
		}
		const next = await paint_rows(0, 100, 5);
		const saved = await wait_record(id, next.area, next.digest);
		check("MS2: Import Session judges a file before anything is stored: one that isn't a session file, has no palette or whose canvas isn't an image is refused by name, and the tab goes on in its session, its record as it was, and saves its next change", !!before && refused.every((r) => r.id === id && r.record === before.raw && r.said.length === 1 && r.said[0].includes(`didn't import ${r.name}`)) && saved?.area === next.digest, JSON.stringify({ refused: refused.map((r) => ({ ...r, record: r.record === before?.raw, said: r.said.map((text) => text.slice(0, 120)) })), saved: saved?.area, want: next.digest }));
		await forget(id);
		// A file of another game than the page has loaded.
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT, serve("STORAGE-IMPORTS"));
		await open_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_goal();
		const own = await id_now();
		const mine = await paint_rows(0, 105, 3);
		await wait_record(own, mine.area, mine.digest);
		await sleep(300);
		const ids_before = await stored_ids();
		const elsewhere = await evaluate(() => JSON.stringify({ version: 1, session_id: "storageelsewhere", data: JSON.stringify({ canvas: window.__kit.canvas(205, 105, 7).toDataURL("image/png"), goal: null, connection_info: {}, colors: ["rgb(0,0,0)", "rgb(255,255,255)"], game: { seed: "STORAGE-ELSEWHERE", team: 0, slot: 1 } }) }));
		await evaluate((text) => window.__kit.import("elsewhere.appaint", text), elsewhere);
		await sleep(1000);
		const turned = { id: await id_now(), page: await page_area(mine.area), said: await boxes(), ids: await stored_ids() };
		await close_windows();
		const after = await paint_rows(0, 105, 9);
		const after_saved = await wait_record(own, after.area, after.digest);
		check("MS5: with a game loaded, Import Session turns away a file of another game before anything is stored: one message, and the tab's own session goes on and saves its next change", turned.id === own && turned.page.digest === mine.digest && turned.said.length === 1 && /belongs to another game/.test(turned.said[0]) && same(turned.ids, ids_before) && after_saved?.area === after.digest, JSON.stringify({ own, turned: { ...turned, ids: turned.ids.length, ids_before: ids_before.length }, saved: after_saved?.area, want: after.digest }));
		await forget(own);
		// A file that keeps the tab's own id, with the store refusing every put of a session from window.__refuse on.
		const REFUSE = `(() => {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (...args) {
				if (this.name === "sessions" && window.__refuse) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
				return put.apply(this, args);
			};
		})();`;
		await use_scripts(REFUSE, PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT);
		await open_paint(ready);
		const vb = await id_now();
		const a0 = await paint_rows(0, 60, 1);
		await wait_record(vb, a0.area, a0.digest);
		const file = await export_now();
		const a1 = await paint_rows(60, 120, 3);
		await wait_record(vb, a1.area, a1.digest);
		await sleep(300);
		await evaluate(() => { window.__refuse = true; });
		await paint_rows(120, 180, 9);
		await sleep(1200);
		const unsaved = await whole();
		await close_windows();
		await evaluate((text) => window.__kit.import("own.appaint", text), file);
		await sleep(2500);
		const kept_on = { id: await id_now(), page: await whole(), said: await boxes() };
		await close_windows();
		await evaluate(() => { window.__refuse = false; });
		const a3 = await paint_rows(180, 240, 11);
		const resumed = await wait_record(vb, a3.area, a3.digest);
		check("VB1: Import of a file that keeps the tab's own id, whose write the store refuses, says so and leaves the session as it was: its canvas keeps the changes no save had stored, and it saves again once the store takes writes", JSON.parse(file).session_id === vb && kept_on.id === vb && kept_on.page === unsaved && kept_on.said.some((text) => /couldn't store the session from own\.appaint/.test(text)) && resumed?.area === a3.digest, JSON.stringify({ ...kept_on, unsaved, said: kept_on.said.map((text) => text.slice(0, 140)), resumed: resumed?.area, want: a3.digest }));
		await forget(vb);
		// A file that keeps the tab's own id, imported with a change waiting for its save, saves 3 s apart here. The store
		// refuses the file's record, and the address moves to another session while that write is under way, as Back moves
		// it.
		await use_scripts(PAINT, RECORDS, "window.paint_hard_save_every_ms = 3000;", COUNT_WINDOWS, KIT);
		await open_paint(ready);
		const rk = await id_now();
		const r0 = await paint_rows(0, 60, 1);
		await wait_record(rk, r0.area, r0.digest);
		const rk_file = await export_now();
		const other = `${rk}o`;
		await put_session(other, 205, 105, 7, 60000);
		const r1 = await paint_rows(60, 120, 3);
		await wait_record(rk, r1.area, r1.digest, 8000);
		const waited = await evaluate(async (text, own, other) => {
			const r2 = await window.__paint(120, 180, 6);
			const put = IDBObjectStore.prototype.put;
			window.__moved = false;
			IDBObjectStore.prototype.put = function (value, ...rest) {
				// The file's record has no goal size of its own, where the session's saves have one.
				if (this.name === "sessions" && value?.id === own && value.final_width === null && !window.__moved) {
					window.__moved = true;
					history.pushState(null, "", "#local:" + other);
					$(window).triggerHandler("popstate");
					throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
				}
				return put.call(this, value, ...rest);
			};
			try { await window.__kit.import("own.appaint", text); } finally { IDBObjectStore.prototype.put = put; }
			return r2;
		}, rk_file, rk, other);
		await sleep(1500);
		await wait_ready();
		await sleep(1000);
		const moved = { id: await id_now(), moved: await evaluate(() => window.__moved), record: (await record_of(rk, waited.area))?.area ?? null };
		check("RK1: ...and a change that waited for its save as such an import began is stored, though the session ends during the import's write", moved.moved === true && moved.id === other && moved.record === waited.digest, JSON.stringify({ ...moved, want: waited.digest }));
		await close_windows();
		for (const key of [rk, other]) await forget(key);
	});

	// 29. Import writes under the file's id only where that is this tab's own session (MS3): a tab that imports the export
	// of a session another tab has open goes on under an id of its own, and the other tab's record stays as that tab last
	// saved it.
	await section("importtab", async () => {
		await use_scripts(PAINT, RECORDS, FAST, KIT);
		await open_paint(ready);
		const x = await id_now();
		const first = await paint_rows(0, 40, 0);
		await wait_record(x, first.area, first.digest);
		const file = await export_now();
		const second = await paint_rows(40, 100, 7);
		const newer = await wait_record(x, second.area, second.digest);
		await sleep(400);
		const tab = await new_tab();
		for (const script of [RECORDS, FAST, PAINT, KIT]) await tab.add_init_script(script);
		await tab.open(`${ORIGIN}/`);
		await wait_ready(tab.evaluate);
		const y = await tab.evaluate(() => window.paint_hard_session.id);
		await tab.evaluate((text) => window.__kit.import("export.appaint", text), file);
		for (let i = 0; i < 80 && !(await tab.evaluate((y) => window.paint_hard_session.id !== y && window.paint_hard_session.ready === true, y).catch(() => false)); i++) await sleep(100);
		await sleep(800);
		const b = await tab.evaluate((area) => ({ id: window.paint_hard_session.id, copied_from: window.paint_hard_session.copied_from, page: __t.canvas(main_ctx, ...area) }), first.area);
		const record_x = await record_of(x, second.area);
		check("MS3: a tab that imports the export of a session another tab has open goes on under an id of its own with the file's canvas, and the other tab's record stays as that tab last saved it", !!newer && record_x?.raw === newer.raw && b.id !== x && b.id !== y && b.copied_from === null && b.page === first.digest, JSON.stringify({ x, y, b, kept: record_x?.raw === newer?.raw, file: first.digest }));
		await close_tab(tab);
		for (const key of new Set([x, y, b.id])) await forget(key);
	});

	// 30. A database that opened on this page and then fails to open for a later use (VB2): Manage Storage says that the
	// sessions kept there aren't listed, with no All clear, and a session the address moves to fails its restore with a
	// message, writing nothing to localStorage under an id the database may hold.
	await section("later", async () => {
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS, KIT, failing_open("window.__break_open"));
		await open_paint(ready);
		const id = await id_now();
		const mine = await paint_rows(0, 100, 2);
		await wait_record(id, mine.area, mine.digest);
		const later_id = `${id}l`;
		await put_session(later_id, 300, 200, 5, 86400000);
		await sleep(300);
		const state = await evaluate(async () => (await import("/src/idb.js")).idb_state());
		await evaluate(() => { window.__break_open = true; });
		await evaluate(async () => (await import("/src/manage-storage.js")).manage_storage());
		await sleep(1500);
		const listed = await evaluate(() => { const w = document.querySelector(".storage-manager"); return { unlisted: w?.querySelector(".storage-unlisted")?.textContent ?? "", text: w?.textContent.replace(/\s+/g, " ") ?? "" }; });
		await close_windows();
		check("VB2: with the database open earlier on the page and a later open failing, Manage Storage says that the sessions kept there aren't listed and that opening it again tries once more, with no All clear", state === "open" && /couldn't open its storage just now/.test(listed.unlisted) && /aren't listed/.test(listed.unlisted) && !/All clear/.test(listed.text), JSON.stringify({ state, ...listed, text: listed.text.slice(0, 300) }));
		await evaluate((id) => { location.hash = "local:" + id; }, later_id);
		for (let i = 0; i < 40 && (await id_now()) === id; i++) await sleep(100);
		await wait_ready();
		await sleep(400);
		const switched = { ...(await session_now()), outcome: await evaluate(() => window.paint_hard_session.outcome), said: await boxes() };
		await close_windows();
		await paint_rows(0, 50, 7);
		await sleep(1500);
		const local = await local_keys();
		check("VB2: ...and a session the address moves to then fails its restore, saying its storage didn't open this time, and goes on under a new id, with nothing written to localStorage under the id the database holds", switched.outcome === "failed" && switched.id !== later_id && switched.said.length === 1 && /storage didn't open this time/.test(switched.said[0]) && !local.includes(`image#${later_id}`), JSON.stringify({ switched, local }));
		await evaluate(() => { window.__break_open = false; });
		for (const key of new Set([id, later_id, switched.id, await id_now()])) await forget(key);
	});

	// 31. Manage Storage lists while this tab's save lands (VB3): Firefox lets go of the file of a canvas that a save replaced
	// once the connection that read it has closed, as each save closes it, so a row whose canvas gives no thumbnail is read
	// again before it says the canvas can't be read. The list's decodes are held 1.2 s each here, so that this tab's row,
	// below one saved later, is decoded after its save has landed.
	await section("listing", async () => {
		const SLOW_DECODES = `(() => {
			const real = window.createImageBitmap;
			window.createImageBitmap = (...args) => (window.__hold_ms ? new Promise((resolve, reject) => setTimeout(() => real.apply(window, args).then(resolve, reject), window.__hold_ms)) : real.apply(window, args));
		})();`;
		await use_scripts(PAINT, RECORDS, FAST, KIT, SLOW_DECODES);
		await open_paint(ready);
		const id = await id_now();
		const first = await paint_rows(0, 100, 1);
		await wait_record(id, first.area, first.digest);
		const newer = `${id}n`;
		await put_session(newer, 300, 200, 9, -3600000);
		await sleep(300);
		await evaluate(async () => { window.__hold_ms = 1200; (await import("/src/manage-storage.js")).manage_storage(); });
		const second = await paint_rows(100, 200, 5);
		const resaved = await wait_record(id, second.area, second.digest, 3000);
		const rows = () => evaluate(() => [...document.querySelectorAll(".storage-manager tr")].map((tr) => ({ id: tr.dataset.session, text: tr.querySelector(".session-details")?.textContent ?? "", thumbs: [...tr.querySelectorAll(".thumbnail-container > *")].map((t) => `${t.width}x${t.height}`) })));
		for (let i = 0; i < 150 && !(await rows()).some((row) => row.id === id); i++) await sleep(100);
		await sleep(500);
		const own = (await rows()).find((row) => row.id === id) ?? null;
		await evaluate(() => { window.__hold_ms = 0; });
		await close_windows();
		check("VB3: Manage Storage shows this tab's row with its canvas when the tab's save lands while the list is being made", resaved?.area === second.digest && !!own && !/can't be read/.test(own.text) && own.thumbs[0] !== "0x0", JSON.stringify({ resaved: resaved?.area === second.digest, own }));
		for (const key of [id, newer]) await forget(key);
	});

	// 32. Manage Storage guards a session a tab has open (MS4): in another tab its row is marked, and its Remove is off with a
	// title that says to close that tab first, so its record stays. The focus starts on Close, so a key pressed as the
	// window opens removes nothing.
	await section("manage", async () => {
		await use_scripts(PAINT, RECORDS, FAST, KIT);
		await open_paint(ready);
		const x = await id_now();
		const painted = await paint_rows(0, 60, 0);
		const stored = await wait_record(x, painted.area, painted.digest);
		await sleep(400);
		const tab = await new_tab();
		for (const script of [RECORDS, FAST]) await tab.add_init_script(script);
		await tab.open(`${ORIGIN}/`);
		await wait_ready(tab.evaluate);
		const in_b = await tab.evaluate(async (x) => {
			(await import("/src/manage-storage.js")).manage_storage();
			for (let i = 0; i < 50 && !document.querySelector(`.storage-manager tr[data-session="${x}"]`); i++) await new Promise((resolve) => setTimeout(resolve, 100));
			const row = document.querySelector(`.storage-manager tr[data-session="${x}"]`), remove = row?.querySelector(".remove-button");
			const seen = { text: row?.querySelector(".session-details")?.textContent ?? null, disabled: remove?.disabled ?? null, title: remove?.getAttribute("title") ?? null };
			remove?.click();
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return seen;
		}, x);
		const after = await record_of(x, painted.area);
		check("MS4: in another tab, Manage Storage marks a session a tab has open, and its Remove is off with a title that says to close that tab first: the session's record stays", /\(open in another tab\)$/.test(in_b.text ?? "") && in_b.disabled === true && /Close that tab first/.test(in_b.title ?? "") && !!stored && after?.raw === stored.raw, JSON.stringify({ in_b, kept: after?.raw === stored?.raw }));
		await close_tab(tab);
		// This tab's own session, with an older one below it.
		const older = `${x}old`;
		await put_session(older, 100, 60, 3, 86400000);
		const ids_before = await stored_ids();
		const list = await evaluate(async () => {
			(await import("/src/manage-storage.js")).manage_storage();
			for (let i = 0; i < 50 && document.querySelectorAll(".storage-manager tr").length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100));
			await new Promise((resolve) => setTimeout(resolve, 500));
			const focus = document.activeElement;
			return { rows: document.querySelectorAll(".storage-manager tr").length, focus: focus?.textContent?.trim() ?? null, on_remove: !!focus?.classList?.contains("remove-button") };
		});
		if (chromium) {
			await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
			await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
			await sleep(1000);
		}
		const ids_after = await stored_ids();
		check(`MS4: ...and as Manage Storage opens, the focus starts on Close, not on a Remove button${chromium ? ", so Enter removes nothing" : ""}`, list.rows >= 1 && list.focus === "Close" && !list.on_remove && same(ids_after, ids_before), JSON.stringify({ list, removed: ids_before.filter((other) => !ids_after.includes(other)) }));
		await close_windows();
		for (const key of [x, older]) await forget(key);
	});

	// 33. A browser restart on the same profile keeps the session: every process of the browser is a new one, and the page
	// opens at the session's address.
	await section("restart", async () => {
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready);
		const id = await id_now();
		const painted = await paint_rows(0, 100, 31);
		await wait_record(id, painted.area, painted.digest);
		await sleep(300);
		const old_processes = browser_processes().map((p) => p.pid);
		const closed = await restart_browser();
		scripts = [];
		await use_scripts(PAINT, RECORDS, FAST);
		await open_paint(ready, { hash: `local:${id}` });
		const back = { id: await id_now(), page: await page_area(painted.area) };
		const still_running = browser_processes().filter((p) => old_processes.includes(p.pid)).length;
		check("a session comes back after the browser restarts on the same profile", closed.left === 0 && old_processes.length > 0 && still_running === 0 && back.id === id && back.page.digest === painted.digest, JSON.stringify({ closed, processes_before: old_processes.length, of_them_still_running: still_running, back, want: painted.digest }));
		await forget(id);
	});

	// 34. Another tab opens a later version of the database, as the page of the next deploy would. This page lets go of its
	// own connection at once, so that tab goes on, and says at its next save that it's older than the database now. A tab
	// that has to wait, for a page that doesn't let go, says why, and goes on once that page does. Loaded again at the
	// older version, this page says so and saves nowhere.
	// Firefox reports a wait only when the last of the database's other pages to answer is one that keeps its connection:
	// with this page letting go while another kept its own, the wait was reported in 5 of 9 runs. So the page that
	// doesn't let go is the only one with a connection when its check is made.
	await section("version", async () => {
		const version_now = (tab) => tab.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("pain-t"); r.onsuccess = () => { resolve(r.result.version); r.result.close(); }; r.onerror = () => resolve(null); setTimeout(() => resolve(null), 500); }));
		await use_scripts(PAINT, RECORDS, FAST, COUNT_WINDOWS);
		await open_paint(ready);
		const id = await id_now();
		const painted = await paint_rows(0, 100);
		const before = await wait_record(id, painted.area, painted.digest);
		// Each save closes the page's connection. The page opens it again, and holds it as it does from its restore's read to
		// its first save.
		await evaluate(async () => { await (await import("/src/idb.js")).open_db(); });
		const later = await new_tab();
		await later.add_init_script("window.paint_hard_idb_version = 2;");
		await later.open();
		let went_on = null;
		for (let i = 0; i < 80; i++) {
			went_on = { ready: await later.evaluate(() => window.paint_hard_session?.ready ?? null).catch(() => null), version: await version_now(later).catch(() => null) };
			if (went_on.ready && went_on.version === 2) break;
			await sleep(100);
		}
		check("a tab that opens a later version of Paint's database goes on at once: this tab lets go of its connection for it", went_on.ready === true && went_on.version === 2, JSON.stringify(went_on));
		await paint_rows(0, 100, 17);
		let told = false;
		for (let i = 0; i < 30 && !told; i++) {
			await sleep(100);
			told = await shown("updated in another tab");
		}
		const after = await record_of(id, painted.area);
		check("...and this tab, older than the database now, says so at its next save, and its last save stays as it was", told && !!before && after?.raw === before.raw && page_errors.length === 0, JSON.stringify({ told, page_errors: page_errors.slice(0, 2), before: before?.raw, after: after?.raw }));
		await close_tab(later);
		// A page that hears a still later version ask and doesn't let go, as a tab of another of the site's pages could.
		const holder = await new_tab();
		await holder.open(BLANK);
		// Its open gives up after 5 s: it would wait without end behind a page that kept an older connection through the last upgrade.
		await holder.evaluate(() => new Promise((resolve) => { const request = indexedDB.open("pain-t"); request.onsuccess = () => { window.__held = request.result; window.__held.onversionchange = () => { window.__asked = true; }; resolve(); }; setTimeout(resolve, 5000); }));
		const latest = await new_tab();
		await latest.add_init_script("window.paint_hard_idb_version = 3;");
		await latest.open();
		let waiting = null;
		for (let i = 0; i < 100; i++) {
			waiting = await latest.evaluate(() => ({ ready: window.paint_hard_session?.ready ?? null, message: [...document.querySelectorAll(".window")].some((w) => /waiting for another of its tabs/.test(w.textContent)) })).catch(() => null);
			if (waiting?.message) break;
			await sleep(100);
		}
		await holder.evaluate(() => window.__held?.close());
		let freed = null;
		for (let i = 0; i < 80; i++) {
			freed = { ready: await latest.evaluate(() => window.paint_hard_session?.ready ?? null).catch(() => null), version: await version_now(latest).catch(() => null) };
			if (freed.ready && freed.version === 3) break;
			await sleep(100);
		}
		check("...a tab that has to wait, for a page that keeps its connection at the older version, says why, and goes on once that page lets go", waiting?.message === true && waiting.ready === false && freed.ready === true && freed.version === 3, JSON.stringify({ waiting, freed }));
		await close_tab(latest);
		await close_tab(holder);
		// The same page loaded again, still at the older version: it can't read the database.
		await reload_paint(ready);
		const older = { said: await shown("updated in another tab"), backend: (await session_now()).backend };
		await paint_rows(0, 100, 23);
		await sleep(800);
		Object.assign(older, { local: await local_keys(), record: (await record_of(id, painted.area))?.raw ?? null });
		check("...and loaded again at the older version, it says so and saves nowhere: no record goes to localStorage in the database's place", older.said && older.backend === null && older.local.length === 0 && !!before && older.record === before.raw && page_errors.length === 0, JSON.stringify({ ...older, before: before?.raw, page_errors: page_errors.slice(0, 2) }));
	});

	check("no page errors", page_errors.length === 0, page_errors.slice(0, 5).join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	if (left_out.length) skip(`${left_out.length} of the suite's ${SECTIONS.length} sections: ${left_out.join(", ")}`, `PAIN_T_ONLY names ${only.join(", ")}`);
	finish();
}
