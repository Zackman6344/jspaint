// End-to-end test of the session restore (task 7.5 of the fork's ROADMAP, Phase 7). A tab keeps its canvas in
// IndexedDB under its #local: id (task 7.4; storage.e2e.mjs checks the storage itself), and a reload restores it at its
// own size, where it used to be cut to the 800x600 the page starts at. Records from before 7.4 move from localStorage.
// Every autosave and the Connect button wait until the restore lands or fails, and a restore that fails or doesn't land
// in time says so, leaves the record as stored and goes on in a new session. A session that ends before its restore has
// landed saves nothing, and a page that goes before then leaves no copy of its canvas. The restored goal stays as stored
// until a login draws it at the game's size. A session belongs to the game it first logs into, and a
// login into another game goes on in a new session with a blank canvas. With a game loaded, the address of another
// game's stored session doesn't open it, and a session that starts with nothing stored belongs to the game of the canvas
// the page shows. A login into another game saves the session it leaves once, with that game's own connection and goal
// size, and says where its canvas stays. A restore that fails takes its palette and goal off the page again. A page load
// takes the room password out of the records an older version left. Connect makes one login at a time. Another slot or
// another team of one seed is another game. The page logs in through its own Connect button to a stand-in server
// (stand-in-server.mjs). It runs in Chrome and Firefox (decision 16).
// Usage: node test/paint-hard/sessions.e2e.mjs [--browser=chrome|firefox] [--headful]. PAIN_T_ONLY=<section>,<section>
// runs only those of the sections restore, address, typed, switch, failed, passwords, login and slots, and prints the
// others as a SKIP line. Set BROWSER_PATH if the browser isn't in its default folder.
import { add_init_script, check, evaluate, finish, open_paint, ORIGIN, page_errors, reload_paint, remove_init_script, sleep } from "./harness.mjs";
import { RECORDS, forget, local_keys, record_of, writes_of } from "./session-records.mjs";
import { CONTRACT, ITEMS, LOCATIONS, click_connect, connect, fake_server, id_of, window_shown } from "./stand-in-server.mjs";

// What every page gets before it loads: session-records.mjs's helpers, and saves paced from 200 ms, where play waits 5 s
// between saves (task 7.4), so a save follows each change here within 200 ms, or 50 times the last save's cost where
// that is longer.
const HELPERS = `${RECORDS}\nwindow.paint_hard_save_every_ms = 200;`;
// The canvas decode held back until the test lets it go, as a slow machine or a big canvas would hold it:
// createImageBitmap is the restore's last step before it draws. __decodes_held() counts the decodes held now.
const HOLD_DECODE = `(() => {
	const real = window.createImageBitmap, held = [];
	window.createImageBitmap = (...args) => new Promise((resolve, reject) => held.push(() => real.apply(window, args).then(resolve, reject)));
	window.__release_decodes = () => { for (const go of held.splice(0)) go(); };
	window.__decodes_held = () => held.length;
})();`;
// The same, with the restore's timeout at 1.5 s.
const TIMEOUT_DECODE = `${HOLD_DECODE}\nwindow.paint_hard_restore_timeout_ms = 1500;`;

const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
const add_script = add_init_script;
const drop_script = remove_init_script;
let server = null;
const serve = async (config) => {
	if (server) await drop_script(server);
	server = await add_script(fake_server(config));
};

// A game for the stand-in: its seed, the goal's size, and the canvas items it sends at Connect, beside Magnifier and Brush.
// The rest of its slot data is the world's own at the defaults, the 5x5 start among it.
const SLOT = CONTRACT.slot_data;
const game = (seed, final_width, final_height, widths, heights, more = []) => ({ seed, final_width, final_height, widths, heights, more });
const size_of = (g) => `${Math.min(SLOT.start_width + g.widths * SLOT.canvas_width_increment, g.final_width)}x${Math.min(SLOT.start_height + g.heights * SLOT.canvas_height_increment, g.final_height)}`;
const config_for = (g) => ({
	seed: g.seed,
	items: ["Magnifier", "Brush", ...Array(g.widths).fill("Progressive Canvas Width"), ...Array(g.heights).fill("Progressive Canvas Height"), ...g.more].map((name, i) => ({ item: id_of(name), location: 2199000 + 9000 + i, player: 1, flags: 1 })),
	late_item: { item: id_of("Progressive Canvas Width"), location: 2199000 + 9900, player: 1, flags: 1 },
	locations: LOCATIONS,
	slot_data: { ...SLOT, final_width: g.final_width, final_height: g.final_height, version: "1.1.0" },
	package: { checksum: "items-py", item_name_to_id: ITEMS, location_name_to_id: {} },
});

const id_now = () => evaluate(() => window.paint_hard_session?.id ?? location.hash.match(/local:([^,]*)/)?.[1] ?? null);
const size_now = () => evaluate(() => `${main_canvas.width}x${main_canvas.height}`);
const restore_now = () => evaluate(() => ({ ready: window.paint_hard_session?.ready ?? null, outcome: window.paint_hard_session?.outcome ?? null, id: window.paint_hard_session?.id ?? null }));
const goal_now = () => evaluate(() => ({ size: `${goal_canvas.width}x${goal_canvas.height}`, digest: __t.digest(goal_ctx.getImageData(0, 0, goal_canvas.width, goal_canvas.height).data) }));
const page_area = (area) => evaluate((area) => ({ size: `${main_canvas.width}x${main_canvas.height}`, digest: __t.canvas(main_ctx, ...area) }), area);
const message_shown = (pattern) => evaluate((source) => [...document.querySelectorAll(".window")].some((w) => w.offsetParent !== null && new RegExp(source).test(w.textContent) && /Manage Storage|connect/.test(w.textContent)), pattern);
const wait_goal = async () => {
	for (let i = 0; i < 50 && !(await evaluate(() => goal_ctx.getImageData(goal_canvas.width - 1, goal_canvas.height - 1, 1, 1).data[3] === 255)); i++) await sleep(100);
};
const wait_ready = async () => {
	for (let i = 0; i < 60 && !(await evaluate(() => window.paint_hard_session?.ready === true)); i++) await sleep(100);
};
// Waits until a session's record holds what `holds` asks of it. It gives up 3 s past the time the session's own pace
// puts between two saves, which is 50 times what the last save held the page where that is over 200 ms (task 7.4).
const wait_stored = async (id, area, holds) => {
	let record = null;
	for (const began = Date.now(); ; await sleep(100)) {
		record = await record_of(id, area);
		if (holds(record)) break;
		const every = await evaluate(() => window.paint_hard_session?.save_every?.every ?? 0).catch(() => 0);
		if (Date.now() - began > 3000 + every) break;
	}
	return record;
};
// Waits that way for a session's record to hold a rectangle's digest, or a palette color.
const wait_record = (id, area, digest) => wait_stored(id, area, (record) => record?.area === digest);
const wait_color = (id, index, color) => wait_stored(id, null, (record) => record?.colors?.[index] === color);
// Waits up to 15 s until the restore has read its record from IndexedDB and waits on the canvas's decode, which
// HOLD_DECODE holds. Whether it got there. `held` is how many decodes the page holds by then: 2 for the second restore
// in one page, the first one's still held.
const wait_held = async (held = 1) => {
	for (let i = 0; i < 150; i++) {
		if (await evaluate((held) => window.__decodes_held?.() >= held && window.paint_hard_session?.backend === "idb", held).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};
// Waits up to 20 s until no page holds a session's Web Lock. A session that ends lets go of its own once its last save
// has landed, or at once with none to make. Whether the lock went.
const lock_let_go = async (id) => {
	for (let i = 0; i < 200; i++) {
		if (await evaluate(async (name) => !(await navigator.locks.query()).held.some((lock) => lock.name === name), `pain-t-session:${id}`)) return true;
		await sleep(100);
	}
	return false;
};
// When the copy a page left of a session in sessionStorage as it went was made, or null with none there.
const copy_left_at = (id) => evaluate((id) => JSON.parse(sessionStorage.getItem("pain-t-unsaved:" + id) ?? "null")?.saved_at ?? null, id);
// Paints the pattern, shifted by `salt`, over rows y0 to y1, the whole width, as one undo step, which autosaves 100 ms
// later or as soon after as the pace allows. Returns the rectangle painted, [x, y, width, height], and its digest.
const paint_rows = (y0, y1, salt = 0) => evaluate(async (y0, y1, salt) => {
	const fn = await import("/src/functions.js");
	const width = main_canvas.width, image = main_ctx.createImageData(width, y1 - y0);
	for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) image.data.set([...__t.pattern(x + salt, y + salt * 3), 255], ((y - y0) * width + x) * 4);
	try { fn.undoable({ name: "Test rows" }, () => main_ctx.putImageData(image, 0, y0)); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
	const area = [0, y0, width, y1 - y0];
	return { area, digest: __t.canvas(main_ctx, ...area) };
}, y0, y1, salt);
// The same with no game connected, where undoable() throws at its send before it asks for a save: the change asks for
// its save itself.
const paint_quiet = (y0, y1, salt) => evaluate(async (y0, y1, salt) => {
	const width = main_canvas.width, image = main_ctx.createImageData(width, y1 - y0);
	for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) image.data.set([...__t.pattern(x + salt, y + salt * 3), 255], ((y - y0) * width + x) * 4);
	main_ctx.putImageData(image, 0, y0);
	(await import("/src/helpers.js")).$G.triggerHandler("session-update");
	const area = [0, y0, width, y1 - y0];
	return { area, digest: __t.canvas(main_ctx, ...area) };
}, y0, y1, salt);
// How many pixels of a rectangle of the canvas are white.
const white_in = (area) => evaluate((area) => {
	const data = main_ctx.getImageData(...area).data;
	let white = 0;
	for (let i = 0; i < data.length; i += 4) if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255 && data[i + 3] === 255) white++;
	return white;
}, area);

// A game played in a new tab: it logs in, paints the pattern over rows y0 to y1 and waits for the autosave; then the tab
// reloads, and logs in again. What the page and the record hold after the reload and after the login. Where the rows
// came back from the copy the page left as it went, the record follows the restore, so its read waits for it.
const round_trip = async (g, [y0, y1]) => {
	await serve(config_for(g));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const id = await id_now(), size = await size_now(), goal = await goal_now();
	const painted = await paint_rows(y0, y1);
	const saved = await wait_record(id, painted.area, painted.digest);
	await reload_paint(ready, { hide_connection_window: false });
	const reloaded = { id: await id_now(), page: await page_area(painted.area), record: await wait_record(id, painted.area, painted.digest) };
	await connect();
	await sleep(400); // the login's autosave
	const connected = { id: await id_now(), page: await page_area(painted.area), record: await record_of(id, painted.area) };
	return { seed: g.seed, id, size, want: size_of(g), goal, painted, saved, reloaded, connected };
};
// Whether a step of a round trip kept the session: the same id, the canvas at its size with the rows painted, in the page
// and in the record.
const kept = (trip, step) => step.id === trip.id && step.page.size === trip.size && step.page.digest === trip.painted.digest && step.record?.size === trip.size && step.record?.area === trip.painted.digest;
const show = (trip, step) => JSON.stringify({ seed: trip.seed, size: trip.size, want: trip.want, painted: trip.painted.digest, saved: trip.saved?.area, id_kept: step.id === trip.id, page: step.page, record: step.record && { size: step.record.size, area: step.record.area } });

// The suite's sections, each with pages of its own. PAIN_T_ONLY can name some of them.
const SECTIONS = ["restore", "address", "typed", "switch", "failed", "passwords", "login", "slots"];
const only = process.env.PAIN_T_ONLY ? process.env.PAIN_T_ONLY.split(",") : SECTIONS;
for (const name of only) if (!SECTIONS.includes(name)) throw new Error(`PAIN_T_ONLY names ${name}, not one of ${SECTIONS.join(", ")}`);
const left_out = SECTIONS.filter((name) => !only.includes(name));
// The init scripts a section adds with use(), each removed with unuse() or at the section's end.
const section_scripts = new Set();
const use = async (source) => {
	const id = await add_script(source);
	section_scripts.add(id);
	return id;
};
const unuse = async (id) => {
	section_scripts.delete(id);
	await drop_script(id);
};
const section = async (name, run) => {
	if (!only.includes(name)) return;
	const began = Date.now();
	try {
		await run();
	} catch (error) {
		check(`${name}: ran without exceptions`, false, error?.stack || String(error));
	}
	for (const id of section_scripts) await unuse(id);
	console.log(`(${name}: ${((Date.now() - began) / 1000).toFixed(1)} s)`);
};

// For the page in the sections after the restore's, beside session-records.mjs's helpers: a canvas of the test pattern,
// or of the goal's own top-left pixels; its PNG as a Blob, and its digest; a value put into one of Paint's stores behind
// Paint's back, a session record planted that way, and a stored canvas made unreadable; the SHA-256 of a Blob; and a
// field of the connection form typed in as a player types: the value, then the input event typing fires.
const PAGE = `window.__s = {
	canvas(width, height, salt = 0) {
		const c = document.createElement("canvas");
		c.width = width;
		c.height = height;
		const ctx = c.getContext("2d"), image = ctx.createImageData(width, height);
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([...__t.pattern(x + salt, y + salt * 3), 255], (y * width + x) * 4);
		ctx.putImageData(image, 0, 0);
		return c;
	},
	goal_part(width, height) {
		const c = document.createElement("canvas");
		c.width = width;
		c.height = height;
		c.getContext("2d").putImageData(goal_ctx.getImageData(0, 0, width, height), 0, 0);
		return c;
	},
	blob: (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/png")),
	digest: (canvas) => __t.digest(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data),
	async put(store, value) {
		const db = await __t.db();
		try {
			await new Promise((resolve, reject) => {
				const transaction = db.transaction(store, "readwrite");
				transaction.objectStore(store).put(value);
				transaction.oncomplete = resolve;
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { db.close(); }
	},
	async plant(id, canvas, game, fields = {}) {
		await __s.put("sessions", { id, version: 2, canvas: await __s.blob(canvas), width: canvas.width, height: canvas.height, final_width: 800, final_height: 600, goal: null, colors: ["rgb(0,0,0)", "rgb(255,255,255)"], connection: { host: "old.test", port: "1", slot: "Old" }, game, saved_at: Date.now() - 60000, ...fields });
		return __s.digest(canvas);
	},
	async unreadable(id) {
		const record = await __t.read("sessions", id);
		await __s.put("sessions", { ...record, canvas: new Blob(["not a png"], { type: "image/png" }) });
	},
	async sha256(blob) {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
		return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	},
	type(name, value) {
		const field = document.querySelector("[name=" + name + "]");
		field.value = value;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	},
};`;
// Alerts, kept in the page where they would open a dialog.
const ALERTS = "window.__alerts = [];\nwindow.alert = (message) => { window.__alerts.push(String(message)); };";
// The open of Paint's database answers 3 s late, as a hard disk's first open can.
const SLOW_OPEN = `(() => {
	const real = IDBFactory.prototype.open;
	IDBFactory.prototype.open = function (name, ...rest) {
		if (name !== "pain-t") return real.call(this, name, ...rest);
		const proxy = { result: undefined, error: null, transaction: null };
		setTimeout(() => {
			const request = real.call(this, name, ...rest);
			request.onupgradeneeded = (event) => { proxy.result = request.result; proxy.transaction = request.transaction; proxy.onupgradeneeded?.(event); };
			request.onblocked = (event) => proxy.onblocked?.(event);
			request.onsuccess = (event) => { proxy.result = request.result; proxy.onsuccess?.(event); };
			request.onerror = (event) => { proxy.error = request.error; proxy.onerror?.(event); };
		}, 3000);
		return proxy;
	};
})();`;
// For a page that has loaded: the stand-in's answer to Connect held `ms`, and canvas decodes held as HOLD_DECODE holds
// them until the test lets them go.
const hold_login_and_decodes = (ms) => {
	const proto = window.WebSocket.prototype, reply = proto._reply;
	proto._reply = function (packets) {
		if (packets.some((packet) => packet.cmd === "Connected")) return setTimeout(() => reply.call(this, packets), ms);
		return reply.call(this, packets);
	};
	const real = window.createImageBitmap, held = [];
	window.createImageBitmap = (...args) => new Promise((resolve, reject) => held.push(() => real.apply(window, args).then(resolve, reject)));
	window.__release_decodes = () => {
		window.createImageBitmap = real;
		for (const go of held.splice(0)) go();
	};
	window.__decodes_held = () => held.length;
};
// For a page that has loaded, over the stand-in: a Connect for the slot Nobody is refused, as MultiServer refuses a slot
// it doesn't know, with the socket left open; the answer to any other Connect waits window.__hold_ms; and while
// window.__no_package is set, a room's data package never comes.
const refusing_stand_in = () => {
	const proto = window.WebSocket.prototype, send = proto.send, reply = proto._reply;
	proto.send = function (text) {
		const connect = JSON.parse(text).find((packet) => packet.cmd === "Connect");
		if (connect?.name === "Nobody") {
			__ap.log.push({ t: performance.now(), cmd: "Connect", refused: true });
			return reply.call(this, [{ cmd: "ConnectionRefused", errors: ["InvalidSlot"] }]);
		}
		return send.call(this, text);
	};
	proto._reply = function (packets) {
		if (window.__hold_ms && packets.some((packet) => packet.cmd === "Connected")) return setTimeout(() => reply.call(this, packets), window.__hold_ms);
		if (window.__no_package && packets.some((packet) => packet.cmd === "DataPackage")) return undefined;
		return reply.call(this, packets);
	};
};
// The windows shown beside the connection window whose text matches a pattern: their text, and how many there are.
const shown_texts = (pattern) => evaluate((source) => [...document.querySelectorAll(".window")].filter((w) => w.offsetParent !== null && !/Archipelago Connection Options/.test(w.textContent) && new RegExp(source).test(w.textContent)).map((w) => w.textContent.replace(/\s+/g, " ").trim().slice(0, 300)), pattern);
const shown = async (pattern) => (await shown_texts(pattern)).length;
const REFUSED = "belongs to another game, or to none yet";
const LEFT = "logged into another game";
// Changes the address to a session's, as a typed address or a bookmark does in a tab already open on Paint, and waits up
// to 5 s until the tab is in that session with its restore over, or a message has turned the address away.
const go_to = async (id) => {
	const said = await shown(REFUSED);
	await evaluate((id) => { location.hash = "local:" + id; }, id);
	for (let i = 0; i < 50; i++) {
		if (await evaluate((id) => window.paint_hard_session?.id === id && window.paint_hard_session.ready === true, id).catch(() => false)) break;
		if ((await shown(REFUSED)) > said) break;
		await sleep(100);
	}
	await sleep(300);
};
// A login at an address, as a player makes one: the three fields filled and Connect clicked; log_in() then waits up to
// 10 s for the connection window to go.
const click_login = (host, port, slot) => evaluate((host, port, slot) => {
	$("[name=aphost]").val(host);
	$("[name=apport]").val(port);
	$("[name=apslot]").val(slot);
	$("button").filter((i, b) => b.textContent === "Connect!").trigger("click");
}, host, port, slot);
const log_in = async (host, port, slot) => {
	await click_login(host, port, slot);
	for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
	await sleep(500);
};
const click_as = (slot) => click_login("fake.test", "38281", slot);
// The connection drops, and the stand-in serves the game of `config` from the next connection on.
const drop_to = async (config) => {
	await evaluate((config) => { __ap.use(config); __ap.drop(); }, config);
	for (let i = 0; i < 30 && !(await window_shown()); i++) await sleep(100);
};
const form_now = () => evaluate(() => ({ host: $("[name=aphost]").val(), port: $("[name=apport]").val(), slot: $("[name=apslot]").val() }));
// Connect as the player sees it, and the stand-in's count of sockets, open sockets, Connect commands and asks for a data
// package.
const connect_state = () => evaluate(() => {
	const button = $("button").filter((i, b) => b.textContent === "Connect!");
	return { disabled: !!button.prop("disabled"), line: $(".ap-status").text(), sockets: __ap.sockets.length, open: __ap.sockets.filter((s) => s.readyState === 1).length, connects: __ap.log.filter((p) => p.cmd === "Connect").length, package_asks: __ap.log.filter((p) => p.cmd === "GetDataPackage").length };
});
// How many locations the page has sent in all.
const locations_sent = () => evaluate(() => __ap.log.filter((p) => p.cmd === "LocationChecks").reduce((sum, p) => sum + p.locations.length, 0));
const game_of = (g, team = 0, slot = 1) => JSON.stringify({ seed: g.seed, team, slot });

// 1 to 13: the restore.
const restore_checks = async () => {
	// 1. A reload restores the canvas at its size, past the 800x600 the page starts at, in the page and in the record, and
	// so does the login after it.
	const others = [];
	for (const [g, rows] of [[game("SESSION-450x800", 450, 800, 5, 8), [600, 800]], [game("SESSION-600x800", 600, 800, 6, 8), [600, 800]], [game("SESSION-5x5", 800, 600, 0, 0), [0, 5]]]) {
		const trip = await round_trip(g, rows);
		others.push(trip);
		if (trip.seed !== "SESSION-5x5") await forget(trip.id);
	}
	const trip_5 = others[2], goal_800x600 = trip_5.goal;
	const trip = await round_trip(game("SESSION-800x800", 800, 800, 8, 8, ["Additional Palette Color"]), [600, 800]);
	check("an 800x800 session painted in rows 600-799 survives a reload with those rows intact, in the page and in the stored record", trip.size === "800x800" && trip.saved?.area === trip.painted.digest && kept(trip, trip.reloaded), show(trip, trip.reloaded));
	check("...and a login after the reload", kept(trip, trip.connected), show(trip, trip.connected));
	check("...and so do 450x800, 600x800 and 5x5 sessions", others.every((t) => t.size === t.want && kept(t, t.reloaded) && kept(t, t.connected)), others.map((t) => `${show(t, t.reloaded)} then ${show(t, t.connected)}`).join("; "));
	check("the first login stores the session's game: seed, team and slot", JSON.stringify(trip.saved?.game) === JSON.stringify({ seed: "SESSION-800x800", team: 0, slot: 1 }), JSON.stringify(trip.saved?.game));
	const in_local = await local_keys();
	check("...each record in IndexedDB, and none in localStorage", [trip, ...others].every((t) => t.saved?.from === "idb") && trip.connected.record?.from === "idb" && in_local.length === 0, JSON.stringify({ from: [trip, ...others].map((t) => t.saved?.from), in_local }));

	// 2. The restore puts the canvas in the history at its size, so Undo after a stroke brings it back whole.
	const undone = await evaluate(async (area) => {
		const fn = await import("/src/functions.js");
		try { fn.undoable({ name: "Test stroke" }, () => { main_ctx.fillStyle = "#000000"; main_ctx.fillRect(0, 0, main_canvas.width, main_canvas.height); }); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
		const stroked = __t.canvas(main_ctx, ...area);
		fn.undo();
		return { stroked, size: `${main_canvas.width}x${main_canvas.height}`, digest: __t.canvas(main_ctx, ...area) };
	}, trip.painted.area);
	check("Undo after a stroke on the restored canvas brings it back at its size", undone.stroked !== trip.painted.digest && undone.size === "800x800" && undone.digest === trip.painted.digest, JSON.stringify({ ...undone, painted: trip.painted.digest }));

	// The top rows painted too, so a canvas carried into another seed would show, and a palette color of the player's own,
	// as Shift+click sets one.
	await sleep(300); // the undo's autosave
	await paint_rows(0, 105);
	await evaluate(async () => {
		// The color, and the save it asks for, in one task: no save begins between them.
		const { $G } = await import("/src/helpers.js");
		palette[2] = "#123456";
		$G.triggerHandler("save-colors");
	});
	const colors = (await wait_color(trip.id, 2, "#123456"))?.colors;

	// 3. The goal and the palette stay as stored until a login applies them: before, each reload drew the goal stretched
	// into the 800x600 goal canvas a page has before a login, and saved that.
	// 500 ms after each: a save the restore asked for would come 100 ms after it lands.
	await reload_paint(ready, { hide_connection_window: false });
	await sleep(500);
	await reload_paint(ready, { hide_connection_window: false });
	await sleep(500);
	const twice = { record: await record_of(trip.id, trip.painted.area) };
	await connect();
	await wait_goal();
	twice.page = await goal_now();
	twice.palette = await evaluate(() => [...palette]);
	check("two reloads without a login leave the goal at its size and the palette as stored, in the record and, after a login, in the page", colors?.[2] === "#123456" && twice.record?.goal === "800x800" && twice.record.goal_digest === trip.goal.digest && JSON.stringify(twice.record.colors) === JSON.stringify(colors) && twice.page.size === "800x800" && twice.page.digest === trip.goal.digest && JSON.stringify(twice.palette) === JSON.stringify(colors), JSON.stringify({ first: trip.goal, colors, record: twice.record && { goal: twice.record.goal, digest: twice.record.goal_digest, colors: twice.record.colors }, page: twice.page, palette: twice.palette }));

	// 4. With the canvas decode held back, the page asks for a save meanwhile, with a palette of its own, as its theme puts
	// one back after a restore. The save waits for the canvas, and then writes it, with the goal and the palette still as
	// stored.
	await sleep(300);
	const held = await add_script(HOLD_DECODE);
	const before_hold = await record_of(trip.id, trip.painted.area);
	await reload_paint(ready, { hide_connection_window: false, restored: false });
	const key = `sessions:${trip.id}`;
	const during = await evaluate(async () => {
		palette = ["#111111", "#222222"];
		(await import("/src/helpers.js")).$G.triggerHandler("save-colors");
		return { ready: window.paint_hard_session?.ready ?? null, size: `${main_canvas.width}x${main_canvas.height}` };
	});
	await sleep(600);
	during.writes = await evaluate((key) => __t.writes.filter((k) => k === key).length, key);
	during.record = await record_of(trip.id, trip.painted.area);
	await evaluate(() => window.__release_decodes?.());
	await wait_ready();
	// The save asked for during the hold, once it has landed: the record's time moves on.
	const landed_record = await wait_stored(trip.id, trip.painted.area, (record) => record?.saved_at > before_hold?.saved_at);
	const landed = { writes: await evaluate((key) => __t.writes.filter((k) => k === key).length, key), page: await page_area(trip.painted.area), record: landed_record };
	await drop_script(held);
	check("with the canvas decode held back, the page's save waits, and the record isn't overwritten by the blank start canvas", during.ready === false && during.writes === 0 && !!before_hold && during.record?.raw === before_hold.raw, JSON.stringify({ ready: during.ready, size: during.size, writes: during.writes, before: before_hold && { raw: before_hold.raw, size: before_hold.size }, during: during.record && { raw: during.record.raw, size: during.record.size, area: during.record.area } }));
	check("...and once the canvas lands, that save writes it, with the goal and the palette as stored, and the game's 800x800 with them, where the page has 800x600 before a login", landed.writes >= 1 && landed.page.size === "800x800" && landed.page.digest === trip.painted.digest && landed.record?.size === "800x800" && landed.record.area === trip.painted.digest && landed.record.goal === "800x800" && landed.record.goal_digest === trip.goal.digest && JSON.stringify(landed.record.colors) === JSON.stringify(colors) && JSON.stringify(landed.record.final) === "[800,800]", JSON.stringify({ writes: landed.writes, page: landed.page, record: landed.record && { size: landed.record.size, area: landed.record.area, goal: landed.record.goal, goal_digest: landed.record.goal_digest, colors: landed.record.colors, final: landed.record.final }, painted: trip.painted.digest, goal: trip.goal.digest, colors }));

	// 5. A login into another seed: the 800x800 session reloads, restored, and logs into a seed whose goal is 800x600 and
	// whose canvas is 205x105, with no palette color.
	const before_other = await record_of(trip.id, trip.painted.area);
	await serve(config_for(game("SESSION-OTHER", 800, 600, 2, 1)));
	await reload_paint(ready, { hide_connection_window: false });
	const restored_a = await page_area(trip.painted.area);
	await connect();
	await wait_goal();
	await sleep(400);
	const other = await evaluate(() => ({ id: window.paint_hard_session?.id ?? location.hash, size: `${main_canvas.width}x${main_canvas.height}`, undos: undos.length, palette: [...palette] }));
	other.white = await white_in([0, 0, 205, 105]);
	other.goal = await goal_now();
	other.old = await record_of(trip.id, trip.painted.area);
	other.record = await wait_stored(other.id, null, (record) => record?.game?.seed === "SESSION-OTHER");
	check("a login into another seed goes on in a new session with a blank canvas, and leaves the old session's record as it was", restored_a.digest === trip.painted.digest && other.id !== trip.id && other.size === "205x105" && other.white === 205 * 105 && other.undos === 0 && !!before_other && other.old?.raw === before_other.raw && other.record?.game?.seed === "SESSION-OTHER", JSON.stringify({ restored: restored_a.digest === trip.painted.digest, new_id: other.id !== trip.id, size: other.size, white: other.white, undos: other.undos, old_kept: other.old?.raw === before_other?.raw, game: other.record?.game }));
	check("...with that seed's own goal", other.goal.size === "800x600" && other.goal.digest === goal_800x600.digest, JSON.stringify({ goal: other.goal, want: goal_800x600 }));
	await forget(trip.id);

	// The same in one page: the connection drops, and the player logs into a third seed, 105x105 on a 600x800 goal, with
	// the second seed's canvas painted and its palette, a color of the player's own among it, still on the page.
	await paint_rows(0, 105);
	await evaluate(async () => {
		// The color, and the save it asks for, in one task: no save begins between them.
		const { $G } = await import("/src/helpers.js");
		palette[1] = "#abcdef";
		$G.triggerHandler("save-colors");
	});
	const before_third = await wait_color(other.id, 1, "#abcdef");
	await evaluate((config) => { __ap.use(config); __ap.drop(); }, config_for(game("SESSION-THIRD", 600, 800, 1, 1)));
	for (let i = 0; i < 30 && !(await window_shown()); i++) await sleep(100);
	await connect();
	await wait_goal();
	await sleep(400);
	const third = await evaluate(() => ({ id: window.paint_hard_session?.id ?? location.hash, size: `${main_canvas.width}x${main_canvas.height}`, palette: [...palette] }));
	third.white = await white_in([0, 0, 105, 105]);
	third.old = await record_of(other.id);
	check("...and in the same page after a dropped connection, with the palette a page starts with", before_third?.colors?.[1] === "#abcdef" && third.id !== other.id && third.size === "105x105" && third.white === 105 * 105 && third.old?.raw === before_third.raw && third.palette.length === 2 && !third.palette.includes("#abcdef"), JSON.stringify({ stored: before_third?.colors, new_id: third.id !== other.id, size: third.size, white: third.white, old_kept: third.old?.raw === before_third?.raw, palette: third.palette }));
	await forget(other.id);

	// 6. A #load: picture in a game is drawn at its size, and the game's items then give the canvas its size, as before.
	const picture = `${ORIGIN}/images/archipelago/800x800.png`;
	const picture_corner = await evaluate(async (url) => __t.rect(await __t.png(url), 0, 0, 105, 105), picture);
	await evaluate((url) => { location.hash = "load:" + encodeURIComponent(url); }, picture);
	let loaded = null;
	for (let i = 0; i < 30; i++) {
		await sleep(100);
		loaded = await page_area([0, 0, 105, 105]);
		if (loaded.digest === picture_corner) break;
	}
	check("a #load: picture in a game leaves the canvas at the size the game's items give it", loaded.digest === picture_corner && loaded.size === "105x105", JSON.stringify({ loaded, picture_corner }));
	await forget(third.id);

	// 7. A Connect clicked while the canvas decodes waits for it to land: the canvas takes its stored size first, and the
	// login's items, one width item more than last time, grow it from there.
	const GROW = game("SESSION-GROW", 800, 600, 6, 6);
	await serve(config_for(GROW));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const grow_id = await id_now(), grow_size = await size_now();
	const grow_painted = await paint_rows(0, 600);
	await wait_record(grow_id, grow_painted.area, grow_painted.digest);
	await serve(config_for({ ...GROW, widths: 7 }));
	const held_again = await add_script(HOLD_DECODE);
	await reload_paint(ready, { hide_connection_window: false, restored: false });
	const clicked = await restore_now();
	await click_connect();
	await sleep(800);
	const waiting = { shown: await window_shown(), size: await size_now() };
	await evaluate(() => window.__release_decodes?.());
	for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
	await sleep(500);
	const grown = { size: await size_now(), kept: (await page_area(grow_painted.area)).digest, white: await white_in([605, 0, 100, 600]) };
	await drop_script(held_again);
	check("a Connect clicked while the canvas decodes waits for it to land, and the login's items then grow the canvas from its stored size", grow_size === "605x600" && clicked.ready === false && waiting.shown && grown.size === "705x600" && grown.kept === grow_painted.digest && grown.white === 100 * 600, JSON.stringify({ grow_size, clicked, waiting, grown, painted: grow_painted.digest }));

	// 8. A restore that doesn't land within its time, 1.5 s here and 30 s in play: a message, the record as stored, and a
	// new session for the tab. The canvas, landing late, draws nothing, and Connect logs in.
	const grow_area = [0, 0, 705, 600];
	const before_timeout = await wait_stored(grow_id, grow_area, (record) => record?.size === "705x600"); // the login's autosave
	const never = await add_script(TIMEOUT_DECODE);
	await reload_paint(ready, { hide_connection_window: false, restored: false });
	for (let i = 0; i < 60 && (await restore_now()).outcome !== "timed out"; i++) await sleep(100);
	await wait_ready(); // the new session looks for a record of its own first, which takes a moment now that it asks IndexedDB
	const gave_up = { ...(await restore_now()), message: await message_shown("stopped waiting"), size: await size_now(), record: await record_of(grow_id, grow_area) };
	await evaluate(() => window.__release_decodes?.());
	await sleep(600);
	const late = { size: await size_now(), white: await white_in([0, 0, 800, 600]) };
	await drop_script(never);
	check("a restore that hasn't landed in 1.5 s stops with a message, leaves the record as stored, and goes on in a new session", gave_up.ready === true && gave_up.outcome === "timed out" && gave_up.message && gave_up.id !== grow_id && before_timeout?.size === "705x600" && gave_up.record?.raw === before_timeout.raw, JSON.stringify({ ...gave_up, record: gave_up.record?.raw, before: before_timeout && { raw: before_timeout.raw, size: before_timeout.size } }));
	check("...and the canvas, landing after that, draws nothing", late.size === "800x600" && late.white === 800 * 600, JSON.stringify(late));
	await connect();
	const after_timeout = { record: await wait_stored(gave_up.id, null, (record) => !!record?.game) }; // the login's autosave
	Object.assign(after_timeout, { shown: await window_shown(), size: await size_now(), old: await record_of(grow_id, grow_area) });
	check("...and Connect logs in, in the new session", !after_timeout.shown && after_timeout.size === "705x600" && !!before_timeout && after_timeout.old?.raw === before_timeout.raw && after_timeout.record?.game?.seed === "SESSION-GROW", JSON.stringify({ shown: after_timeout.shown, size: after_timeout.size, old_kept: after_timeout.old?.raw === before_timeout?.raw, game: after_timeout.record?.game }));
	await forget(grow_id);
	await forget(gave_up.id);

	// 9. A record whose canvas won't decode: a message, the record as stored, a new session, and a login that leaves it.
	await serve(config_for(game("SESSION-BROKEN", 800, 600, 2, 1)));
	await open_paint(ready, { hide_connection_window: false });
	const broken_id = await id_now();
	await evaluate((id) => localStorage.setItem("image#" + id, JSON.stringify(JSON.stringify({ canvas: "data:text/plain,not-a-picture", connection_info: { host: "fake.test", port: "38281", slot: "Painter", pass: "" }, colors: ["rgb(0,0,0)", "rgb(255,255,255)"] }))), broken_id);
	const planted = await record_of(broken_id);
	await reload_paint(ready, { hide_connection_window: false });
	const broken = { ...(await restore_now()), message: await message_shown("couldn't restore") };
	await connect();
	await sleep(400);
	broken.record = await record_of(broken_id);
	check("a record whose canvas won't decode gives a message, stays as stored, and the tab goes on in a new session", broken.ready === true && broken.outcome === "failed" && broken.message && broken.id !== broken_id && !!planted && broken.record?.raw === planted.raw, JSON.stringify({ ...broken, record: broken.record?.raw, planted: planted?.raw }));
	await forget(broken_id);
	await forget(broken.id);

	// 10. A record whose goal won't load: the canvas comes back, a message says so, and the login draws the seed's own goal.
	await serve(config_for(game("SESSION-5x5", 800, 600, 0, 0)));
	await open_paint(ready, { hide_connection_window: false });
	const goalless_id = await id_now();
	const goalless_canvas = await evaluate((id) => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 5;
		const ctx = canvas.getContext("2d"), image = ctx.createImageData(5, 5);
		for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) image.data.set([...__t.pattern(x, y), 255], (y * 5 + x) * 4);
		ctx.putImageData(image, 0, 0);
		localStorage.setItem("image#" + id, JSON.stringify(JSON.stringify({ canvas: canvas.toDataURL("image/png"), goal: "data:image/png;base64,iVBORw0KGgo=", connection_info: { host: "fake.test", port: "38281", slot: "Painter", pass: "" }, colors: ["rgb(0,0,0)", "rgb(255,255,255)"] })));
		return __t.digest(image.data);
	}, goalless_id);
	await reload_paint(ready, { hide_connection_window: false });
	const goalless = { ...(await restore_now()), message: await message_shown("goal image didn't come back"), page: await page_area([0, 0, 5, 5]) };
	await connect();
	await wait_goal();
	goalless.goal = await goal_now();
	check("a record whose goal won't load brings its canvas back, says so, and the login draws the seed's own goal", goalless.outcome === "restored" && goalless.message && goalless.page.size === "5x5" && goalless.page.digest === goalless_canvas && goalless.goal.digest === goal_800x600.digest, JSON.stringify({ ...goalless, want: { canvas: goalless_canvas, goal: goal_800x600 } }));
	await forget(goalless_id);
	await forget(trip_5.id);

	// 11. A record in the older format, the canvas alone with the palette and connection under keys of their own, restores
	// at its size too, and a login applies its palette.
	await serve(config_for(game("SESSION-LEGACY", 800, 800, 8, 8)));
	await open_paint(ready, { hide_connection_window: false });
	const legacy_id = await id_now();
	const legacy_rows = await evaluate((id) => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 800;
		const ctx = canvas.getContext("2d"), image = ctx.createImageData(800, 200);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, 800, 800);
		for (let y = 600; y < 800; y++) for (let x = 0; x < 800; x++) image.data.set([...__t.pattern(x, y), 255], ((y - 600) * 800 + x) * 4);
		ctx.putImageData(image, 0, 600);
		localStorage.setItem("image#" + id, JSON.stringify(canvas.toDataURL("image/png")));
		localStorage.setItem("image#" + id + "_colors", JSON.stringify(JSON.stringify(["rgb(0,0,0)", "rgb(255,255,255)", "#654321"])));
		localStorage.setItem("image#" + id + "_connection_info", JSON.stringify(JSON.stringify({ host: "legacy.test", port: "1234", slot: "Old" })));
		return __t.digest(image.data);
	}, legacy_id);
	await reload_paint(ready, { hide_connection_window: false });
	const legacy = { ...(await restore_now()), page: await page_area([0, 600, 800, 200]), host: await evaluate(() => $("[name=aphost]").val()) };
	for (let i = 0; i < 20 && (await record_of(legacy_id))?.from !== "idb"; i++) await sleep(100); // the move commits
	legacy.moved = await record_of(legacy_id, [0, 600, 800, 200]);
	legacy.in_local = await local_keys();
	await connect();
	legacy.palette = await evaluate(() => [...palette]);
	check("an older record, the canvas alone with its palette and connection under keys of their own, restores at its size too", legacy.outcome === "restored" && legacy.page.size === "800x800" && legacy.page.digest === legacy_rows && legacy.host === "legacy.test" && legacy.palette.includes("#654321"), JSON.stringify({ ...legacy, moved: null, in_local: null, want: legacy_rows }));
	check("...and moves to IndexedDB, its keys gone from localStorage", legacy.moved?.from === "idb" && legacy.moved.area === legacy_rows && legacy.moved.connection?.host === "legacy.test" && !legacy.in_local.some((key) => key.startsWith(`image#${legacy_id}`)), JSON.stringify({ moved: legacy.moved && { from: legacy.moved.from, area: legacy.moved.area, connection: legacy.moved.connection }, in_local: legacy.in_local }));
	await forget(legacy_id);

	// 12. A session that ends while its canvas still decodes, as when the address changes to another session, makes no
	// last save, whether something asked for a save meanwhile or not: the page holds the blank canvas it starts with, and
	// a save of that would go over the record. The record is read once the restore has read it, when the page before the
	// reload can write no more. The session ends twice: first with a save asked for, then, the page back in it and its
	// canvas at the decode again, with none. Then both canvases land, after their sessions ended: neither session saves
	// once its restore is over, and neither canvas draws on the page, which has gone on in a session of its own.
	await serve(config_for(game("SESSION-ENDS", 800, 600, 2, 1)));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const ends_id = await id_now(), next_id = `${ends_id}x`, last_id = `${ends_id}y`;
	const ends_painted = await paint_rows(0, 105);
	await wait_record(ends_id, ends_painted.area, ends_painted.digest);
	const held_end = await add_script(HOLD_DECODE);
	await reload_paint(ready, { hide_connection_window: false, restored: false });
	const ending = { at_decode: await wait_held(), ready: (await restore_now()).ready, record: await record_of(ends_id, ends_painted.area) };
	// The address changes to another session. What the session it ended wrote, and its record, once its lock has gone.
	// That session's restore is kept in the page first, to wait for once its canvas lands.
	const leave_for = async (id) => {
		await evaluate(() => { (window.__ended_restores ??= []).push(window.paint_hard_session.restored); });
		await evaluate((id) => { location.hash = "local:" + id; }, id);
		for (let i = 0; i < 100 && !(await evaluate((id) => window.paint_hard_session.id === id && window.paint_hard_session.ready === true, id)); i++) await sleep(100);
		return { lock_let_go: await lock_let_go(ends_id), id: await id_now(), writes: await writes_of(ends_id), record: await record_of(ends_id, ends_painted.area), in_local: await local_keys() };
	};
	// A save is asked for meanwhile, as in section 4, so the session ends with a change to save.
	await evaluate(async () => (await import("/src/helpers.js")).$G.triggerHandler("save-colors"));
	const ended = await leave_for(next_id);
	// The page comes back to the session, whose canvas waits at the decode a second time, and leaves with no save asked.
	await evaluate((id) => { location.hash = "local:" + id; }, ends_id);
	const again = { at_decode: await wait_held(2), ...(await restore_now()) };
	const ended_again = await leave_for(last_id);
	// Both canvases land, after their sessions ended, and both restores end with them, waited for up to 5 s. A save made
	// then would go out within 400 ms, and a canvas drawn would show in the page's own rows, white until then.
	await evaluate(() => window.__release_decodes?.());
	const ends_landed = { restores: await evaluate(() => Promise.race([Promise.all(window.__ended_restores), new Promise((resolve) => setTimeout(() => resolve(null), 5000))])) };
	await sleep(400);
	Object.assign(ends_landed, { writes: await writes_of(ends_id), record: await record_of(ends_id, ends_painted.area), white: await white_in(ends_painted.area) });
	await drop_script(held_end);
	const as_stored = (end, id) => end.lock_let_go && end.id === id && end.writes === 0 && end.record?.raw === ending.record.raw && !end.in_local.some((key) => key.startsWith(`image#${ends_id}`));
	const end_shown = (end, id) => ({ lock_let_go: end.lock_let_go, id_now: end.id, want: id, writes: end.writes, after: end.record && { raw: end.record.raw, size: end.record.size, rows_kept: end.record.area === ends_painted.digest }, in_local: end.in_local });
	const painted_pixels = ends_painted.area[2] * ends_painted.area[3];
	check("a session that ends while its canvas still decodes writes nothing, whether a save was asked for meanwhile or not, and leaves its record as stored, also once that canvas lands, which then draws nothing on the page", ending.at_decode && ending.ready === false && ending.record?.area === ends_painted.digest && as_stored(ended, next_id) && again.at_decode && again.id === ends_id && again.ready === false && as_stored(ended_again, last_id) && Array.isArray(ends_landed.restores) && ends_landed.writes === 0 && ends_landed.record?.raw === ending.record.raw && ends_landed.white === painted_pixels, JSON.stringify({ at_decode: ending.at_decode, ready: ending.ready, before: ending.record && { raw: ending.record.raw, size: ending.record.size, rows_kept: ending.record.area === ends_painted.digest }, save_asked: end_shown(ended, next_id), back_in_it: { at_decode: again.at_decode, ready: again.ready, id: again.id }, none_asked: end_shown(ended_again, last_id), landed: { restores: ends_landed.restores, writes: ends_landed.writes, raw: ends_landed.record?.raw, white: ends_landed.white, of: painted_pixels } }));
	await forget(ends_id);
	await forget(next_id);
	await forget(last_id);

	// 13. A reload while the canvas still decodes, after something asked for a save: the page leaves no copy of the blank
	// canvas it starts with in sessionStorage, where the next load would take it for newer than the record, show it and
	// save it over the record.
	await serve(config_for(game("SESSION-LEAVES", 800, 600, 2, 1)));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const leaves_id = await id_now();
	const leaves_painted = await paint_rows(0, 105);
	await wait_record(leaves_id, leaves_painted.area, leaves_painted.digest);
	const held_leave = await add_script(HOLD_DECODE);
	await reload_paint(ready, { hide_connection_window: false, restored: false });
	const leaving = { at_decode: await wait_held(), copy_before: await copy_left_at(leaves_id) };
	leaving.ready = await evaluate(async () => {
		(await import("/src/helpers.js")).$G.triggerHandler("save-colors");
		return window.paint_hard_session.ready;
	});
	await reload_paint(ready, { hide_connection_window: false, restored: false }); // again, the canvas still not back
	const left = { at_decode: await wait_held(), copy: await copy_left_at(leaves_id) }; // the next page has read what is stored
	await evaluate(() => window.__release_decodes?.());
	await wait_ready();
	await sleep(600); // a copy taken would be saved over the record 100 ms after the restore
	Object.assign(left, { page: await page_area(leaves_painted.area), record: await record_of(leaves_id, leaves_painted.area) });
	await drop_script(held_leave);
	check("a reload while the canvas still decodes leaves no copy of the page's blank canvas, and the next load brings the stored canvas back, in the page and in the record", leaving.at_decode && leaving.ready === false && left.at_decode && left.copy === leaving.copy_before && left.page.digest === leaves_painted.digest && left.record?.area === leaves_painted.digest, JSON.stringify({ at_decode: [leaving.at_decode, left.at_decode], ready: leaving.ready, copy_made_at: { before: leaving.copy_before, after: left.copy }, painted: leaves_painted.digest, page: left.page, record: left.record && { size: left.record.size, area: left.record.area } }));
	await forget(leaves_id);
};

// 14. With a game loaded, the address of another game's stored session doesn't open it (decision 7, ruling R1). Opened,
// its canvas would take this game's size, be saved so over its record, and be scored in this game: the one here holds
// this game's goal itself. One message says so, the address goes back, and the tab's own session goes on with its
// canvas, its undo history and its saves. A stored session of no game yet stays closed too, and one of the loaded game
// opens. The page keeps its game loaded when the connection drops, so the address is turned away then too, and a login
// into the other session's own game leaves that record as stored.
const address_checks = async () => {
	const ONE = game("SESSION-ADDRESS-1", 800, 600, 3, 2), TWO = game("SESSION-ADDRESS-2", 800, 600, 2, 1);
	await serve(config_for(TWO));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const own = await id_now();
	const own_painted = await paint_rows(0, 50, 1);
	await wait_record(own, own_painted.area, own_painted.digest);
	// Sessions other pages stored: one of game one that holds this game's goal, one of no game yet, and one of this game.
	const other = `${own}-other`, none = `${own}-none`, same = `${own}-same`;
	const planted = await evaluate(async (ids, games) => ({
		other: await __s.plant(ids[0], __s.goal_part(300, 200), games[0]),
		none: await __s.plant(ids[1], __s.canvas(300, 200, 5), null),
		same: await __s.plant(ids[2], __s.canvas(205, 105, 9), games[1]),
	}), [other, none, same], [{ seed: ONE.seed, team: 0, slot: 1 }, { seed: TWO.seed, team: 0, slot: 1 }]);
	const stored = { other: await record_of(other), none: await record_of(none) };
	const before = { undos: await evaluate(() => undos.length), sent: await locations_sent() };
	await go_to(other);
	const refused = { id: await id_now(), address: await evaluate(() => location.hash), page: await page_area(own_painted.area), undos: await evaluate(() => undos.length), said: await shown(REFUSED) };
	// A stroke of 20 rows of the canvas's 205 columns. On this goal its pattern sends 23 locations, in Chrome and in
	// Firefox alike, and the check allows 104: the 18 below 0.01% and 86 more.
	const stroke = await paint_rows(60, 80, 3);
	const own_record = await wait_record(own, stroke.area, stroke.digest);
	Object.assign(refused, { sent: (await locations_sent()) - before.sent, other: await record_of(other) });
	check("with a game loaded, the address of another game's stored session doesn't open it: one message, the address back on the tab's own session with its canvas and undo history, the next stroke saved there and scored on that canvas alone, and the other session's record as stored", refused.id === own && refused.address === `#local:${own}` && refused.page.digest === own_painted.digest && before.undos > 0 && refused.undos === before.undos && refused.said === 1 && own_record?.area === stroke.digest && refused.sent <= 18 + 86 && !!stored.other && refused.other?.raw === stored.other.raw, JSON.stringify({ id_kept: refused.id === own, address: refused.address, page_kept: refused.page.digest === own_painted.digest, undos: [before.undos, refused.undos], said: refused.said, stroke_saved: own_record?.area === stroke.digest, locations_the_stroke_sent: refused.sent, other_kept: refused.other?.raw === stored.other?.raw }));
	const before_none = { id: await id_now(), said: await shown(REFUSED) };
	await go_to(none);
	const none_refused = { id: await id_now(), address: await evaluate(() => location.hash), said: await shown(REFUSED), record: await record_of(none) };
	await go_to(same);
	const opened = { ...(await restore_now()), size: await size_now(), page: await evaluate(() => __t.digest(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data)) };
	check("...and neither does the address of a stored session of no game yet, while one of the loaded game opens there with its canvas", none_refused.id === before_none.id && none_refused.address === `#local:${before_none.id}` && none_refused.said === before_none.said + 1 && !!stored.none && none_refused.record?.raw === stored.none.raw && opened.id === same && opened.outcome === "restored" && opened.size === "205x105" && opened.page === planted.same, JSON.stringify({ none: { id_kept: none_refused.id === before_none.id, address: none_refused.address, said: [before_none.said, none_refused.said], record_kept: none_refused.record?.raw === stored.none?.raw }, same: { ...opened, planted: planted.same } }));
	// The connection drops, and the next login is game one's, the other session's own.
	await drop_to(config_for(ONE));
	await go_to(other);
	const dropped = { id: await id_now(), said: await shown(REFUSED) };
	await connect();
	await wait_goal();
	await sleep(400);
	const logged = { id: await id_now(), other: await record_of(other) };
	check("...and after the connection drops, the page keeps that game loaded, so the other game's session still isn't opened at its address, and a login into that session's own game leaves its record as stored", dropped.id !== other && logged.id !== same && logged.id !== other && !!stored.other && logged.other?.raw === stored.other.raw, JSON.stringify({ opened: dropped.id === other, said: dropped.said, logged_in_a_new_session: logged.id !== same && logged.id !== other, other_kept: logged.other?.raw === stored.other?.raw }));
	for (const id of new Set([own, other, none, same, logged.id])) await forget(id);
};

// 15. A session that starts at an address with nothing stored belongs to the game of the canvas the page shows, the game
// of the session before it, whether a game is logged in or the page restored that session before any login (ruling R1).
// A login into another game then leaves it, with that canvas in its record, and goes on in a new session with a blank
// canvas.
const typed_checks = async () => {
	const ONE = game("SESSION-TYPED-1", 800, 600, 6, 6), TWO = game("SESSION-TYPED-2", 800, 600, 2, 1);
	const whole = [0, 0, 605, 600];
	await serve(config_for(ONE));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const one = await id_now();
	const painted = await paint_rows(0, 600, 1);
	await wait_record(one, painted.area, painted.digest);
	// Logged in, the address goes to an id with nothing stored, as a typed address or a bookmark takes it, and a stroke.
	const typed = `${one}-typed`;
	await go_to(typed);
	await paint_rows(590, 600, 4);
	const typed_page = await page_area(whole);
	const typed_record = await wait_record(typed, whole, typed_page.digest);
	await drop_to(config_for(TWO));
	await connect();
	await wait_goal();
	await sleep(400);
	const logged = { id: await id_now(), size: await size_now(), white: await white_in([0, 0, 205, 105]), record: await record_of(typed, whole) };
	// With no login: a reload, game one's session opened at its address, then an id with nothing stored, and a change.
	await reload_paint(ready, { hide_connection_window: false });
	await go_to(one);
	const cold = `${one}-cold`;
	await go_to(cold);
	await paint_quiet(590, 600, 6);
	const cold_page = await page_area(whole);
	const cold_record = await wait_record(cold, whole, cold_page.digest);
	await evaluate((config) => __ap.use(config), config_for(TWO));
	await connect();
	await wait_goal();
	await sleep(400);
	const restored = { id: await id_now(), size: await size_now(), white: await white_in([0, 0, 205, 105]), record: await record_of(cold, whole) };
	const left = (record, page, then, id) => JSON.stringify(record?.game) === game_of(ONE) && record.size === "605x600" && record.area === page.digest && then.id !== id && then.size === "205x105" && then.white === 205 * 105 && then.record?.raw === record.raw;
	const shown_as = (record, page, then) => ({ game: record?.game, stored: record?.area === page.digest, then: { id_changed: then.id !== record?.id, size: then.size, white: then.white, record_kept: then.record?.raw === record?.raw } });
	check("a session that starts at an address with nothing stored belongs to the game of the canvas the page shows, logged in or restored before a login, so a login into another game leaves it with that canvas in its record and goes on with a blank canvas", left(typed_record, typed_page, logged, typed) && left(cold_record, cold_page, restored, cold), JSON.stringify({ logged_in: shown_as(typed_record, typed_page, logged), restored: shown_as(cold_record, cold_page, restored) }));
	for (const id of new Set([one, typed, cold, logged.id, restored.id])) await forget(id);
};

// 16. A login into another game saves the session it leaves once, where a change still waits for its save, with that
// game's own connection and goal size, its goal and its palette: by then the form and the page hold the next game's
// (ruling R2). A message says where the canvas of the game before stays, naming its slot, and a second such login puts
// its message in place of the first. File > Manage Storage names the slot and the address of each session's game. A
// login into another game that lands while a session's restore is under way saves nothing over that session's record,
// though a save was asked for meanwhile: the canvas on the page isn't that session's yet.
const switch_checks = async () => {
	const ONE = game("SESSION-SWITCH-1", 800, 600, 4, 3), TWO = game("SESSION-SWITCH-2", 800, 800, 3, 5), THREE = game("SESSION-SWITCH-3", 800, 600, 2, 1), FOUR = game("SESSION-SWITCH-4", 800, 600, 2, 1);
	await serve(config_for(ONE));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const one = await id_now();
	// Saves wait 4 s apart from here, where play waits 5 s, so the last change's save still waits as the tab leaves the game.
	await evaluate(() => { window.paint_hard_save_every_ms = 4000; });
	const first = await paint_rows(0, 100, 1);
	await wait_record(one, first.area, first.digest);
	const before = await record_of(one);
	const last = await paint_rows(100, 200, 2);
	await sleep(300);
	const waiting = (await record_of(one, last.area))?.area !== last.digest;
	await drop_to(config_for(TWO));
	await log_in("other.test", "40000", "PainterTwo");
	await wait_goal();
	await evaluate(() => { window.paint_hard_save_every_ms = 200; });
	const two = await id_now();
	const left = await wait_record(one, last.area, last.digest);
	const after_one = await shown_texts(LEFT);
	check("a login into another game saves the change that the session it leaves still waited to save", waiting && two !== one && left?.area === last.digest, JSON.stringify({ waiting, new_session: two !== one, saved: left?.area === last.digest }));
	const two_record = await wait_stored(two, null, (record) => !!record);
	check("...with that game's own connection, goal size, goal and palette, where the form and the page hold the next game's by then", JSON.stringify(left?.connection) === JSON.stringify({ host: "fake.test", port: "38281", slot: "Painter" }) && JSON.stringify(left.final) === "[800,600]" && JSON.stringify(left.game) === game_of(ONE) && !!left.goal_sha && left.goal_sha === before?.goal_sha && JSON.stringify(left.colors) === JSON.stringify(before?.colors) && JSON.stringify(two_record?.connection) === JSON.stringify({ host: "other.test", port: "40000", slot: "PainterTwo" }) && JSON.stringify(two_record.final) === "[800,800]", JSON.stringify({ left: left && { connection: left.connection, final: left.final, game: left.game, goal_kept: left.goal_sha === before?.goal_sha, colors: left.colors }, next: two_record && { connection: two_record.connection, final: two_record.final } }));
	await drop_to(config_for(THREE));
	await log_in("third.test", "40001", "PainterThree");
	await wait_goal();
	const three = await id_now();
	const after_two = await shown_texts(LEFT);
	check("...and a message says where the canvas of the game before stays, naming its slot, one at a time: a second such login puts its message in place of the first", after_one.length === 1 && /Painter's/.test(after_one[0]) && /File > Manage Storage/.test(after_one[0]) && after_two.length === 1 && /PainterTwo's/.test(after_two[0]), JSON.stringify({ after_one, after_two }));
	// File > Manage Storage, once the new session's first save has landed.
	await wait_stored(three, null, (record) => !!record);
	await evaluate(async () => (await import("/src/manage-storage.js")).manage_storage());
	let rows = [];
	for (let i = 0; i < 50 && ![one, two, three].every((id) => rows.some((row) => row.id === id)); i++) {
		await sleep(100);
		rows = await evaluate(() => [...document.querySelectorAll(".storage-manager tr")].map((tr) => ({ id: tr.dataset.session, details: tr.querySelector(".session-details")?.textContent ?? "" })));
	}
	await evaluate(() => $(".storage-manager button").filter((i, b) => b.textContent === "Close").trigger("click"));
	// Each row ends with the slot and the address its record holds, and this tab's row with "(this tab)" after them.
	const named = [];
	for (const id of [one, two, three]) {
		const { host, port, slot } = (await record_of(id))?.connection ?? {};
		const details = rows.find((row) => row.id === id)?.details ?? null;
		named.push({ details, ok: !!slot && !!details?.endsWith(`, ${slot} at ${host}:${port}${id === three ? " (this tab)" : ""}`) });
	}
	check("...and File > Manage Storage names the slot and the address of each session's game", named.every((row) => row.ok), JSON.stringify(named));
	// Game three's session, painted and stored, then a session of the tab's own with its page made blank.
	const painted = await paint_rows(0, 100, 5);
	await wait_record(three, painted.area, painted.digest);
	const blank = `${three}-blank`;
	await go_to(blank);
	await evaluate(async () => (await import("/src/functions.js")).file_new());
	await sleep(400);
	const three_before = await record_of(three, painted.area);
	// The connection drops, and the player logs into game four, whose answer to Connect the stand-in holds 1.5 s. Meanwhile
	// the address goes back to game three's session, whose canvas waits at its decode, and a save is asked for.
	await evaluate(hold_login_and_decodes, 1500);
	await drop_to(config_for(FOUR));
	await click_connect();
	await sleep(300);
	await evaluate((id) => { location.hash = "local:" + id; }, three);
	const reached = await wait_held();
	await evaluate(async () => (await import("/src/helpers.js")).$G.triggerHandler("save-colors"));
	const during = { ...(await restore_now()), held: await evaluate(() => window.__decodes_held()) };
	for (let i = 0; i < 40 && (await window_shown()); i++) await sleep(100);
	await sleep(300);
	await evaluate(() => window.__release_decodes());
	await sleep(800);
	const three_after = await record_of(three, painted.area);
	check("...and a login into another game that lands while a session's restore is under way saves nothing over that session's record, though a save was asked for meanwhile", reached && during.id === three && during.ready === false && !!three_before && three_before.area === painted.digest && three_after?.raw === three_before.raw, JSON.stringify({ reached, during, before: three_before && { raw: three_before.raw, rows_kept: three_before.area === painted.digest }, after: three_after && { raw: three_after.raw, rows_kept: three_after.area === painted.digest } }));
	for (const id of new Set([one, two, three, blank, await id_now()])) await forget(id);
};

// 17. A restore that fails takes its record's palette and goal off the page again with its canvas, which isn't coming, so
// a login into another game then starts from the palette a page starts with and draws that game's own goal. A restore
// that times out or fails saves nothing over its record as its session ends, though a change made while its canvas
// decoded asked for a save.
const failed_checks = async () => {
	const ONE = game("SESSION-FAILED-1", 800, 800, 8, 8, ["Additional Palette Color", "Additional Palette Color", "Additional Palette Color"]), TWO = game("SESSION-FAILED-2", 800, 600, 2, 1);
	// What a page that logs into game two alone shows: its goal, and the palette a page starts with.
	await serve(config_for(TWO));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const alone = { id: await id_now(), goal: await goal_now(), palette: await evaluate(() => [...palette]) };
	// Game one's session with a color of the player's own and the game's 800x800 goal, stored, and then made unreadable.
	await serve(config_for(ONE));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const one = await id_now();
	await paint_rows(0, 100, 1);
	await evaluate(async () => {
		// The color, and the save it asks for, in one task: no save begins between them.
		const { $G } = await import("/src/helpers.js");
		palette[3] = "#123456";
		$G.triggerHandler("save-colors");
	});
	const stored = await wait_color(one, 3, "#123456");
	await evaluate((id) => __s.unreadable(id), one);
	await serve(config_for(TWO));
	await reload_paint(ready, { hide_connection_window: false });
	const failed = { ...(await restore_now()), said: await shown("couldn't restore this tab's canvas") };
	await connect();
	await wait_goal();
	const then = { id: await id_now(), palette: await evaluate(() => [...palette]), goal: await goal_now() };
	then.record = await wait_stored(then.id, null, (record) => !!record?.goal_found);
	check("a restore that fails takes its record's palette and goal off the page again, so a login into another game starts from the palette a page starts with and draws that game's own goal", stored?.goal === "800x800" && stored.colors?.length === 5 && failed.outcome === "failed" && failed.said === 1 && failed.id !== one && JSON.stringify(then.palette) === JSON.stringify(alone.palette) && then.goal.digest === alone.goal.digest && JSON.stringify(then.record?.colors) === JSON.stringify(alone.palette) && then.record.goal_digest === alone.goal.digest, JSON.stringify({ stored: stored && { goal: stored.goal, colors: stored.colors }, failed, palette: then.palette, goal: then.goal, record: then.record && { colors: then.record.colors, goal: then.record.goal, goal_digest: then.record.goal_digest }, alone: { goal: alone.goal, palette: alone.palette } }));
	for (const id of new Set([alone.id, one, then.id])) await forget(id);

	// A change made while the canvas still decodes asks for a save. A restore that then times out, or fails, saves nothing
	// over its record as its session ends: the page shows the canvas it had before. What the session wrote, and its
	// record, are read once its lock has gone, which it lets go of once its last save has landed.
	const change_while_decoding = async (fails) => {
		await open_paint(ready, { hide_connection_window: false });
		const id = await id_now();
		const painted = await paint_quiet(0, 100, 7);
		await wait_record(id, painted.area, painted.digest);
		if (fails) await evaluate((id) => __s.unreadable(id), id);
		const stored = await record_of(id, painted.area);
		// The restore's time limit at 3 s, which leaves time for the stroke below before it runs out.
		const held = await use(fails ? HOLD_DECODE : `${HOLD_DECODE}\nwindow.paint_hard_restore_timeout_ms = 3000;`);
		await reload_paint(ready, { hide_connection_window: false, restored: false });
		const at_decode = await wait_held();
		await paint_quiet(100, 150, 8);
		const during = await restore_now();
		if (fails) await evaluate(() => window.__release_decodes?.());
		const outcome = fails ? "failed" : "timed out";
		for (let i = 0; i < 60 && (await restore_now()).outcome !== outcome; i++) await sleep(100);
		await wait_ready();
		const after = { ...(await restore_now()), lock_let_go: await lock_let_go(id), writes: await writes_of(id), record: await record_of(id, painted.area) };
		await evaluate(() => window.__release_decodes?.());
		await unuse(held);
		for (const gone of new Set([id, after.id])) await forget(gone);
		return { at_decode, ready: during.ready, outcome: after.outcome, new_id: after.id !== id, lock_let_go: after.lock_let_go, writes: after.writes, kept: !!stored && after.record?.raw === stored.raw };
	};
	const timing_out = await change_while_decoding(false), failing = await change_while_decoding(true);
	const saved_nothing = (change, outcome) => change.at_decode && change.ready === false && change.outcome === outcome && change.new_id && change.lock_let_go && change.writes === 0 && change.kept;
	check("a restore that times out or fails saves nothing over its record as its session ends, though a change made while its canvas decoded asked for a save", saved_nothing(timing_out, "timed out") && saved_nothing(failing, "failed"), JSON.stringify({ timed_out: timing_out, failed: failing }));
};

// 18. The version before task 7.4 kept the room password in each session record in localStorage, the record as JSON
// inside a JSON string, or in the older format under a key of its own (ruling R3). A page load takes it out of every
// such record, opened or not, readable or not, and leaves the rest of each as it was, so a record still opens, with the
// password field empty.
const PASSWORD = "sessions-hunter2";
const passwords_checks = async () => {
	await open_paint(ready, { hide_connection_window: false });
	const own = await id_now();
	const planted = await evaluate((password) => {
		const canvas = __s.canvas(205, 105, 2), uri = canvas.toDataURL("image/png");
		const connection = { host: "old.test", port: "1234", slot: "Old" };
		const record = (canvas, pass) => ({ canvas, goal: uri, connection_info: pass ? { ...connection, pass } : { ...connection }, colors: ["rgb(0,0,0)", "rgb(255,255,255)", "#123456"] });
		const text = (value) => JSON.stringify(JSON.stringify(value));
		const cut = uri.slice(0, Math.floor(uri.length / 2));
		// Each key as the older version wrote it, and as it should read after a page load.
		const keys = {
			"image#sessions-pw-1": [text(record(uri, password)), text(record(uri))],
			"image#sessions-pw-2": [text(record(uri, password)), text(record(uri))],
			"image#sessions-pw-old": [JSON.stringify(uri), JSON.stringify(uri)],
			"image#sessions-pw-old_connection_info": [text({ ...connection, pass: password }), text(connection)],
			"image#sessions-pw-cut": [text(record(cut, password)), text(record(cut))],
		};
		for (const [key, [value]] of Object.entries(keys)) localStorage.setItem(key, value);
		return { digest: __s.digest(canvas), expected: Object.fromEntries(Object.entries(keys).map(([key, [, after]]) => [key, after])), holding: Object.keys(localStorage).filter((key) => String(localStorage.getItem(key)).includes(password)).length };
	}, PASSWORD);
	await reload_paint(ready, { hide_connection_window: false });
	const after = await evaluate((keys, password) => ({ values: Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), holding: Object.keys(localStorage).filter((key) => String(localStorage.getItem(key)).includes(password)) }), Object.keys(planted.expected), PASSWORD);
	const changed_otherwise = Object.keys(planted.expected).filter((key) => after.values[key] !== planted.expected[key]);
	await go_to("sessions-pw-1");
	const opened = { ...(await restore_now()), page: await page_area([0, 0, 205, 105]), host: await evaluate(() => $("[name=aphost]").val()), pass: await evaluate(() => $("[name=appass]").val()) };
	check("a page load takes the room password out of every session record an older version left in localStorage, in both of its formats, opened or not, readable or not, and leaves the rest of each record as it was, so a record still opens", planted.holding === 4 && after.holding.length === 0 && changed_otherwise.length === 0 && opened.id === "sessions-pw-1" && opened.outcome === "restored" && opened.page.digest === planted.digest && opened.host === "old.test" && opened.pass === "", JSON.stringify({ keys_with_the_password: { planted: planted.holding, after_a_load: after.holding }, changed_otherwise, opened }));
	for (const id of new Set(["sessions-pw-1", "sessions-pw-2", "sessions-pw-old", "sessions-pw-cut", own, await id_now()])) await forget(id);
};

// 19. Connect makes one login at a time (ruling R11). Clicks while a login waits for the restore or for the server start
// none, and the line under Connect says what the login waits for. A field typed in before the restore's read lands stays
// as typed. After a login the server refused, the next keeps Connect taken until it lands, though the library closes
// the refused login's socket as it begins, which fires the event a drop fires. A connection that drops while its login
// waits for the room's data package gives Connect back; the library still holds that login, and the server's answers to
// the next one answer it too, so the page takes the latest login's answer alone, and runs no trap the slot had already
// received. A login clicked past says nothing when the server refuses it with the next. A login that lands while a
// stored session restores: one of another game is turned away as its canvas lands, with the loaded game's goal and
// palette on the page and the address the login went to in the form; one of no game yet opens, and keeps the login's
// game as its canvas lands.
const login_checks = async () => {
	await use(ALERTS);
	const ids = [];
	// Three clicks while the restore waits at its decode, then a reload whose database open answers 3 s late, with a port
	// and a slot typed meanwhile.
	await serve(config_for(game("SESSION-LOGIN-1", 800, 600, 2, 1)));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const stored = await id_now();
	ids.push(stored);
	const painted = await paint_rows(0, 50, 1);
	await wait_record(stored, painted.area, painted.digest);
	const held = await use(HOLD_DECODE);
	await reload_paint(ready, { hide_connection_window: false, restored: false });
	const reached = await wait_held();
	for (let i = 0; i < 3; i++) {
		await click_connect();
		await sleep(300);
	}
	const waiting = { ready: (await restore_now()).ready, ...(await connect_state()) };
	await evaluate(() => window.__release_decodes?.());
	for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
	await sleep(500);
	const landed = { ...(await connect_state()), shown: await window_shown() };
	await unuse(held);
	check("three clicks on Connect while the canvas decodes make one login, with Connect disabled meanwhile and a line under it that says what the login waits for", reached && waiting.ready === false && waiting.disabled && waiting.line === "Restoring this tab's canvas from storage..." && waiting.sockets === 0 && landed.sockets === 1 && landed.connects === 1 && !landed.shown && !landed.disabled, JSON.stringify({ reached, waiting, landed }));
	const slow = await use(SLOW_OPEN);
	await reload_paint(ready, { hide_connection_window: false, restored: false });
	const at_first = { ready: (await restore_now()).ready, form: await form_now() };
	await evaluate(() => { __s.type("apport", "55555"); __s.type("apslot", "Typed"); });
	await wait_ready();
	await sleep(300);
	const typed = { outcome: (await restore_now()).outcome, form: await form_now() };
	await unuse(slow);
	check("a field of the connection form typed in before the restore's read lands stays as typed, and the restore fills the others", at_first.ready === false && at_first.form.slot === "" && typed.outcome === "restored" && typed.form.port === "55555" && typed.form.slot === "Typed" && typed.form.host === "fake.test", JSON.stringify({ at_first, typed }));

	// A login the server refuses, then one whose answer waits 1.5 s, read 250 and 500 ms in.
	await serve(config_for(game("SESSION-LOGIN-2", 800, 600, 2, 1)));
	await open_paint(ready, { hide_connection_window: false });
	ids.push(await id_now());
	await evaluate(refusing_stand_in);
	await click_as("Nobody");
	let refused = null;
	for (let i = 0; i < 60; i++) {
		refused = { ...(await connect_state()), alerts: await evaluate(() => [...window.__alerts]) };
		if (!refused.disabled && refused.alerts.length) break;
		await sleep(100);
	}
	await evaluate(() => { window.__hold_ms = 1500; });
	await click_as("Painter");
	await sleep(250);
	const at_250 = await connect_state();
	await sleep(250);
	const at_500 = await connect_state();
	for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
	await sleep(500);
	const after_refusal = { ...(await connect_state()), shown: await window_shown() };
	ids.push(await id_now());
	check("after a login the server refused, the next login keeps Connect disabled and its line up until it lands, though the library closes the refused login's socket as that login begins", refused.alerts.length === 1 && /refused/i.test(refused.alerts[0]) && !refused.disabled && at_250.disabled && at_500.disabled && at_250.line === "Connecting..." && at_500.line === "Connecting..." && !after_refusal.shown && !after_refusal.disabled && after_refusal.line === "", JSON.stringify({ refused, at_250, at_500, landed: after_refusal }));

	// A slot that has received one Invert Colors Trap already. Its connection drops while the login waits for the room's
	// data package, and the player clicks again.
	const replayed = config_for(game("SESSION-LOGIN-3", 800, 600, 2, 1, ["Invert Colors Trap"]));
	replayed.package = { ...replayed.package, checksum: "sessions-login-3" };
	await serve(replayed);
	await open_paint(ready, { hide_connection_window: false });
	ids.push(await id_now());
	await evaluate(refusing_stand_in);
	await evaluate(() => { window.__no_package = true; });
	await click_connect();
	await sleep(700);
	const asking = await connect_state();
	await evaluate(() => __ap.drop());
	await sleep(300);
	const dropped = { ...(await connect_state()), shown: await window_shown() };
	await evaluate(() => { window.__no_package = false; });
	await click_connect();
	for (let i = 0; i < 100 && (await window_shown()); i++) await sleep(100);
	await wait_goal();
	await sleep(800);
	const retried = { ...(await connect_state()), shown: await window_shown(), pixel: await evaluate(() => [...main_ctx.getImageData(0, 0, 1, 1).data].join()), undos: await evaluate(() => undos.length) };
	ids.push(await id_now());
	check("a connection that drops while its login waits for the room's data package gives Connect back with a line that says so, and the next login runs no trap the slot had already received, though the library answers the login before it too", asking.disabled && asking.package_asks === 1 && asking.connects === 0 && !dropped.disabled && dropped.line === "The connection dropped before the login went through. Connect to try again." && dropped.shown && !retried.shown && retried.pixel === "255,255,255,255" && retried.undos === 0, JSON.stringify({ asking, dropped, retried }));
	// Six undo steps, then one Undo Trap and one chat message from the server.
	for (let i = 0; i < 6; i++) await paint_rows(i * 5, i * 5 + 5, i + 1);
	const steps = await evaluate(() => undos.length);
	await evaluate((item) => __ap.push(item), id_of("Undo Trap"));
	await sleep(600);
	const undone = steps - (await evaluate(() => undos.length));
	await evaluate(() => { for (const s of __ap.sockets) if (s.readyState === 1) s._reply([{ cmd: "PrintJSON", type: "Chat", data: [{ text: "SESSIONS-MARK" }] }]); });
	await sleep(300);
	const lines = await evaluate(() => (document.querySelector("#text-log")?.textContent.match(/SESSIONS-MARK/g) ?? []).length);
	check("...and sets the page up once: one Undo Trap undoes one step, and one chat message is one line", retried.sockets === 2 && retried.open === 1 && undone === 1 && lines === 1, JSON.stringify({ sockets: retried.sockets, open: retried.open, undone, lines }));

	// A login whose Connect the server never answers. Its connection drops, and the next login is refused.
	await serve(config_for(game("SESSION-LOGIN-4", 800, 600, 2, 1)));
	await open_paint(ready, { hide_connection_window: false });
	ids.push(await id_now());
	await evaluate(refusing_stand_in);
	await evaluate(() => { window.__hold_ms = 600000; });
	await click_connect();
	await sleep(400);
	const unanswered = await connect_state();
	await evaluate(() => __ap.drop());
	await sleep(300);
	const given_back = await connect_state();
	await evaluate(() => { window.__hold_ms = 0; });
	await click_as("Nobody");
	for (let i = 0; i < 40 && !(await evaluate(() => window.__alerts.length)); i++) await sleep(100);
	await sleep(600);
	const past = { ...(await connect_state()), shown: await window_shown(), alerts: await evaluate(() => [...window.__alerts]) };
	check("a login the server refuses shows one alert, and none for the login before it, clicked past after its connection dropped, which the library refuses with it", unanswered.disabled && unanswered.connects === 1 && !given_back.disabled && past.alerts.length === 1 && /refused/i.test(past.alerts[0]) && !past.disabled && past.shown, JSON.stringify({ unanswered, given_back, past }));

	// What a page that logs into the next game alone shows: its goal and its Colors box.
	const LATE = game("SESSION-LOGIN-5", 800, 600, 2, 1);
	await serve(config_for(LATE));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const alone = { goal: await goal_now(), colors: await evaluate(() => palette.length) };
	ids.push(await id_now());
	// A new page, a stored session planted, and a login whose answer waits 1.5 s: meanwhile the address goes to that
	// session, whose canvas waits at its decode, so the login lands during the restore. Then the decode goes on.
	const login_during_restore = async (id, game_of_record, fields) => {
		await open_paint(ready, { hide_connection_window: false });
		ids.push(await id_now(), id);
		const planted = await evaluate(async (id, game_of_record, fields) => {
			if (fields.goal) {
				const goal = await __s.blob(__s.canvas(800, 800, 11));
				fields.goal = await __s.sha256(goal);
				await __s.put("goals", { sha256: fields.goal, blob: goal, width: 800, height: 800, used_at: Date.now() });
			}
			return __s.plant(id, __s.canvas(fields.width, fields.height, 5), game_of_record, { final_width: fields.final_width, final_height: fields.final_height, goal: fields.goal ?? null, colors: fields.colors });
		}, id, game_of_record, fields);
		const before = await record_of(id);
		await evaluate(hold_login_and_decodes, 1500);
		await evaluate(() => {
			__s.type("aphost", "fake.test");
			__s.type("apport", "38281");
			__s.type("apslot", "Painter");
			$("button").filter((i, b) => b.textContent === "Connect!").trigger("click");
		});
		await sleep(400);
		await evaluate((id) => { location.hash = "local:" + id; }, id);
		const reached = await wait_held();
		const during = await restore_now();
		for (let i = 0; i < 40 && (await window_shown()); i++) await sleep(100);
		await sleep(300);
		const at_login = await restore_now();
		await evaluate(() => window.__release_decodes());
		await sleep(1000);
		await wait_ready();
		await wait_goal();
		await sleep(600);
		const after = { ...(await restore_now()), page: await page_area([0, 0, fields.width, fields.height]), goal: await goal_now(), colors: await evaluate(() => palette.length), form: await form_now(), said: await shown("belongs to another game") };
		const stroke = await paint_rows(40, 60, 7);
		const record = await wait_record(after.id, stroke.area, stroke.digest);
		ids.push(after.id);
		return { planted, before, landed: reached && during.id === id && during.ready === false && at_login.id === id && at_login.ready === false, after, stroke, record, end: await record_of(id) };
	};
	const late = await login_during_restore("sessions-late", { seed: "SESSION-ELSE", team: 0, slot: 1 }, { width: 300, height: 200, final_width: 800, final_height: 800, goal: true, colors: ["rgb(0,0,0)", "rgb(255,255,255)", "#123456"] });
	const late_shown = { landed: late.landed, outcome: late.after.outcome, id_changed: late.after.id !== "sessions-late", said: late.after.said, record_kept: late.end?.raw === late.before?.raw, new_record: late.record && { game: late.record.game, stroke_saved: late.record.area === late.stroke.digest } };
	check("a login that lands while a stored session of another game restores turns it away as its canvas lands: one message, its record as stored, and the tab goes on in a new session", late.landed && late.after.outcome === "another game" && late.after.id !== "sessions-late" && late.after.said === 1 && !!late.before && late.end?.raw === late.before.raw && late.record?.area === late.stroke.digest, JSON.stringify(late_shown));
	check("...with the loaded game's own goal and Colors box, where that session's goal and palette went onto the page ahead of its canvas", late.landed && late.after.goal.digest === alone.goal.digest && late.after.goal.size === alone.goal.size && late.after.colors === alone.colors, JSON.stringify({ landed: late.landed, goal: late.after.goal, colors: late.after.colors, alone }));
	check("...and with the address the login went to in the connection form and in the new session's record", late.landed && JSON.stringify(late.after.form) === JSON.stringify({ host: "fake.test", port: "38281", slot: "Painter" }) && JSON.stringify(late.record?.connection) === JSON.stringify({ host: "fake.test", port: "38281", slot: "Painter" }), JSON.stringify({ landed: late.landed, form: late.after.form, record: late.record?.connection ?? null }));
	const none = await login_during_restore("sessions-none", null, { width: 205, height: 105, final_width: 800, final_height: 600, goal: false, colors: ["rgb(0,0,0)", "rgb(255,255,255)"] });
	check("a login that lands while a stored session of no game yet restores opens it, and the session keeps the login's game as its canvas lands", none.landed && none.after.outcome === "restored" && none.after.id === "sessions-none" && none.after.page.digest === none.planted && JSON.stringify(none.record?.game) === game_of(LATE) && none.record.area === none.stroke.digest, JSON.stringify({ landed: none.landed, outcome: none.after.outcome, id_kept: none.after.id === "sessions-none", canvas: none.after.page.digest === none.planted, record: none.record && { game: none.record.game, connection: none.record.connection, stroke_saved: none.record.area === none.stroke.digest }, form: none.after.form }));
	for (const id of new Set(ids)) if (id) await forget(id);
};

// 20. Another slot, and another team, of one seed is another game (decision 7): every slot of a room has the room's one
// seed name. The stand-in logs the page in as the team and the slot its config names.
const slots_checks = async () => {
	const as = (team, slot) => ({ ...config_for(game("SESSION-ONE-SEED", 800, 600, 2, 1)), team, slot });
	const of = (team, slot) => JSON.stringify({ seed: "SESSION-ONE-SEED", team, slot });
	await serve(as(0, 1));
	await open_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_goal();
	const first = await id_now();
	const painted = await paint_rows(0, 105, 1);
	const saved = await wait_record(first, painted.area, painted.digest);
	await drop_to(as(0, 2));
	await connect();
	await wait_goal();
	const second = { id: await id_now(), white: await white_in([0, 0, 205, 105]), old: await record_of(first, painted.area) };
	second.record = await wait_stored(second.id, null, (record) => !!record?.game);
	check("a login into another slot of the same seed goes on in a new session with a blank canvas, and leaves the first slot's record as it was", JSON.stringify(saved?.game) === of(0, 1) && saved.area === painted.digest && second.id !== first && second.white === 205 * 105 && second.old?.raw === saved.raw && JSON.stringify(second.record?.game) === of(0, 2), JSON.stringify({ first: saved?.game, new_id: second.id !== first, white: second.white, old_kept: second.old?.raw === saved?.raw, game: second.record?.game }));
	const painted_2 = await paint_rows(0, 50, 2);
	const saved_2 = await wait_record(second.id, painted_2.area, painted_2.digest);
	await drop_to(as(1, 2));
	await connect();
	await wait_goal();
	const third = { id: await id_now(), white: await white_in([0, 0, 205, 105]), old: await record_of(second.id, painted_2.area) };
	third.record = await wait_stored(third.id, null, (record) => !!record?.game);
	check("...and so does a login into the same seed and slot in another team", saved_2?.area === painted_2.digest && third.id !== second.id && third.white === 205 * 105 && third.old?.raw === saved_2.raw && JSON.stringify(third.record?.game) === of(1, 2), JSON.stringify({ new_id: third.id !== second.id, white: third.white, old_kept: third.old?.raw === saved_2?.raw, game: third.record?.game }));
	for (const id of new Set([first, second.id, third.id])) await forget(id);
};

try {
	await add_script(HELPERS);
	await section("restore", restore_checks);
	await add_script(PAGE);
	await section("address", address_checks);
	await section("typed", typed_checks);
	await section("switch", switch_checks);
	await section("failed", failed_checks);
	await section("passwords", passwords_checks);
	await section("login", login_checks);
	await section("slots", slots_checks);

	check("no page errors", page_errors.length === 0, page_errors.slice(0, 5).join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	if (left_out.length) console.log(`SKIP  ${left_out.length} of the suite's ${SECTIONS.length} sections: ${left_out.join(", ")}  (PAIN_T_ONLY names ${only.join(", ")})`);
	finish();
}
