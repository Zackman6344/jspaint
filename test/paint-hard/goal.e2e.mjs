// End-to-end test of the seed's goal (task 7.8 of the fork's ROADMAP, D17, D18 and decision 19), and of two ways past
// the canvas the items unlock. From version 1.2.0 a seed's slot data names its goal image, a path in the client's site
// or an https URL, with its SHA-256 and the goal's size. The page loads it once for each seed, team, slot, reference,
// hash and size, checks the hash and the size, decodes it with no color conversion, flattens transparency onto white and
// draws it as the only goal; until then it sends nothing, auto copy waits and M says why it can't copy. A goal it can't
// score against is refused with one message naming the file and what is wrong, and a Retry. The file is kept in the goals
// store, for a reload or a later visit, while its hash and size match the seed's. Seeds before 1.2.0 keep the bundled
// image and File > Open Goal Image. Then Shift+Insert pastes nothing, and Image > Attributes > Default gives the size
// the items unlock. From the repair of S7: a store with no room for the goal's file keeps no copy and says nothing while
// the session's canvas still saves; a goal drawn while the connection is down; old and new seeds in one tab; a click on
// the status bar's field shows the Goal Image window again after Close; and sends held while the browser blocks canvas
// reads. From S7's last fix (RC1): once canvas reads were blocked, the page sends and saves nothing until a reload,
// which restores the session's last save, in a session with a record (allowed) and one without (allowednew), and the
// page says once to reload. From its repair: the login's resize leaves the canvas blank while reads are blocked
// (allowednew); reads blocked with the page open count from the next send or save (midpage), and so does a block only a
// pixel M wrote and read back finds (readback); one-level noise, as Brave's, keeps sending and saving (onelevel); auto
// copy and M wait for the reload too (copyheld), and stop before they paint once a probe elsewhere finds the reads
// blocked (guards). The page logs in through its own Connect button to a stand-in server
// (stand-in-server.mjs), which serves the goals from this run's own folder on two origins. It runs in Chrome and
// Firefox (decision 16). Firefox takes its quota for a whole run, so there the full section runs alone, with
// PAIN_T_ONLY=full and PAIN_T_FIREFOX_PREFS={"dom.quotaManager.temporaryStorage.fixedLimit":51200}, and is a SKIP line
// otherwise.
// Usage: node test/paint-hard/goal.e2e.mjs [--browser=chrome|firefox] [--headful]. PAIN_T_ONLY=<section>,<section>
// runs only those sections and prints the others as a SKIP line. Set BROWSER_PATH if the browser isn't in its default
// folder.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { add_init_script, check, chromium, close_tab, evaluate, finish, keyboard, limits, mouse, new_tab, open_paint, ORIGIN, override_quota, page_errors, point_on, reload_paint, remove_init_script, request_count, requests, SECOND_ORIGIN, sleep, TEST_FILES } from "./harness.mjs";
import { decodePNG } from "./png.mjs";
import { RECORDS, record_of } from "./session-records.mjs";
import { CONTRACT, ITEMS, LOCATIONS, connect, fake_server, id_of, window_shown } from "./stand-in-server.mjs";

const SECTIONS = ["site", "https", "hash", "size", "side", "decode", "retry", "closed", "slow", "progress", "reconnect", "drop", "reload", "full", "slot", "tabs", "old", "seeds", "default", "swap", "decoders", "reads", "allowed", "allowednew", "midpage", "readback", "onelevel", "copyheld", "guards", "paste", "attributes"];
const only = process.env.PAIN_T_ONLY ? process.env.PAIN_T_ONLY.split(",") : SECTIONS;
for (const name of only) if (!SECTIONS.includes(name)) throw new Error(`PAIN_T_ONLY names ${name}, not one of ${SECTIONS.join(", ")}`);
const left_out = SECTIONS.filter((name) => !only.includes(name));

// --- Goals, written in Node ---
const CRC = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (bytes) => {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), body.length + 4);
	return out;
};
// FNV-1a over bytes, as session-records.mjs's __t.digest() in the page.
const digest = (data) => {
	let h = 2166136261;
	for (let i = 0; i < data.length; i++) {
		h ^= data[i];
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
// A PNG of `width` x `height`, 8 bits a channel, RGB or with alpha, from pixel(x, y) = [r, g, b, a], and the RGBA the goal
// canvas should hold for it: each pixel as it shows over white. With `damage`, 64 bytes from the middle of its image data
// are inverted before the chunks are made, so every chunk's CRC holds over damaged data.
function goal_png(width, height, pixel, alpha = false, damage = false) {
	const bpp = alpha ? 4 : 3, stride = width * bpp + 1;
	const raw = Buffer.alloc(height * stride), expected = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a = 255] = pixel(x, y);
			const at = y * stride + 1 + x * bpp, to = (y * width + x) * 4;
			raw[at] = r;
			raw[at + 1] = g;
			raw[at + 2] = b;
			if (alpha) raw[at + 3] = a;
			const white = 255 - a;
			expected[to] = a === 255 ? r : Math.round(r * a / 255) + white;
			expected[to + 1] = a === 255 ? g : Math.round(g * a / 255) + white;
			expected[to + 2] = a === 255 ? b : Math.round(b * a / 255) + white;
			expected[to + 3] = 255;
		}
	}
	const head = Buffer.alloc(13);
	head.writeUInt32BE(width, 0);
	head.writeUInt32BE(height, 4);
	head[8] = 8;
	head[9] = alpha ? 6 : 2;
	// The image data in IDAT chunks of 64 KiB, as encoders write it, with where each chunk ends.
	const data = zlib.deflateSync(raw, { level: 6 }), parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head)], ends = [];
	if (damage) for (let i = data.length >> 1, end = i + 64; i < end; i++) data[i] ^= 0xff;
	let length = parts[0].length + parts[1].length;
	for (let at = 0; at < data.length; at += 65536) {
		parts.push(chunk("IDAT", data.subarray(at, at + 65536)));
		length += parts.at(-1).length;
		ends.push(length);
	}
	const bytes = Buffer.concat([...parts, chunk("IEND", Buffer.alloc(0))]);
	return { bytes, sha256: sha256(bytes), width, height, digest: digest(expected), expected, idat_ends: ends };
}
const write_goal = (name, goal) => fs.writeFileSync(path.join(TEST_FILES, name), goal.bytes);
const pattern = (seed) => (x, y) => [(x * 7 + y * 3 + seed * 41) & 255, (x * 5 + y * 11 + 64 + seed * 13) & 255, (x ^ (y * 3) ^ seed) & 255];
const A = goal_png(400, 300, pattern(1));
const B = goal_png(400, 300, pattern(2));
const C = goal_png(300, 200, pattern(3));
// Noise, which barely compresses, as six of the user's eight photos don't: about 3 bytes a pixel. Its pixels come in
// order, row by row, from a xorshift seeded with `seed`.
const noise = (seed) => {
	let s = seed >>> 0 || 1;
	const next = () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5; s >>>= 0;
		return s & 255;
	};
	return () => [next(), next(), next()];
};

// --- The stand-in's games ---
const SLOT = CONTRACT.slot_data;
// A 1.2.0 seed's slot data with its goal, and the whole goal unlocked from the start, so a canvas painted with the goal's
// own pixels scores 100%.
const slot_data = (width, height, goal_image = "default", goal_image_sha256 = "", more = {}) => ({ ...SLOT, version: "1.2.0", final_width: width, final_height: height, start_width: width, start_height: height, matched_pixels: 0, death_link: 0, goal_image, goal_image_sha256, ...more });
// A seed from before 1.2.0, whose slot data names no goal: the bundled image of its size.
const old_data = (width, height, more = {}) => ({ ...slot_data(width, height), version: "1.1.0", goal_image: undefined, goal_image_sha256: undefined, ...more });
const item = (name, i) => ({ item: id_of(name), location: 2199000 + 9000 + i, player: 1, flags: 1 });
const config = (seed, data, more = {}) => ({ seed, items: ["Magnifier", "Brush", ...(more.items ?? [])].map(item), late_item: item("Progressive Canvas Width", 900), locations: LOCATIONS, slot_data: data, package: { checksum: "items-py", item_name_to_id: ITEMS, location_name_to_id: {} }, ...(more.slot ? { slot: more.slot } : {}) });
const site = (name) => `__test__/${name}`;

// --- The page ---
const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
const PAGE = `${RECORDS}
window.paint_hard_save_every_ms = 200;
// What the goal window and other message boxes say, and the status bar's similarity field.
window.__shown = () => [...document.querySelectorAll(".window")].filter((w) => w.offsetParent !== null && !/Archipelago Connection Options/.test(w.textContent)).map((w) => w.textContent.replace(/\\s+/g, " ").trim());
window.__goal_window = () => { const w = document.querySelector(".goal-image-window"); return w && w.offsetParent !== null ? w.textContent.replace(/\\s+/g, " ").trim() : null; };
window.__press = (selector, label) => { const button = [...document.querySelectorAll(selector + " button")].find((b) => b.textContent.trim() === label && b.offsetParent !== null); if (!button) return false; button.click(); return true; };
window.__checks = () => __ap.log.filter((p) => p.cmd === "LocationChecks");
`;
let server = null;
const serve = async (cfg) => {
	if (server) await remove_init_script(server);
	server = await add_init_script(fake_server(cfg));
};
const status = () => evaluate(() => window.paint_hard_goal.status());
const goal_digest = () => evaluate(() => __t.digest(goal_ctx.getImageData(0, 0, goal_canvas.width, goal_canvas.height).data));
const similarity_field = () => evaluate(() => $status_similarity.text());
const checks_sent = () => evaluate(() => ({ packets: __checks().length, ids: __checks().flatMap((p) => p.locations).length, goal: __ap.log.some((p) => p.cmd === "StatusUpdate" && p.status === 30) }));
const wait_for = async (what, holds, ms = 20000, ...args) => {
	for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) {
		const value = await evaluate(holds, ...args).catch(() => null);
		if (value) return value;
	}
	console.log(`[goal] ${what} didn't hold in ${ms / 1000} s: the test goes on`);
	return null;
};
const wait_state = (states, ms) => wait_for(`the goal's state in ${states}`, `(() => ${JSON.stringify(states)}.includes(window.paint_hard_goal?.status().state))()`, ms);
// Opens a fresh page as the stand-in's game and logs in. The goals store starts empty, unless `keep` says otherwise: a
// goal one section stored would otherwise come from the store, by its SHA-256, where the next one means a download.
const clear_goals = () => evaluate(async () => {
	const db = await __t.db();
	if (!db) return;
	await new Promise((resolve) => {
		const transaction = db.transaction("goals", "readwrite");
		transaction.objectStore("goals").clear();
		transaction.oncomplete = resolve;
		transaction.onabort = resolve;
	});
	db.close();
});
const play = async (cfg, before = "", { keep = false } = {}) => {
	await serve(cfg);
	await open_paint(ready, { hide_connection_window: false });
	if (!keep) await clear_goals();
	if (before) await evaluate(before);
	await connect();
};
// A stroke of a goal's own pixels, from a copy of its file under a name of its own, as UPNG decodes it in the page, as one
// undo step: what a player's strokes leave, scored and sent through undoable(). No goal canvas pixel is read for it, and
// no request for the goal's own file is made.
const paint_with = async (goal) => {
	const name = `paint-${goal.sha256.slice(0, 12)}.png`;
	write_goal(name, goal);
	await evaluate(async (url) => {
		const png = await __t.png(url);
		const image = new ImageData(new Uint8ClampedArray(png.data), png.width, png.height);
		const fn = await import("/src/functions.js");
		try {
			fn.undoable({ name: "Test stroke" }, () => { main_ctx.putImageData(image, 0, 0); });
		} catch (error) {
			if (!/not connected/i.test(error.message)) throw error;
		}
	}, `/__test__/${name}`);
};
// The message window says so once: the goal window shows, with what it should say, and no other message box opened.
const one_message = async (...parts) => {
	const shown = await evaluate(() => __shown());
	const goal = shown.filter((text) => /Goal Image/.test(text));
	return { ok: goal.length === 1 && shown.length === 1 && parts.every((part) => goal[0].includes(part)), shown };
};
// The Auto Copy panel's state line, with auto copy started.
const auto_copy_line = async () => {
	await evaluate(async () => (await import("/src/auto-copy.js")).show_auto_copy_panel());
	await sleep(200);
	await evaluate(() => [...document.querySelectorAll(".auto-copy-panel button")].find((b) => /^(Start|Resume)$/.test(b.textContent))?.click());
	await sleep(600);
	const line = await evaluate(() => document.querySelector(".auto-copy-panel .window-content div")?.textContent ?? null);
	await evaluate(() => { [...document.querySelectorAll(".auto-copy-panel button")].find((b) => b.textContent === "Pause")?.click(); });
	return line;
};
// M pressed over the canvas, and the status bar's text after it.
const press_m = async () => {
	const point = await point_on("canvas", 10, 10);
	await mouse.move(point.x, point.y);
	await keyboard.press("m");
	await sleep(200);
	return evaluate(() => $status_text.text());
};
// A login into another game in the same tab, as the player's next slot or seed: the stand-in takes its config and drops
// the connection, and the page logs in again through Connect.
const another_game = async (cfg) => {
	await evaluate((cfg) => { __ap.use(cfg); __ap.drop(); }, cfg);
	await sleep(300);
	await connect();
};
// A fill of a rectangle as one undo step, scored and sent through undoable() as a stroke is, and the digest of that
// rectangle of the canvas after it. The page's own reads may be blocked meanwhile (the reads section): the test's read
// isn't (window.__test_reading).
const fill_stroke = (x, y, w, h, color) => evaluate(async (x, y, w, h, color) => {
	const fn = await import("/src/functions.js");
	try {
		fn.undoable({ name: "Test fill" }, () => { main_ctx.fillStyle = color; main_ctx.fillRect(x, y, w, h); });
	} catch (error) {
		if (!/not connected/i.test(error.message)) throw error;
	}
	window.__test_reading = true;
	try { return __t.canvas(main_ctx, x, y, w, h); } finally { window.__test_reading = false; }
}, x, y, w, h, color);
// The goal canvas's digest as the test reads it, past a stand-in that blocks the page's reads.
const goal_digest_as_drawn = () => evaluate(() => { window.__test_reading = true; try { return __t.digest(goal_ctx.getImageData(0, 0, goal_canvas.width, goal_canvas.height).data); } finally { window.__test_reading = false; } });
const session_id = () => evaluate(() => window.paint_hard_session?.id ?? null);
// The main tab, sent to Paint at another address from the page it shows, and back when Paint holds the suite's ready
// condition, with its session's restore settled, up to 20 s.
const go_to = async (url) => {
	await evaluate(() => { window.__going = true; });
	await evaluate((url) => { location.href = url; }, url);
	for (let i = 0; i < 200 && !(await evaluate(() => !window.__going && typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy && window.paint_hard_session?.ready === true).catch(() => false)); i++) await sleep(100);
	await sleep(500);
};

// --- The sections ---
const section_scripts = new Set();
const section = async (name, run) => {
	if (!only.includes(name)) return;
	const began = Date.now();
	try {
		await run();
	} catch (error) {
		check(`${name}: ran without exceptions`, false, error?.stack || String(error));
	}
	for (const id of section_scripts) await remove_init_script(id);
	section_scripts.clear();
	console.log(`(${name}: ${((Date.now() - began) / 1000).toFixed(1)} s)`);
};

const site_checks = async () => {
	write_goal("site-a.png", A);
	await play(config("GOAL-SITE", slot_data(400, 300, site("site-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), drawn = await goal_digest(), field = await similarity_field();
	check("a 1.2.0 seed's goal from a path in the site, with its SHA-256, is drawn as the goal, pixel for pixel, at the seed's size",
		s.state === "ready" && s.locked && drawn === A.digest && s.drawn?.sha256 === A.sha256 && s.last?.from === "network" && /%\//.test(field),
		JSON.stringify({ state: s.state, from: s.last?.from, decoder: s.last?.decoder, drawn, want: A.digest, field, failure: s.failure }));
	check("...downloaded once, from the page's own site", request_count("/__test__/site-a.png", "main") === 1 && request_count("/__test__/site-a.png", "second") === 0, JSON.stringify(requests.filter((r) => r.path === "/__test__/site-a.png")));
	const before = await checks_sent();
	await paint_with(A);
	await sleep(300);
	const after = await checks_sent();
	check("...and a canvas painted with its pixels sends its checks and the goal", before.ids === 0 && after.ids === 8018 && after.goal, JSON.stringify({ before, after }));
};

const https_checks = async () => {
	write_goal("far-b.png", B);
	await play(config("GOAL-HTTPS", slot_data(400, 300, `${SECOND_ORIGIN}/__test__/far-b.png?cors=1`, B.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), drawn = await goal_digest();
	check("a goal from an address on another origin is fetched with CORS and drawn", s.state === "ready" && drawn === B.digest && request_count("/__test__/far-b.png", "second") === 1,
		JSON.stringify({ state: s.state, drawn, want: B.digest, requests: request_count("/__test__/far-b.png", "second"), failure: s.failure }));
	write_goal("far-closed.png", B);
	await play(config("GOAL-NO-CORS", slot_data(400, 300, `${SECOND_ORIGIN}/__test__/far-closed.png`, B.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const closed = await status(), message = await one_message("couldn't download the goal image", "far-closed.png", "the request failed", "Paint sends no checks");
	check("...and one from a host that doesn't allow CORS is refused, with one message that names the file and says the download failed",
		closed.state === "failed" && closed.failure?.what === "download" && message.ok, JSON.stringify({ state: closed.state, failure: closed.failure, shown: message.shown }));
};

const hash_checks = async () => {
	write_goal("hash-a.png", A);
	await play(config("GOAL-HASH", slot_data(400, 300, site("hash-a.png"), B.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), message = await one_message("can't use the goal image", "hash-a.png", A.sha256, B.sha256, "Paint sends no checks");
	check("a goal whose SHA-256 isn't the seed's is refused, with one message that names the file and both hashes", s.state === "failed" && s.failure?.what === "hash" && message.ok, JSON.stringify({ state: s.state, failure: s.failure, shown: message.shown }));
	const blank = await evaluate(() => goal_ctx.getImageData(0, 0, goal_canvas.width, goal_canvas.height).data.every((v) => v === 0));
	const rescores = await evaluate(async () => (await import("/src/functions.js")).rescore_count());
	await paint_with(A);
	await sleep(300);
	const sent = await checks_sent(), field = await similarity_field(), again = await evaluate(() => __shown());
	const scored = (await evaluate(async () => (await import("/src/functions.js")).rescore_count())) - rescores;
	check("...the page then sends nothing for a canvas painted with that file's pixels, draws no goal, and its status bar says it has no goal", blank && sent.packets === 0 && !sent.goal && field === "No goal",
		JSON.stringify({ blank, sent, field }));
	check("...and the stroke scores nothing against the missing goal", scored === 0, JSON.stringify({ scored }));
	check("...and a stroke adds no second message", again.length === 1, JSON.stringify(again));
	const line = await auto_copy_line();
	check("...auto copy waits for the goal image", line === "Waiting for the goal image.", JSON.stringify(line));
	const said = await press_m();
	const still = await checks_sent();
	check("...and M says it can't copy until the goal image has loaded, and sends nothing", said === "M can't copy until the goal image has loaded." && still.packets === 0, JSON.stringify({ said, still }));
};

const size_checks = async () => {
	write_goal("size-a.png", A);
	await play(config("GOAL-SIZE", slot_data(500, 300, site("size-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), message = await one_message("can't use the goal image", "size-a.png", "400x300", "500x300");
	check("a goal of another size than the seed's is refused, with one message that names the file and both sizes", s.state === "failed" && s.failure?.what === "size" && message.ok, JSON.stringify({ state: s.state, failure: s.failure, shown: message.shown }));
};

const side_checks = async () => {
	const wide = goal_png(4097, 2, pattern(4));
	write_goal("side-wide.png", wide);
	await play(config("GOAL-SIDE", slot_data(4097, 2, site("side-wide.png"), wide.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), message = await one_message("can't use the goal image", "side-wide.png", "4097x2", "4096 pixels a side");
	check("a goal past 4096 a side is refused before any download, with one message that names the file and the limit",
		s.state === "failed" && s.failure?.what === "side" && message.ok && request_count("/__test__/side-wide.png") === 0, JSON.stringify({ state: s.state, failure: s.failure, shown: message.shown, requests: request_count("/__test__/side-wide.png") }));
	// An http address off this computer, which the world refuses: a name under .invalid, which no resolver answers.
	await play(config("GOAL-HTTP", slot_data(400, 300, "http://goal.invalid/goal.png", A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const http_goal = await status(), http_message = await one_message("can't load the goal image", "http://goal.invalid/goal.png", "https address");
	check("...and so is a goal at an http address off this computer, before any download", http_goal.state === "failed" && http_goal.failure?.what === "address" && http_message.ok && (await status()).counts.downloads === 0,
		JSON.stringify({ state: http_goal.state, failure: http_goal.failure, shown: http_message.shown, downloads: http_goal.counts.downloads }));
};

const decode_checks = async () => {
	fs.writeFileSync(path.join(TEST_FILES, "not-a.png"), Buffer.from("this is a text file and no picture at all\n".repeat(50)));
	await play(config("GOAL-NOT-PNG", slot_data(400, 300, site("not-a.png"))));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), message = await one_message("can't use the goal image", "not-a.png", "isn't a PNG file");
	check("a file that isn't a PNG is refused, with one message that names it", s.state === "failed" && s.failure?.what === "decode" && message.ok, JSON.stringify({ state: s.state, failure: s.failure, shown: message.shown }));
	// A PNG cut short after one of its IDAT chunks, about halfway, each chunk whole, with no hash in the seed to catch it.
	fs.writeFileSync(path.join(TEST_FILES, "cut-a.png"), A.bytes.subarray(0, A.idat_ends[Math.floor(A.idat_ends.length / 2) - 1]));
	await play(config("GOAL-CUT", slot_data(400, 300, site("cut-a.png"))));
	await wait_state(["ready", "failed", "canceled"]);
	const cut = await status(), cut_message = await one_message("can't use the goal image", "cut-a.png", "won't decode", "ends before its last chunk");
	check("...and so is a PNG cut short, with no hash in the seed to catch it", cut.state === "failed" && cut.failure?.what === "decode" && cut_message.ok, JSON.stringify({ state: cut.state, failure: cut.failure, shown: cut_message.shown }));
	// A PNG whose image data is damaged inside its chunks, each CRC holding, IEND and all. UPNG's inflater can loop for good
	// on such data, holding the page: a page that stops answering counts as this check failing.
	const damaged = goal_png(400, 300, pattern(8), false, true);
	write_goal("damaged.png", damaged);
	let broken = null, broken_message = { ok: false, shown: [] };
	const call_limit = limits.call;
	limits.call = 30000;
	try {
		await play(config("GOAL-DAMAGED", slot_data(400, 300, site("damaged.png"))));
		await wait_state(["ready", "failed", "canceled"]);
		broken = await status();
		broken_message = await one_message("can't use the goal image", "damaged.png", "damaged or cut short");
	} catch (error) {
		broken = { state: "the page stopped answering", failure: String(error?.message ?? error) };
	} finally {
		limits.call = call_limit;
	}
	check("...and so is a PNG whose image data is damaged, with no hash in the seed to catch it, and the page goes on answering",
		broken?.state === "failed" && broken.failure?.what === "decode" && broken_message.ok, JSON.stringify({ state: broken?.state, failure: broken?.failure, shown: broken_message.shown }));
};

const retry_checks = async () => {
	await play(config("GOAL-RETRY", slot_data(400, 300, site("late-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), message = await one_message("couldn't download the goal image", "late-a.png", "404", "Retry");
	check("a goal the server answers 404 for is refused, with one message that names the file, the status and a Retry", s.state === "failed" && s.failure?.what === "download" && message.ok, JSON.stringify({ state: s.state, failure: s.failure, shown: message.shown }));
	write_goal("late-a.png", A);
	await paint_with(A);
	await sleep(300);
	const held = await checks_sent();
	const pressed = await evaluate(() => __press(".goal-image-window", "Retry"));
	await wait_state(["ready", "failed"]);
	await sleep(400);
	const after = await status(), drawn = await goal_digest(), sent = await checks_sent(), shown = await evaluate(() => __shown());
	check("...Retry downloads it again and draws it, and the window goes", pressed && after.state === "ready" && drawn === A.digest && shown.length === 0 && request_count("/__test__/late-a.png") === 2,
		JSON.stringify({ pressed, state: after.state, drawn, want: A.digest, shown, requests: request_count("/__test__/late-a.png") }));
	check("...and the stroke made while the goal was missing sends nothing until then, and its checks once, as the goal is drawn", held.packets === 0 && sent.packets === 1 && sent.ids === 8018 && sent.goal, JSON.stringify({ held, sent }));
};

const slow_checks = async () => {
	write_goal("slow-a.png", A);
	await play(config("GOAL-SLOW", slot_data(400, 300, site("slow-a.png?delay=12000"), A.sha256)));
	await wait_for("the goal window", () => __goal_window(), 3000);
	const s = await status(), window_text = await evaluate(() => __goal_window()), field = await similarity_field();
	check("while a slow server holds the goal, a window says it is loading, with Cancel, and the status bar says the goal is loading",
		s.state === "loading" && /Loading the goal image __test__\/slow-a\.png\?delay=12000/.test(window_text ?? "") && /Cancel/.test(window_text ?? "") && field === "Loading goal",
		JSON.stringify({ state: s.state, window_text, field }));
	await paint_with(A);
	await sleep(300);
	const held = await checks_sent();
	const line = await auto_copy_line();
	const said = await press_m();
	check("...a stroke sends nothing, auto copy waits for the goal image and M says it can't copy", held.packets === 0 && line === "Waiting for the goal image." && said === "M can't copy until the goal image has loaded.", JSON.stringify({ held, line, said }));
	const pressed = await evaluate(() => __press(".goal-image-window", "Cancel"));
	await sleep(800);
	const canceled = await status(), canceled_text = await evaluate(() => __goal_window());
	check("...Cancel stops the load, and the window says the goal didn't load and offers Retry", pressed && canceled.state === "canceled" && /You canceled the goal image/.test(canceled_text ?? "") && /Retry/.test(canceled_text ?? ""),
		JSON.stringify({ pressed, state: canceled.state, canceled_text }));
	// Past the server's 12 s: a download left going would have had its answer by now.
	const asked_at = requests.find((r) => r.path === "/__test__/slow-a.png")?.at ?? Date.now();
	await sleep(Math.max(0, asked_at + 12500 - Date.now()));
	const late = await goal_digest(), late_sent = await checks_sent(), download = requests.filter((r) => r.path === "/__test__/slow-a.png");
	check("...the download it stopped got no answer, and nothing was drawn or sent", (await status()).state === "canceled" && download.length === 1 && download[0].status === null && late !== A.digest && late_sent.packets === 0,
		JSON.stringify({ download, late, late_sent }));
	await evaluate(() => __press(".goal-image-window", "Retry"));
	await wait_state(["ready", "failed"]);
	await sleep(400);
	const after = await status(), sent = await checks_sent();
	check("...then Retry loads it, and the held stroke's checks go out once", after.state === "ready" && (await goal_digest()) === A.digest && sent.packets === 1 && sent.ids === 8018, JSON.stringify({ state: after.state, failure: after.failure, from: after.last?.from, times: after.last?.times, sent }));
};

// The page's fetch of a progress-* goal hands its body over in 8 parts, 400 ms apart, with its length, as a slow host's
// download comes: the stand-in's servers answer a file at once.
const SLOW_BODY = `(() => {
	const real = window.fetch;
	window.fetch = async (url, options) => {
		if (!String(url).includes("/__test__/progress-")) return real(url, options);
		const response = await real(url, options);
		const bytes = new Uint8Array(await response.arrayBuffer());
		let part = 0;
		const body = new ReadableStream({ async pull(controller) {
			if (part === 8) return controller.close();
			await new Promise((resolve) => setTimeout(resolve, 400));
			controller.enqueue(bytes.slice(Math.floor(part * bytes.length / 8), Math.floor((part + 1) * bytes.length / 8)));
			part++;
		} });
		return new Response(body, { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
	};
})();`;
const progress_checks = async () => {
	write_goal("progress-a.png", A);
	const slow_body = await add_init_script(SLOW_BODY);
	section_scripts.add(slow_body);
	await play(config("GOAL-PROGRESS", slot_data(400, 300, site("progress-a.png"), A.sha256)));
	const seen = new Set();
	for (const until = Date.now() + 8000; Date.now() < until; await sleep(100)) {
		const text = await evaluate(() => __goal_window());
		if (text) seen.add(text.replace(/Goal Image|Cancel/g, ""));
		if ((await status()).state !== "loading") break;
	}
	const counted = [...seen].filter((text) => /Loading the goal image __test__\/progress-a\.png: \d+\.\d MB of 0\.\d MB\./.test(text));
	check("a slow download shows how much of the goal has come, of how much, as it comes", counted.length >= 2 && (await status()).state === "ready" && (await goal_digest()) === A.digest,
		JSON.stringify({ seen: [...seen], state: (await status()).state }));
};

const reconnect_checks = async () => {
	write_goal("again-a.png", A);
	await play(config("GOAL-AGAIN", slot_data(400, 300, site("again-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const before = await status();
	await evaluate(() => { window.__flag_down = 0; const watch = setInterval(() => { if (!window.paint_hard_goal.status().ready) window.__flag_down++; }, 5); window.__stop_watch = () => clearInterval(watch); });
	await evaluate(() => __ap.drop());
	await sleep(300);
	await connect();
	await sleep(500);
	const after = await status(), drawn = await goal_digest(), down = await evaluate(() => { window.__stop_watch(); return window.__flag_down; });
	check("a reconnect into the same game leaves the goal alone: no new load or download, the flag stays up and the goal canvas keeps its pixels",
		before.state === "ready" && after.state === "ready" && after.counts.loads === before.counts.loads && request_count("/__test__/again-a.png") === 1 && down === 0 && drawn === A.digest,
		JSON.stringify({ loads: [before.counts.loads, after.counts.loads], requests: request_count("/__test__/again-a.png"), down, drawn }));
};

const reload_checks = async () => {
	write_goal("kept-a.png", A);
	await play(config("GOAL-KEPT", slot_data(400, 300, site("kept-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const stored = await wait_for("the goal in the goals store", () => (async () => {
		const id = window.paint_hard_session?.id, session = id ? await __t.read("sessions", id) : null, goal = await __t.read("goals", session?.goal ?? "-");
		return session?.goal && goal?.blob ? { goal: session.goal, url: goal.url ?? null, bytes: goal.blob.size, width: goal.width, height: goal.height } : null;
	})());
	check("the session's record refers to the seed's goal file in the goals store, under its SHA-256 and with its address",
		stored?.goal === A.sha256 && stored.bytes === A.bytes.length && /\/__test__\/kept-a\.png$/.test(stored.url ?? "") && stored.width === 400 && stored.height === 300, JSON.stringify(stored));
	await reload_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status();
	check("...so a reload reads it from there: no download, and the same goal drawn", s.state === "ready" && s.last?.from === "store" && request_count("/__test__/kept-a.png") === 1 && (await goal_digest()) === A.digest,
		JSON.stringify({ state: s.state, from: s.last?.from, requests: request_count("/__test__/kept-a.png") }));
	// The stored copy replaced behind Paint's back with B's file, under A's hash: it no longer matches the seed's.
	await evaluate(async (bytes) => {
		const db = await __t.db();
		await new Promise((resolve, reject) => {
			const transaction = db.transaction("goals", "readwrite");
			transaction.objectStore("goals").get(window.paint_hard_goal.status().sha256).onsuccess = (event) => {
				const record = event.target.result;
				transaction.objectStore("goals").put({ ...record, blob: new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], { type: "image/png" }) });
			};
			transaction.oncomplete = resolve;
			transaction.onabort = () => reject(transaction.error);
		});
		db.close();
	}, B.bytes.toString("base64"));
	await reload_paint(ready, { hide_connection_window: false });
	await connect();
	await wait_state(["ready", "failed", "canceled"]);
	const fixed = await status();
	const kept = await wait_for("the goals store's copy put right", () => (async () => {
		const goal = await __t.read("goals", window.paint_hard_goal.status().sha256);
		if (!goal?.blob) return null;
		const bytes = new Uint8Array(await goal.blob.arrayBuffer());
		const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
		return hash === goal.sha256 ? hash : null;
	})(), 8000);
	check("...and a stored copy whose hash no longer matches the seed's is passed over: the goal is downloaded again, drawn right, and stored again",
		fixed.state === "ready" && fixed.last?.from === "network" && (await goal_digest()) === A.digest && request_count("/__test__/kept-a.png") === 2 && kept === A.sha256,
		JSON.stringify({ state: fixed.state, from: fixed.last?.from, requests: request_count("/__test__/kept-a.png"), kept }));
};

const slot_checks = async () => {
	write_goal("slot-a.png", A);
	write_goal("slot-b.png", B);
	const first = config("GOAL-SLOTS", slot_data(400, 300, site("slot-a.png"), A.sha256));
	await play(first);
	await wait_state(["ready", "failed", "canceled"]);
	const a = { state: (await status()).state, drawn: await goal_digest() };
	await evaluate((cfg) => { __ap.use(cfg); __ap.drop(); }, config("GOAL-SLOTS", slot_data(400, 300, site("slot-b.png"), B.sha256), { slot: 2 }));
	await sleep(300);
	await connect();
	await wait_state(["ready", "failed", "canceled"]);
	const b = { state: (await status()).state, drawn: await goal_digest(), key: (await status()).key };
	await paint_with(B);
	await sleep(300);
	const sent = await checks_sent();
	check("a login into another slot with another goal draws that goal in place of the first, and scores the canvas against it",
		a.drawn === A.digest && b.state === "ready" && b.drawn === B.digest && /"GOAL-SLOTS",0,2/.test(b.key) && sent.ids === 8018 && sent.goal, JSON.stringify({ a, b, sent }));
	// A third slot with the second's goal: its own game, so the goal canvas starts over and the goal loads again.
	const loads = (await status()).counts.loads;
	await evaluate((cfg) => { __ap.use(cfg); __ap.drop(); }, config("GOAL-SLOTS", slot_data(400, 300, site("slot-b.png"), B.sha256), { slot: 3 }));
	await sleep(300);
	await connect();
	await wait_state(["ready", "failed", "canceled"]);
	const c = await status();
	check("...and a login into a third slot with the same goal file loads it again for that slot and draws it", c.state === "ready" && c.counts.loads === loads + 1 && /"GOAL-SLOTS",0,3/.test(c.key) && (await goal_digest()) === B.digest,
		JSON.stringify({ state: c.state, loads: [loads, c.counts.loads], key: c.key }));
};

const tabs_checks = async () => {
	write_goal("tab-a.png", A);
	write_goal("tab-c.png", C);
	await play(config("GOAL-TABS", slot_data(400, 300, site("tab-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const tab = await new_tab();
	await tab.add_init_script(PAGE);
	await tab.add_init_script(fake_server(config("GOAL-TABS", slot_data(300, 200, site("tab-c.png"), C.sha256), { slot: 2 })));
	const in_tab = (fn, ...args) => tab.evaluate(fn, ...args);
	const tab_wait = async (holds, ms = 20000) => {
		for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) if (await in_tab(holds).catch(() => false)) return true;
		return false;
	};
	const tab_login = async () => {
		await tab_wait(() => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy && window.paint_hard_session?.ready === true);
		await in_tab(() => { $("[name=aphost]").val("fake.test"); $("[name=apport]").val("38281"); $("[name=apslot]").val("Painter"); $("button").filter((i, b) => b.textContent === "Connect!").trigger("click"); });
		await tab_wait(() => ["ready", "failed", "canceled"].includes(window.paint_hard_goal?.status().state));
	};
	try {
		await tab.open();
		await tab_login();
		const second = await in_tab(() => ({ state: window.paint_hard_goal.status().state, drawn: __t.digest(goal_ctx.getImageData(0, 0, goal_canvas.width, goal_canvas.height).data), size: `${goal_canvas.width}x${goal_canvas.height}` }));
		const first = { state: (await status()).state, drawn: await goal_digest() };
		check("two tabs on two slots with two goals each draw their own", first.drawn === A.digest && second.state === "ready" && second.drawn === C.digest && second.size === "300x200", JSON.stringify({ first, second }));
		const id = await in_tab(() => window.paint_hard_session?.id);
		await tab_wait(async () => !!(await __t.read("sessions", window.paint_hard_session.id))?.goal, 10000);
		// The second tab opens its session again, from a page of another document.
		await tab.open("about:blank");
		await tab.open(`${ORIGIN}/#local:${id}`);
		await tab_login();
		const again = await in_tab(() => ({ state: window.paint_hard_goal.status().state, from: window.paint_hard_goal.status().last?.from, drawn: __t.digest(goal_ctx.getImageData(0, 0, goal_canvas.width, goal_canvas.height).data) }));
		await paint_with(A);
		await sleep(300);
		const sent = await checks_sent();
		check("...and keep them: the second, opened again, reads its own from the goals store, and the first still scores against its own",
			again.state === "ready" && again.from === "store" && again.drawn === C.digest && (await goal_digest()) === A.digest && sent.ids === 8018, JSON.stringify({ again, first: await goal_digest(), sent }));
	} finally {
		await close_tab(tab).catch(() => { });
	}
};

const old_checks = async () => {
	const bundled = decodePNG("images/archipelago/800x600.png");
	await play(config("GOAL-OLD", { ...slot_data(800, 600), version: "1.1.0", goal_image: undefined, goal_image_sha256: undefined }));
	await wait_for("the bundled goal", () => goal_ctx.getImageData(799, 599, 1, 1).data[3] === 255);
	await sleep(300);
	const s = await status(), drawn = await goal_digest();
	check("a seed before 1.2.0 keeps the bundled goal of its size, unlocked, with nothing held", !s.locked && s.ready && s.state === "none" && drawn === digest(bundled.rgba), JSON.stringify({ state: s.state, locked: s.locked, drawn, want: digest(bundled.rgba) }));
	write_goal("open-b.png", B);
	await evaluate(async () => {
		const blob = await (await fetch("/__test__/open-b.png")).blob();
		(await import("/src/functions.js")).open_from_file(new File([blob], "open-b.png", { type: "image/png" }));
	});
	await sleep(1000);
	const after = await goal_digest(), shown = await evaluate(() => __shown());
	check("...and File > Open Goal Image still puts a file in as its goal", after !== drawn && shown.length === 0, JSON.stringify({ before: drawn, after, shown }));
};

const default_checks = async () => {
	const bundled = decodePNG("images/archipelago/800x600.png");
	await play(config("GOAL-DEFAULT", slot_data(800, 600)));
	await wait_state(["ready", "failed", "canceled"]);
	const s = await status(), drawn = await goal_digest();
	check("a 1.2.0 seed's default goal is the bundled image of its size, loaded and locked as a named one is",
		s.state === "ready" && s.locked && s.reference === "images/archipelago/800x600.png" && drawn === digest(bundled.rgba), JSON.stringify({ state: s.state, reference: s.reference, drawn, want: digest(bundled.rgba), failure: s.failure }));
	write_goal("default-b.png", B);
	await evaluate(async () => {
		const blob = await (await fetch("/__test__/default-b.png")).blob();
		(await import("/src/functions.js")).open_from_file(new File([blob], "default-b.png", { type: "image/png" }));
	});
	await sleep(800);
	const shown = await evaluate(() => __shown());
	check("...so File > Open Goal Image puts no other file in its place, and says the goal comes from the YAML", (await goal_digest()) === drawn && shown.length === 1 && /goal comes from its YAML/.test(shown[0]) && /names no SHA-256/.test(shown[0]), JSON.stringify(shown));
};

const swap_checks = async () => {
	write_goal("swap-a.png", A);
	write_goal("swap-b.png", B);
	await play(config("GOAL-SWAP", slot_data(400, 300, site("swap-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const start = await goal_digest();
	const open_file = (name) => evaluate(async (name) => {
		const blob = await (await fetch(`/__test__/${name}`)).blob();
		(await import("/src/functions.js")).open_from_file(new File([blob], name, { type: "image/png" }));
	}, name);
	await open_file("swap-b.png");
	await sleep(800);
	const refused = { drawn: await goal_digest(), shown: await evaluate(() => __shown()) };
	check("with a 1.2.0 seed loaded, File > Open Goal Image refuses a file whose SHA-256 isn't the seed's, and says the goal comes from the YAML",
		start === A.digest && refused.drawn === A.digest && refused.shown.length === 1 && /goal comes from its YAML/.test(refused.shown[0]) && /swap-b\.png's isn't/.test(refused.shown[0]), JSON.stringify(refused));
	await evaluate(() => { for (const w of document.querySelectorAll(".window")) if (w.offsetParent !== null && !/Archipelago Connection Options/.test(w.textContent)) w.querySelector(".window-close-button")?.click(); });
	await sleep(200);
	const downloads = (await status()).counts.downloads;
	await open_file("swap-a.png");
	await wait_state(["ready", "failed"]);
	await sleep(300);
	const taken = await status();
	check("...and takes a file whose SHA-256 is the seed's in place of the download", taken.state === "ready" && taken.last?.from === "file" && taken.counts.downloads === downloads && (await goal_digest()) === A.digest && (await evaluate(() => __shown())).length === 0,
		JSON.stringify({ state: taken.state, from: taken.last?.from, downloads: [downloads, taken.counts.downloads], shown: await evaluate(() => __shown()) }));
	// A session of this game whose record holds another goal, B, planted behind Paint's back as a goal of a session from
	// before 7.8 would be stored: a PNG under its own SHA-256, with no address. Its address opens it in this tab.
	await wait_for("the session's record", () => (async () => !!(await __t.read("sessions", window.paint_hard_session.id)))(), 10000);
	const planted = await evaluate(async () => {
		const record = await __t.read("sessions", window.paint_hard_session.id);
		const blob = await (await fetch("/__test__/swap-b.png")).blob();
		const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
		const db = await __t.db();
		await new Promise((resolve, reject) => {
			const transaction = db.transaction(["sessions", "goals"], "readwrite");
			transaction.objectStore("goals").put({ sha256, blob, width: 400, height: 300, used_at: Date.now() });
			transaction.objectStore("sessions").put({ ...record, id: "swap-planted", goal: sha256, saved_at: Date.now() });
			transaction.oncomplete = resolve;
			transaction.onabort = () => reject(transaction.error);
		});
		db.close();
		return sha256;
	});
	await evaluate(() => { location.hash = "local:swap-planted"; });
	await wait_for("the restore of the planted session", () => window.paint_hard_session?.id === "swap-planted" && window.paint_hard_session?.ready === true);
	await sleep(1000);
	const restored = { id: await evaluate(() => window.paint_hard_session.id), outcome: await evaluate(() => window.paint_hard_session.outcome), drawn: await goal_digest(), src: await evaluate(() => $goal_image.attr("src") ?? null), field: await similarity_field() };
	check("...a session of the game restored while the seed is loaded leaves the seed's goal as it is, and loads its own stored goal nowhere",
		!!planted && restored.id === "swap-planted" && restored.outcome === "restored" && restored.drawn === A.digest && restored.src === null && /%\//.test(restored.field), JSON.stringify(restored));
	// A stroke asks for the next save.
	await evaluate((sha256) => { window.__planted_goal = sha256; }, planted);
	await paint_with(A);
	const repointed = await wait_for("the planted record's goal", () => (async () => {
		const stored = await __t.read("sessions", "swap-planted");
		return stored && stored.goal !== window.__planted_goal ? stored.goal : null;
	})(), 10000);
	check("...and its record takes the seed's goal at its next save", repointed === A.sha256, JSON.stringify({ repointed, planted }));
	await evaluate(() => { $goal_image.attr("src", "/__test__/swap-b.png"); });
	await sleep(800);
	check("...and an image the goal image loads meanwhile draws nothing", (await goal_digest()) === A.digest, "");
};

const decoders_checks = async () => {
	const big = goal_png(4096, 4096, (x, y) => [(x >> 4) & 255, (y >> 4) & 255, ((x + y) >> 5) & 255]);
	write_goal("big.png", big);
	const results = {};
	for (const decoder of ["upng", "bitmap"]) {
		await play(config(`GOAL-BIG-${decoder}`, slot_data(4096, 4096, site("big.png"), big.sha256)), `window.paint_hard_goal_decoder = "${decoder}"`);
		await wait_state(["ready", "failed", "canceled"], 60000);
		const s = await status();
		results[decoder] = { state: s.state, decoder: s.last?.decoder, times: s.last?.times, drawn: await goal_digest(), failure: s.failure };
	}
	check("at 4096x4096 UPNG and createImageBitmap draw the same goal, pixel for pixel, as the file holds",
		results.upng.state === "ready" && results.bitmap.state === "ready" && results.upng.decoder === "upng" && results.bitmap.decoder === "bitmap" && results.upng.drawn === big.digest && results.bitmap.drawn === big.digest,
		JSON.stringify({ ...results, want: big.digest }));
	// A goal with transparency, down to 0, at both decoders: shown over white.
	const see_through = goal_png(64, 48, (x, y) => [(x * 37) & 255, (y * 53) & 255, (x * y) & 255, x < 8 ? 255 : (x * 4 + y) & 255], true);
	write_goal("alpha.png", see_through);
	const flat = {};
	for (const decoder of ["upng", "bitmap"]) {
		await play(config(`GOAL-ALPHA-${decoder}`, slot_data(64, 48, site("alpha.png"), see_through.sha256)), `window.paint_hard_goal_decoder = "${decoder}"`);
		await wait_state(["ready", "failed", "canceled"]);
		const pixels = await evaluate(() => Array.from(goal_ctx.getImageData(0, 0, 64, 48).data));
		let worst = 0, opaque = true;
		for (let i = 0; i < pixels.length; i++) {
			if (i % 4 === 3) opaque &&= pixels[i] === 255;
			else worst = Math.max(worst, Math.abs(pixels[i] - see_through.expected[i]));
		}
		flat[decoder] = { state: (await status()).state, worst, opaque };
	}
	check("a goal with transparency is flattened onto white: exactly with UPNG, and within 1 a channel with createImageBitmap, opaque either way",
		flat.upng.state === "ready" && flat.upng.worst === 0 && flat.upng.opaque && flat.bitmap.state === "ready" && flat.bitmap.worst <= 1 && flat.bitmap.opaque, JSON.stringify(flat));
	// The page's own pick: createImageBitmap for an 8-bit file with no transparency past 16,000,000 pixels, UPNG for one
	// with transparency there, and UPNG under that size.
	const big_alpha = goal_png(4096, 4096, (x, y) => [(x >> 4) & 255, (y >> 4) & 255, ((x + y) >> 5) & 255, x < 2048 ? 255 : 128 + ((y >> 6) & 127)], true);
	write_goal("big-alpha.png", big_alpha);
	const picked = {};
	for (const [name, goal, width, height] of [["big.png", big, 4096, 4096], ["big-alpha.png", big_alpha, 4096, 4096], ["alpha.png", see_through, 64, 48]]) {
		await play(config(`GOAL-PICK-${name}`, slot_data(width, height, site(name), goal.sha256)), "", { keep: true });
		await wait_state(["ready", "failed", "canceled"], 60000);
		const s = await status();
		picked[name] = { state: s.state, decoder: s.last?.decoder, matches: (await goal_digest()) === goal.digest };
	}
	check("the page decodes an 8-bit 4096x4096 goal with no transparency with createImageBitmap, and one with transparency, or one under 16,000,000 pixels, with UPNG, each to the file's own pixels",
		picked["big.png"].decoder === "bitmap" && picked["big-alpha.png"].decoder === "upng" && picked["alpha.png"].decoder === "upng" && Object.values(picked).every((p) => p.state === "ready" && p.matches), JSON.stringify(picked));
};

const paste_checks = async () => {
	write_goal("paste-a.png", A);
	await play(config("GOAL-PASTE", slot_data(400, 300, site("paste-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	await evaluate(async () => {
		const blob = await (await fetch("/__test__/paste-a.png")).blob();
		window.__reads = 0;
		navigator.clipboard.read = async () => { window.__reads++; return [{ types: ["image/png"], getType: async () => blob }]; };
		navigator.clipboard.readText = async () => { window.__reads++; return ""; };
	});
	const before = { ...(await checks_sent()), canvas: await evaluate(() => __t.digest(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data)) };
	await evaluate(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Insert", code: "Insert", shiftKey: true, bubbles: true, cancelable: true })); });
	await sleep(800);
	const after = { ...(await checks_sent()), canvas: await evaluate(() => __t.digest(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data)), reads: await evaluate(() => window.__reads), selection: await evaluate(() => typeof selection !== "undefined" && !!selection), shown: await evaluate(() => __shown()) };
	check("Shift+Insert pastes nothing: it reads no clipboard, opens no box, and leaves the canvas and the checks as they were",
		after.reads === 0 && !after.selection && after.shown.length === 0 && after.canvas === before.canvas && after.ids === before.ids, JSON.stringify({ before, after }));
};

const attributes_checks = async () => {
	await play(config("GOAL-ATTRIBUTES", { ...slot_data(800, 600), version: "1.1.0", start_width: 400, start_height: 300, goal_image: undefined, goal_image_sha256: undefined }));
	await wait_for("the bundled goal", () => goal_ctx.getImageData(799, 599, 1, 1).data[3] === 255);
	await evaluate(async () => (await import("/src/functions.js")).image_attributes());
	await sleep(300);
	await evaluate(() => __press(".attributes-window", "Default"));
	const fields = await evaluate(() => [...document.querySelectorAll(".attributes-window input[type=number]")].map((input) => input.value));
	await evaluate(() => __press(".attributes-window", "OK"));
	await sleep(300);
	const size = await evaluate(() => `${main_canvas.width}x${main_canvas.height}`);
	check("Image > Attributes > Default gives the size the items unlock, so OK leaves the canvas at it", fields.join("x") === "400x300" && size === "400x300", JSON.stringify({ fields, size }));
};

// --- From the repair of S7 ---

// Close, then the status bar's field: a goal the server answers 404 for, its window closed, and a click on the field.
const closed_checks = async () => {
	await play(config("GOAL-CLOSED", slot_data(400, 300, site("closed-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	const failed = { state: (await status()).state, window: await evaluate(() => __goal_window()), field: await similarity_field(), tip: await evaluate(() => $status_similarity.attr("title") ?? null) };
	const pressed = await evaluate(() => __press(".goal-image-window", "Close"));
	await sleep(300);
	const gone = await evaluate(() => __goal_window());
	await evaluate(() => $status_similarity[0].click());
	await sleep(300);
	const again = await evaluate(() => __goal_window());
	check("after Close on a failed goal's window, a click on the status bar's No goal shows the window again, with its Retry",
		failed.state === "failed" && failed.field === "No goal" && failed.tip === "Click to show the Goal Image window." && pressed && gone === null && /couldn't download the goal image/.test(again ?? "") && /Retry/.test(again ?? ""),
		JSON.stringify({ failed, pressed, gone, again }));
	write_goal("closed-a.png", A);
	await evaluate(() => __press(".goal-image-window", "Retry"));
	await wait_state(["ready", "failed"]);
	await sleep(400);
	const drawn = { state: (await status()).state, drawn: await goal_digest(), window: await evaluate(() => __goal_window()), field: await similarity_field(), tip: await evaluate(() => $status_similarity.attr("title") ?? null) };
	await evaluate(() => $status_similarity[0].click());
	await sleep(300);
	const after = await evaluate(() => __goal_window());
	check("...whose Retry draws the goal; then the field shows the score, without the tip, and a click on it opens nothing",
		drawn.state === "ready" && drawn.drawn === A.digest && drawn.window === null && /%\//.test(drawn.field) && drawn.tip === null && after === null, JSON.stringify({ ...drawn, after }));
};

// The connection drops while the goal downloads: the goal is drawn while it is down, and the stroke held for it sends at
// the next stroke after the reconnect.
const drop_checks = async () => {
	write_goal("drop-a.png", A);
	await play(config("GOAL-DROP", slot_data(400, 300, site("drop-a.png?delay=4000"), A.sha256)));
	const at_login = await status();
	await paint_with(A);
	await sleep(300);
	await evaluate(() => __ap.drop());
	await sleep(400);
	const down = await window_shown();
	await wait_state(["ready", "failed", "canceled"], 15000);
	await sleep(500);
	const s = await status(), drawn = await goal_digest(), sent = await checks_sent(), shown = await evaluate(() => __shown());
	check("a goal that comes in after the connection dropped is drawn, and ready, with no message, and the stroke held for it sends nothing while the connection is down",
		at_login.state === "loading" && down && s.state === "ready" && drawn === A.digest && shown.length === 0 && sent.packets === 0,
		JSON.stringify({ at_login: at_login.state, down, state: s.state, failure: s.failure, drawn: drawn === A.digest, shown, sent }));
	await connect();
	await sleep(1000);
	const after = await status();
	await paint_with(A);
	await sleep(500);
	const later = await checks_sent();
	check("...the reconnect leaves the drawn goal alone, and the next stroke sends the checks, all of them once, and the goal",
		after.state === "ready" && after.counts.loads === s.counts.loads && request_count("/__test__/drop-a.png") === 1 && later.packets === 1 && later.ids === 8018 && later.goal,
		JSON.stringify({ state: after.state, loads: [s.counts.loads, after.counts.loads], requests: request_count("/__test__/drop-a.png"), later }));
};

// A store with no room for the goal's file, which D18 says means no cache, never an error. Chrome and Edge take a quota
// for an origin before its first write (override_quota()), so this runs at the second origin, where no page wrote
// before. Firefox takes its quota for a whole run, from PAIN_T_FIREFOX_PREFS, which would refuse the other sections'
// saves: there this section runs alone. Every put into the goals store is counted, refused or not.
const COUNT_GOAL_PUTS = `(() => {
	window.__goal_puts = [];
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (value, ...rest) {
		if (this.name === "goals") window.__goal_puts.push(value?.sha256 ?? null);
		return put.call(this, value, ...rest);
	};
})();`;
const full_checks = async () => {
	const quota_pref = /dom\.quotaManager\.temporaryStorage\.fixedLimit/.test(process.env.PAIN_T_FIREFOX_PREFS ?? "");
	if (!chromium && !quota_pref) {
		console.log('SKIP  full: a store with no room for the goal\'s file, in Firefox  (Firefox takes its quota for a whole run: run this section alone with PAIN_T_ONLY=full and PAIN_T_FIREFOX_PREFS={"dom.quotaManager.temporaryStorage.fixedLimit":51200})');
		return;
	}
	const N = goal_png(2000, 2000, noise(7));
	write_goal("full-n.png", N);
	const counted = await add_init_script(COUNT_GOAL_PUTS);
	section_scripts.add(counted);
	if (chromium) await override_quota(8000000, SECOND_ORIGIN);
	try {
		const data = slot_data(2000, 2000, site("full-n.png"), N.sha256, { start_width: 100, start_height: 100 });
		await serve(config("GOAL-FULL", data));
		await go_to(`${SECOND_ORIGIN}/`);
		await connect();
		await wait_state(["ready", "failed", "canceled"], 60000);
		await sleep(1000);
		const s = await status(), drawn = await goal_digest(), id = await session_id();
		await fill_stroke(0, 0, 50, 50, "#123456");
		await sleep(1500);
		const last = await fill_stroke(0, 0, 80, 80, "#654321");
		const record = await wait_for("the record of the second stroke", (id, area) => (async () => {
			const stored = await __t.record(id, [0, 0, 80, 80]);
			return stored?.area === area ? stored : null;
		})(), 10000, id, last);
		const first = { shown: await evaluate(() => __shown()), goals: await evaluate(async () => ((await __t.read("goals")) ?? []).map((goal) => goal.sha256)), puts: await evaluate(() => [...window.__goal_puts]) };
		check(`with a store that has no room for the goal's file${chromium ? " (8 MB by override_quota(), the file 12 MB)" : " (Firefox's quota from PAIN_T_FIREFOX_PREFS)"}, the goal still draws and the page says nothing about the store`,
			s.state === "ready" && drawn === N.digest && first.shown.length === 0, JSON.stringify({ state: s.state, failure: s.failure, bytes: N.bytes.length, shown: first.shown.map((text) => text.slice(0, 160)) }));
		check("...each save of the session's canvas still lands, its record referring to the goal by its SHA-256, and the store keeps no copy of the file",
			record?.area === last && record.goal_sha === N.sha256 && !first.goals.includes(N.sha256) && first.puts.filter((sha256) => sha256 === N.sha256).length === 1,
			JSON.stringify({ record: record && { area: record.area, goal: record.goal_sha }, want: last, goals: first.goals, puts: first.puts }));
		// Another slot of the seed with the same goal, in the same tab: its own game, so the goal is downloaded and drawn
		// again, and its session saves. The file the store refused isn't offered to it again.
		await another_game(config("GOAL-FULL", data, { slot: 2 }));
		await wait_state(["ready", "failed", "canceled"], 60000);
		await sleep(1000);
		const second = { state: (await status()).state, key: (await status()).key, id: await session_id() };
		const painted = await fill_stroke(0, 0, 40, 40, "#204060");
		const record2 = await wait_for("the second slot's record", (id, area) => (async () => {
			const stored = await __t.record(id, [0, 0, 40, 40]);
			return stored?.area === area ? stored : null;
		})(), 10000, second.id, painted);
		await sleep(500);
		const end = { shown: await evaluate(() => __shown().filter((text) => !/logged into another game/.test(text))), puts: await evaluate(() => [...window.__goal_puts]) };
		check("...and a login into another slot with the same goal draws it again and saves that slot's canvas, with no message, and the store isn't offered the file it refused again",
			second.state === "ready" && /"GOAL-FULL",0,2/.test(second.key ?? "") && second.id !== id && record2?.area === painted && record2.goal_sha === N.sha256 && end.shown.length === 0 && end.puts.filter((sha256) => sha256 === N.sha256).length === 1,
			JSON.stringify({ second, record2: record2 && { area: record2.area, goal: record2.goal_sha }, want: painted, shown: end.shown.map((text) => text.slice(0, 160)), puts: end.puts }));
	} finally {
		if (chromium) await override_quota(undefined, SECOND_ORIGIN).catch(() => { });
	}
};

// Old and new seeds in one tab: a 1.1.0 seed, then a 1.2.0 seed with its own goal, then a 1.1.0 seed of another size.
const seeds_checks = async () => {
	const b600 = decodePNG("images/archipelago/800x600.png"), b800 = decodePNG("images/archipelago/800x800.png");
	write_goal("seeds-a.png", A);
	await play(config("GOAL-SEEDS-1", old_data(800, 600)));
	await wait_for("the bundled 800x600 goal", () => goal_ctx.getImageData(799, 599, 1, 1).data[3] === 255);
	await sleep(400);
	const one = { drawn: await goal_digest(), locked: (await status()).locked };
	await another_game(config("GOAL-SEEDS-2", slot_data(400, 300, site("seeds-a.png"), A.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	await sleep(400);
	const two = { state: (await status()).state, locked: (await status()).locked, drawn: await goal_digest() };
	await another_game(config("GOAL-SEEDS-3", old_data(800, 800)));
	await wait_for("the bundled 800x800 goal", () => goal_canvas.width === 800 && goal_canvas.height === 800 && goal_ctx.getImageData(799, 799, 1, 1).data[3] === 255, 10000);
	await sleep(600);
	const s = await status();
	const three = { size: await evaluate(() => `${goal_canvas.width}x${goal_canvas.height}`), drawn: await goal_digest(), locked: s.locked, state: s.state, field: await similarity_field() };
	check("in one tab, a 1.1.0 seed, then a 1.2.0 seed with its own goal, then a 1.1.0 seed of another size each draw their own goal, and only the 1.2.0 seed's is locked",
		one.drawn === digest(b600.rgba) && !one.locked && two.state === "ready" && two.locked && two.drawn === A.digest && three.size === "800x800" && three.drawn === digest(b800.rgba) && !three.locked && three.state === "none" && /%\//.test(three.field),
		JSON.stringify({ one, two, three, want: [digest(b600.rgba), A.digest, digest(b800.rgba)] }));
};

// What the page says once canvas reads are allowed after a block, and how many of the windows showing say a text.
const RELOAD_TO_SEND = "Now that canvas reads are allowed, reload this tab to send checks and save.";
const windows_saying = (text) => evaluate((text) => __shown().filter((shown) => shown.includes(text)).length, text);
// Canvas reads as Firefox's resistFingerprinting answers them, from the page's load: getImageData gives random bytes,
// and a read of one pixel an alpha of 0, as 1 random read in 256 has it. The test's own reads (window.__test_reading)
// come back as drawn, and so does every read once sessionStorage says the player allowed them.
const RANDOM_READS = `(() => {
	const get = CanvasRenderingContext2D.prototype.getImageData;
	const allowed = () => { try { return sessionStorage.getItem("goal-reads") === "allowed"; } catch { return true; } };
	CanvasRenderingContext2D.prototype.getImageData = function (...args) {
		const image = get.apply(this, args);
		if (window.__test_reading || allowed()) return image;
		const data = image.data;
		for (let at = 0; at < data.length; at += 65536) crypto.getRandomValues(data.subarray(at, Math.min(data.length, at + 65536)));
		if (data.length === 4) data[3] = 0;
		return image;
	};
})();`;
const reads_checks = async () => {
	write_goal("reads-a.png", A);
	const random = await add_init_script(RANDOM_READS);
	section_scripts.add(random);
	try {
		await play(config("GOAL-READS", slot_data(400, 300, site("reads-a.png"), A.sha256)));
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const s = await status(), noise_found = await evaluate(() => window.paint_hard_auto_copy.read_noise()), drawn = await goal_digest_as_drawn();
		check("with canvas reads blocked and random, as Firefox's resistFingerprinting gives them, the seed's goal still loads and draws",
			s.state === "ready" && noise_found === "blocked" && drawn === A.digest, JSON.stringify({ state: s.state, failure: s.failure, noise: noise_found, drawn: drawn === A.digest }));
		await fill_stroke(0, 0, 20, 20, "#808080");
		await paint_with(A);
		await sleep(600);
		const held = { sent: await checks_sent(), said: await evaluate(() => __shown().filter((text) => /then reload this tab\. Paint sends no checks until then\./.test(text)).length) };
		check("...strokes send no check while the reads are blocked, where a score of the random reads sends thousands, and the page says so once",
			held.sent.packets === 0 && !held.sent.goal && held.said === 1, JSON.stringify(held));
		// The player allows the reads, with no reload, and paints the goal's own pixels again. The page can't tell whether
		// its canvas holds what the blocked reads drew back onto it, as an undo does, so nothing goes out until a reload,
		// though this canvas is the goal's own pixels. The goal is read again, and the status bar shows the canvas's score
		// against it.
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await sleep(600);
		const by_itself = await checks_sent();
		await paint_with(A);
		await sleep(800);
		const sent = await checks_sent(), field = await similarity_field(), told = await windows_saying(RELOAD_TO_SEND);
		check("...and once the reads are allowed with no reload, nothing goes out though the canvas is the goal's own pixels, the status bar shows its score against the goal read again, 100%, and the page says once to reload this tab to send checks and save",
			by_itself.packets === 0 && sent.packets === 0 && !sent.goal && field.startsWith("100.0000%/") && told === 1, JSON.stringify({ by_itself, sent, field, told }));
		// A session with a stored canvas, loaded with the reads blocked. The goal is white and the canvas gray, 127 a
		// channel, which scores just below 0 against it, where a score against a random read of the goal gives thousands
		// of checks. Once the reads are allowed, the first stroke is scored before its send finds them clean, against the
		// goal as read while they were blocked: the hold until a reload keeps that score from going out.
		const W = goal_png(400, 300, () => [255, 255, 255]);
		write_goal("reads-w.png", W);
		await play(config("GOAL-READS-2", slot_data(400, 300, site("reads-w.png"), W.sha256)));
		await wait_state(["ready", "failed", "canceled"]);
		const id = await session_id();
		const gray = await fill_stroke(0, 0, 400, 300, "#7f7f7f");
		await wait_for("the stored canvas", (id, area) => (async () => (await __t.record(id, [0, 0, 400, 300]))?.area === area)(), 10000, id, gray);
		await evaluate(() => sessionStorage.setItem("goal-reads", "blocked"));
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		await fill_stroke(0, 0, 20, 20, "#7f7f7f");
		await sleep(500);
		const blocked = { state: (await status()).state, id: await session_id(), outcome: await evaluate(() => window.paint_hard_session.outcome), sent: await checks_sent(), said: await evaluate(() => __shown().filter((text) => /then reload this tab to go on from that save\. Paint sends no checks until then\./.test(text)).length) };
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await sleep(1000);
		const quiet = await checks_sent();
		await fill_stroke(20, 0, 20, 20, "#7f7f7f");
		await sleep(800);
		const after = { sent: await checks_sent(), field: await similarity_field(), score: await evaluate(async () => (await import("/src/functions.js")).calculate_similarity()) };
		check("...and a session whose record holds a canvas, restored with the reads blocked, sends nothing at a stroke once they are allowed with no reload, where a score against the goal as read while they were blocked sends thousands",
			blocked.state === "ready" && blocked.id === id && blocked.outcome === "restored" && blocked.sent.packets === 0 && blocked.said === 1 && quiet.packets === 0 && after.score < 0 && after.sent.packets === 0,
			JSON.stringify({ blocked, quiet, after }));
	} finally {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
	}
};

// RC1: once canvas reads were blocked, a page that has drawn what they gave back onto its canvas keeps it once they are
// allowed. A mid-gray goal, 300x200: a white canvas scores 0.39% against it, and each 20x20 stroke of its gray 0.67%
// more, 123 checks for one stroke and 190 for two, where a canvas of the random reads scores about 37%.
const GRAY = goal_png(300, 200, () => [128, 128, 128]);
// The canvas as the test reads it, past the stand-in: its size, how many pixels are the goal's gray, how many are
// neither gray nor white, which the random reads drew back, and its digest.
const canvas_seen = () => evaluate(() => {
	window.__test_reading = true;
	try {
		const data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
		let gray = 0, other = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] === 128 && data[i + 1] === 128 && data[i + 2] === 128) gray++;
			else if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) other++;
		}
		return { size: `${main_canvas.width}x${main_canvas.height}`, gray, other, digest: __t.digest(data) };
	} finally {
		window.__test_reading = false;
	}
});
// What this page stored or began to store: the writes to the session's record, the PNG encodes of the canvas, and the
// record as it is now.
const stored_since_load = (id) => evaluate(async (id) => ({ writes: __t.writes.filter((key) => key === "sessions:" + id || key === "image#" + id).length, encodes: __t.encodes.length, record: (await __t.record(id))?.raw ?? null }), id);
const read_noise = () => evaluate(() => window.paint_hard_auto_copy.read_noise());

// A session whose record holds a canvas, stored with the reads clean, then restored with them random: the restore draws
// the stored canvas, and the undo step it leaves is a read of it, random. A stroke, then Undo, which puts that read on
// the canvas. Once the player allows the reads with no reload, strokes send and store nothing, and after the reload the
// stored canvas comes back and sends what it earns.
const allowed_checks = async () => {
	write_goal("allowed-gray.png", GRAY);
	section_scripts.add(await add_init_script(RANDOM_READS));
	try {
		// A page of the site first: its sessionStorage, which the tab keeps for the site, allows the next page's reads.
		await open_paint(ready, { hide_connection_window: false });
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await play(config("GOAL-ALLOWED", slot_data(300, 200, site("allowed-gray.png"), GRAY.sha256)));
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const id = await session_id();
		await fill_stroke(0, 0, 20, 20, "#808080");
		const painted = await canvas_seen();
		const stored = await wait_for("the stored canvas", (id, digest) => (async () => (await __t.record(id, [0, 0, 300, 200]))?.area === digest)(), 10000, id, painted.digest);
		const kept = (await stored_since_load(id)).record;
		const clean = { noise: await read_noise(), sent: await checks_sent(), gray: painted.gray };
		// Reloaded with the reads random from the page's load.
		await evaluate(() => sessionStorage.setItem("goal-reads", "blocked"));
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const restored = { id: await session_id(), outcome: await evaluate(() => window.paint_hard_session.outcome), noise: await read_noise(), canvas: await canvas_seen() };
		await fill_stroke(20, 0, 20, 20, "#808080");
		await sleep(300);
		await evaluate(async () => (await import("/src/functions.js")).undo());
		await sleep(500);
		const undone = await canvas_seen();
		const held = { sent: await checks_sent(), said: await windows_saying("then reload this tab to go on from that save."), told: await windows_saying(RELOAD_TO_SEND) };
		// The player allows the reads, with no reload, and paints on.
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await fill_stroke(40, 0, 20, 20, "#808080");
		await sleep(600);
		await fill_stroke(60, 0, 20, 20, "#808080");
		await sleep(800);
		const allowed = { noise: await read_noise(), sent: await checks_sent(), ...(await stored_since_load(id)), told: await windows_saying(RELOAD_TO_SEND) };
		check("a session whose record holds a canvas, restored with canvas reads random, where an undo put the random reads on its canvas: once the reads are allowed with no reload, strokes send nothing and store nothing, its record stays as stored, and the page says once to reload this tab to send checks and save",
			!!stored && !!kept && clean.noise === null && clean.sent.ids === 123 && restored.id === id && restored.outcome === "restored" && restored.noise === "blocked" && restored.canvas.other === 0 && undone.other > 50000 &&
			held.sent.packets === 0 && held.said === 1 && held.told === 0 && allowed.noise === null && allowed.sent.packets === 0 && allowed.writes === 0 && allowed.encodes === 0 && allowed.record === kept && allowed.told === 1,
			JSON.stringify({ stored: !!stored, clean, restored: { ...restored, canvas: { gray: restored.canvas.gray, other: restored.canvas.other } }, undone: { gray: undone.gray, other: undone.other }, held, allowed: { ...allowed, record: allowed.record === kept } }));
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const back = { id: await session_id(), outcome: await evaluate(() => window.paint_hard_session.outcome), noise: await read_noise(), canvas: await canvas_seen() };
		await fill_stroke(20, 0, 20, 20, "#808080");
		await sleep(800);
		// The stand-in keeps the slot's checks through a reload, and the library sends only those the server lacks: the
		// first page's 123, to 1.05%, went out then, so this packet holds the 67 from 1.06% to the 1.72% two strokes earn.
		const after = { ...(await checks_sent()), locations: await evaluate(() => __checks().flatMap((p) => p.locations).sort((a, b) => a - b)) };
		check("...and after the reload the stored canvas comes back, with none of the random reads on it, and a stroke sends what it earns: the 67 checks past the first page's, to 1.72%, in one packet",
			back.id === id && back.outcome === "restored" && back.noise === null && back.canvas.digest === painted.digest && back.canvas.other === 0 &&
			after.packets === 1 && after.ids === 67 && after.locations[0] === 2199106 && after.locations.at(-1) === 2199172 && !after.goal,
			JSON.stringify({ back: { ...back, canvas: { gray: back.canvas.gray, other: back.canvas.other, stored: back.canvas.digest === painted.digest } }, after: { packets: after.packets, ids: after.ids, first: after.locations[0], last: after.locations.at(-1), goal: after.goal } }));
	} finally {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
	}
};

// The canvas as the test reads it, past the stand-in: its size, its first pixel, and whether every pixel is that color.
const canvas_colors = () => evaluate(() => {
	window.__test_reading = true;
	try {
		const data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
		let one_color = true;
		for (let i = 4; i < data.length && one_color; i += 4) one_color = data[i] === data[0] && data[i + 1] === data[1] && data[i + 2] === data[2] && data[i + 3] === data[3];
		return { size: `${main_canvas.width}x${main_canvas.height}`, first: [...data.subarray(0, 4)].join(), one_color };
	} finally {
		window.__test_reading = false;
	}
});

// A session with no record, on a page whose canvas reads are random from its load, as the recheck's probe v4noise has
// it. The page starts with its canvas one color: white, or another color where Paint's color box read its background
// color back as random bytes. The login sizes the canvas from the page's own size to the seed's 300x200, which draws
// the canvas it had onto the new one and reads nothing, so the canvas stays that color (VF2). A stroke, then Undo,
// which puts back the step before it, a read of the canvas, random. Once the player allows the reads with no reload,
// strokes send and store nothing, and Export Session writes no file. The reload finds nothing stored, and a stroke
// sends what that canvas earns.
const allowednew_checks = async () => {
	write_goal("allowednew-gray.png", GRAY);
	section_scripts.add(await add_init_script(RANDOM_READS));
	try {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
		// play(), with a look at the page's own canvas before the login.
		await serve(config("GOAL-ALLOWED-NEW", slot_data(300, 200, site("allowednew-gray.png"), GRAY.sha256)));
		await open_paint(ready, { hide_connection_window: false });
		await clear_goals();
		const page_own = await canvas_colors();
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const id = await session_id();
		const sized = { state: (await status()).state, noise: await read_noise(), canvas: await canvas_colors() };
		check("VF2: with canvas reads random from the load, the login sizes the canvas to the seed's 300x200 and keeps the page's own canvas on it, one color, where a resize that read the canvas drew the random bytes back",
			sized.state === "ready" && sized.noise === "blocked" && page_own.size !== "300x200" && page_own.one_color && sized.canvas.size === "300x200" && sized.canvas.one_color && sized.canvas.first === page_own.first,
			JSON.stringify({ page_own, ...sized }));
		await fill_stroke(0, 0, 20, 20, "#808080");
		await sleep(300);
		await evaluate(async () => (await import("/src/functions.js")).undo());
		await sleep(500);
		const undone = await canvas_seen();
		const held = { sent: await checks_sent(), said: await windows_saying("Allow canvas reads for this site, then reload this tab. Paint sends no checks until then."), told: await windows_saying(RELOAD_TO_SEND) };
		// The player allows the reads, with no reload, and paints on.
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await fill_stroke(20, 0, 20, 20, "#808080");
		await sleep(600);
		await fill_stroke(40, 0, 20, 20, "#808080");
		await sleep(800);
		const allowed = { noise: await read_noise(), sent: await checks_sent(), ...(await stored_since_load(id)), told: await windows_saying(RELOAD_TO_SEND) };
		check("a session with no record, where an undo put the canvas reads, random from the load, on its canvas: once the reads are allowed with no reload, strokes send nothing and store nothing, and the page says once to reload this tab to send checks and save",
			undone.size === "300x200" && undone.other > 50000 && held.sent.packets === 0 && held.said === 1 && held.told === 0 &&
			allowed.noise === null && allowed.sent.packets === 0 && allowed.writes === 0 && allowed.encodes === 0 && allowed.record === null && allowed.told === 1,
			JSON.stringify({ undone: { size: undone.size, gray: undone.gray, other: undone.other }, held, allowed }));
		const exported = await evaluate(async () => {
			window.__exported = null;
			systemHooks.showSaveFileDialog = async ({ getBlob }) => { window.__exported = await (await getBlob()).text(); };
			await window.export_local_session();
			return { file: window.__exported !== null, said: __shown().filter((text) => text.includes("Your browser blocked reading the canvas earlier on this page, so Paint can't write this session to a file. Reload this tab, then export again.")).length };
		});
		check("...and Export Session writes no file of that canvas, and says to reload this tab first", !exported.file && exported.said === 1, JSON.stringify(exported));
		await reload_paint(ready, { hide_connection_window: false });
		const reloaded = { id: await session_id(), outcome: await evaluate(() => window.paint_hard_session.outcome), record: (await stored_since_load(id)).record };
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		reloaded.noise = await read_noise();
		reloaded.canvas = await canvas_seen();
		await fill_stroke(0, 0, 20, 20, "#808080");
		await sleep(800);
		const after = await checks_sent();
		check("...and after the reload nothing comes back, as the session has no record, and a stroke sends what that canvas earns: 123 checks, in one packet",
			reloaded.id === id && reloaded.outcome === "nothing stored" && reloaded.record === null && reloaded.noise === null && reloaded.canvas.size === "300x200" && reloaded.canvas.other === 0 && reloaded.canvas.gray === 0 && after.packets === 1 && after.ids === 123 && !after.goal,
			JSON.stringify({ reloaded: { ...reloaded, canvas: { size: reloaded.canvas.size, gray: reloaded.canvas.gray, other: reloaded.canvas.other } }, after }));
	} finally {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
	}
};

// --- The repair of S7's last fix ---
// What auto copy and M say while the reads are blocked, and once they are allowed on a page where they were.
const BLOCKED_COPY = "Your browser blocks reading the canvas, which auto copy and M need. Allow canvas reads for this site.";
const RELOAD_TO_COPY = "Now that canvas reads are allowed, reload this tab to use auto copy and M.";
// Canvas reads as Brave's farbling gives them, from the page's load: every fifth pixel's red reads back 1 off. The
// test's own reads (window.__test_reading) come back as drawn.
const ONE_LEVEL_READS = `(() => {
	const get = CanvasRenderingContext2D.prototype.getImageData;
	CanvasRenderingContext2D.prototype.getImageData = function (...args) {
		const image = get.apply(this, args);
		if (window.__test_reading) return image;
		for (let i = 0; i < image.data.length; i += 20) image.data[i] ^= 1;
		return image;
	};
})();`;
// Reads of Paint's own canvas random while window.__main_random is set, and every other canvas's clean, as a block that
// spares the small canvas the page probes with would give them. The test's own reads come back as drawn.
const MAIN_RANDOM_READS = `(() => {
	const get = CanvasRenderingContext2D.prototype.getImageData;
	CanvasRenderingContext2D.prototype.getImageData = function (...args) {
		const image = get.apply(this, args);
		if (window.__test_reading || !window.__main_random || typeof main_canvas === "undefined" || this.canvas !== main_canvas) return image;
		const data = image.data;
		for (let at = 0; at < data.length; at += 65536) crypto.getRandomValues(data.subarray(at, Math.min(data.length, at + 65536)));
		return image;
	};
})();`;
// Items for auto copy and M: two Overclock fillers, 6 speed items, 64 pixels a second, and one color depth item a
// channel, so the goal's gray is one of 3 shades and a pixel of random reads is one to paint.
const COPY_ITEMS = ["Overclock", "Overclock", ...Array(6).fill("Progressive Auto Copy Speed"), "Progressive Color Depth (Red)", "Progressive Color Depth (Green)", "Progressive Color Depth (Blue)"];
const undo_now = async () => {
	await evaluate(async () => (await import("/src/functions.js")).undo());
	await sleep(500);
};
const stored_area = (id, digest) => wait_for("the stored canvas", (id, digest) => (async () => (await __t.record(id, [0, 0, 300, 200]))?.area === digest)(), 10000, id, digest);
const panel_start = async () => {
	await evaluate(async () => (await import("/src/auto-copy.js")).show_auto_copy_panel());
	await sleep(200);
	await evaluate(() => [...document.querySelectorAll(".auto-copy-panel button")].find((b) => /^(Start|Resume)$/.test(b.textContent))?.click());
};
const panel_line = () => evaluate(() => document.querySelector(".auto-copy-panel .window-content div")?.textContent ?? null);
// M pressed over the canvas, the pointer first moved off the pixel M copies: Firefox fires no pointer move for a
// pointer put where it already is, as after a reload, and M then has no pixel to copy.
const press_m_moved = async () => {
	const away = await point_on("canvas", 40, 40);
	await mouse.move(away.x, away.y);
	return press_m();
};

// VF1: reads clean from the load, then random with the page open, as taking back Firefox's canvas permission for the
// site, or switching on a blocking extension, makes them. A session whose record holds a canvas: a stroke stored with
// the reads clean, then two strokes and an undo while they are random. Each send and save probes the reads while the
// page counts as clean, so the first stroke after the change finds them blocked. Once they are allowed again with no
// reload, strokes still send and store nothing, and the reload brings back the canvas stored before the block.
const midpage_checks = async () => {
	write_goal("midpage-gray.png", GRAY);
	section_scripts.add(await add_init_script(RANDOM_READS));
	try {
		// A page of the site first: its sessionStorage, which the tab keeps for the site, allows the next page's reads.
		await open_paint(ready, { hide_connection_window: false });
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await play(config("GOAL-MIDPAGE", slot_data(300, 200, site("midpage-gray.png"), GRAY.sha256)));
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const id = await session_id();
		await fill_stroke(0, 0, 20, 20, "#808080");
		const painted = await canvas_seen();
		const stored = await stored_area(id, painted.digest);
		await sleep(300);
		const clean = { noise: await read_noise(), sent: await checks_sent(), ...(await stored_since_load(id)) };
		// The reads turn random with the page open.
		await evaluate(() => sessionStorage.setItem("goal-reads", "blocked"));
		await fill_stroke(20, 0, 20, 20, "#808080");
		await sleep(300);
		await fill_stroke(40, 0, 20, 20, "#808080");
		await sleep(300);
		await undo_now();
		await sleep(1000);
		const mid = { noise: await read_noise(), canvas: await canvas_seen(), sent: await checks_sent(), ...(await stored_since_load(id)), said: await windows_saying("then reload this tab to go on from that save. Paint sends no checks until then.") };
		check("VF1: canvas reads that turn random with the page open, in a session whose record holds a canvas: two strokes and an undo that puts a random read on the canvas send nothing and store nothing, and the page says once that its last save stays until a reload",
			!!stored && clean.noise === null && clean.sent.packets === 1 && clean.sent.ids === 123 && !!clean.record &&
			mid.noise === "blocked" && mid.canvas.other > 50000 && mid.sent.packets === 1 && mid.writes === clean.writes && mid.encodes === clean.encodes && mid.record === clean.record && mid.said === 1,
			JSON.stringify({ stored: !!stored, clean: { ...clean, record: !!clean.record }, mid: { ...mid, canvas: { gray: mid.canvas.gray, other: mid.canvas.other }, record: mid.record === clean.record } }));
		// The player allows the reads again, with no reload, and paints on.
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await fill_stroke(60, 0, 20, 20, "#808080");
		await sleep(600);
		await fill_stroke(80, 0, 20, 20, "#808080");
		await sleep(800);
		const allowed = { noise: await read_noise(), sent: await checks_sent(), ...(await stored_since_load(id)), told: await windows_saying(RELOAD_TO_SEND) };
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const back = { id: await session_id(), outcome: await evaluate(() => window.paint_hard_session.outcome), noise: await read_noise(), canvas: await canvas_seen() };
		await fill_stroke(20, 0, 20, 20, "#808080");
		await sleep(800);
		const after = await checks_sent();
		check("VF1: ...and once the reads are allowed again with no reload, strokes still send and store nothing and the page says once to reload; after the reload the canvas stored before the block comes back, and a stroke sends the 67 checks past the first page's 123, in one packet",
			allowed.noise === null && allowed.sent.packets === 1 && allowed.writes === clean.writes && allowed.record === clean.record && allowed.told === 1 &&
			back.id === id && back.outcome === "restored" && back.noise === null && back.canvas.digest === painted.digest && after.packets === 1 && after.ids === 67 && !after.goal,
			JSON.stringify({ allowed: { ...allowed, record: allowed.record === clean.record }, back: { ...back, canvas: { gray: back.canvas.gray, other: back.canvas.other, stored: back.canvas.digest === painted.digest } }, after }));
	} finally {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
	}
};

// VF4: reads of Paint's own canvas random with the page open, where the probe of the page's own small canvas still
// reads clean, so only the pixel M wrote and read back finds the block. From then on the canvas counts as tainted,
// though every later probe reads clean: M's own step sends nothing, a stroke and an undo put a random read on the
// canvas, and once the reads are clean again a stroke sends and stores nothing.
const readback_checks = async () => {
	write_goal("readback-gray.png", GRAY);
	section_scripts.add(await add_init_script(MAIN_RANDOM_READS));
	await play(config("GOAL-READBACK", slot_data(300, 200, site("readback-gray.png"), GRAY.sha256), { items: COPY_ITEMS }));
	await wait_state(["ready", "failed", "canceled"]);
	await sleep(500);
	const id = await session_id();
	await fill_stroke(0, 0, 20, 20, "#808080");
	const painted = await canvas_seen();
	const stored = await stored_area(id, painted.digest);
	await sleep(300);
	const clean = { noise: await read_noise(), sent: await checks_sent(), ...(await stored_since_load(id)) };
	await evaluate(() => { window.__main_random = true; });
	const m_said = await press_m_moved();
	await sleep(600);
	await fill_stroke(20, 0, 20, 20, "#808080");
	await sleep(300);
	await undo_now();
	const undone = await canvas_seen();
	await evaluate(() => { window.__main_random = false; });
	await fill_stroke(40, 0, 20, 20, "#808080");
	await sleep(1000);
	const after = { noise: await read_noise(), sent: await checks_sent(), ...(await stored_since_load(id)), told: await windows_saying(RELOAD_TO_SEND) };
	check("VF4: reads of Paint's canvas that turn random with the page open while the page's own probe reads clean: once M's pixel reads back wrong, the canvas counts as tainted, and M's step, a stroke, an undo that puts a random read on the canvas and a stroke once the reads are clean again send and store nothing",
		!!stored && clean.noise === null && clean.sent.packets === 1 && /^Copied 10,10 from the goal/.test(m_said ?? "") && undone.other > 50000 &&
		after.sent.packets === clean.sent.packets && after.writes === clean.writes && after.encodes === clean.encodes && after.record === clean.record && after.told === 1,
		JSON.stringify({ stored: !!stored, clean: { ...clean, record: !!clean.record }, m_said, undone: { gray: undone.gray, other: undone.other }, after: { ...after, record: after.record === clean.record } }));
};

// VF5: one-level noise in canvas reads from the page's load, as Brave's farbling gives it. The page counts it as noise
// and goes on: every probe, at the load and at each send and save, reads a step off at most, which holds nothing.
const onelevel_checks = async () => {
	write_goal("onelevel-gray.png", GRAY);
	section_scripts.add(await add_init_script(ONE_LEVEL_READS));
	await play(config("GOAL-ONE-LEVEL", slot_data(300, 200, site("onelevel-gray.png"), GRAY.sha256)));
	await wait_state(["ready", "failed", "canceled"]);
	await sleep(500);
	const id = await session_id();
	const login = await read_noise();
	await fill_stroke(0, 0, 20, 20, "#808080");
	const painted = await canvas_seen();
	const saved = await stored_area(id, painted.digest);
	await sleep(300);
	await fill_stroke(20, 0, 20, 20, "#808080");
	await sleep(600);
	const sent = await checks_sent(), said = { blocked: await windows_saying("blocks reading the canvas"), told: await windows_saying(RELOAD_TO_SEND) };
	// The noise moves the score a little: 200 checks here, where clean reads give 190.
	check("VF5: with one-level noise in canvas reads from the load, as Brave's farbling gives it, the page counts it as noise and goes on: two strokes send their checks, about 200 in two packets, a save lands, and no message about canvas reads shows",
		login === "load" && sent.packets === 2 && sent.ids >= 150 && sent.ids <= 250 && !sent.goal && !!saved && said.blocked === 0 && said.told === 0,
		JSON.stringify({ login, sent, saved: !!saved, said }));
};

// VF3: M and auto copy on a page whose canvas reads were random from its load, once they are allowed with no reload.
// What they painted there would be lost at the reload, so neither starts, and auto copy spends no banked Overclock.
// After the reload M copies again.
const copyheld_checks = async () => {
	write_goal("copyheld-gray.png", GRAY);
	section_scripts.add(await add_init_script(RANDOM_READS));
	try {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
		await play(config("GOAL-COPY-HELD", slot_data(300, 200, site("copyheld-gray.png"), GRAY.sha256), { items: COPY_ITEMS }));
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const blocked = { noise: await read_noise(), m: await press_m_moved() };
		// The player allows the reads, with no reload.
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		const before = { canvas: await canvas_seen(), spent: await evaluate(() => window.spent_stored()), banked: await evaluate(() => window.paint_hard_auto_copy.overclock_banked()) };
		const m_said = await press_m_moved();
		await sleep(400);
		const after_m = await canvas_seen();
		check("VF3: on a page whose canvas reads were blocked, M copies nothing while they are, and once they are allowed with no reload it still copies nothing and says to reload this tab to use auto copy and M",
			blocked.noise === "blocked" && blocked.m === BLOCKED_COPY && m_said === RELOAD_TO_COPY && after_m.digest === before.canvas.digest,
			JSON.stringify({ blocked, m_said, painted: after_m.digest !== before.canvas.digest }));
		await panel_start();
		await sleep(2500);
		const auto = { running: await evaluate(() => window.paint_hard_auto_copy.running()), line: await panel_line() };
		await evaluate(() => [...document.querySelectorAll(".auto-copy-panel button")].find((b) => b.textContent === "Pause")?.click());
		await sleep(1200);
		const after = { canvas: await canvas_seen(), spent: (await evaluate(() => window.spent_stored())) - before.spent, sent: await checks_sent() };
		check("VF3: ...and auto copy doesn't start there: its panel says to reload this tab, nothing is painted or sent, and none of the banked Overclock is spent",
			before.banked > 0 && !auto.running && auto.line === RELOAD_TO_COPY && after.canvas.digest === before.canvas.digest && after.spent === 0 && after.sent.packets === 0,
			JSON.stringify({ banked: before.banked, auto, painted: after.canvas.digest !== before.canvas.digest, spent: after.spent, sent: after.sent }));
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		const reloaded = { noise: await read_noise(), m: await press_m_moved() };
		check("VF3: ...and after the reload M copies again", reloaded.noise === null && /^Copied 10,10 from the goal/.test(reloaded.m ?? ""), JSON.stringify(reloaded));
	} finally {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
	}
};

// A probe at a send, a save or an Export Session can find the reads blocked while M is held or auto copy runs, before
// either reads back a pixel it wrote. The next flush of M, or tick of auto copy, then paints nothing more. Here the
// reads turn random with the page open, and Export Session probes them before that flush or tick.
const guards_checks = async () => {
	write_goal("guards-gray.png", GRAY);
	section_scripts.add(await add_init_script(RANDOM_READS));
	// From here on, the 1x1 puts on the canvas while the page counts the reads as blocked are counted, and Export Session
	// writes no file.
	const count_puts = () => evaluate(() => {
		window.__puts_blocked = 0;
		main_ctx.putImageData = function (image, ...rest) {
			if (image.width === 1 && window.paint_hard_auto_copy.read_noise() === "blocked") window.__puts_blocked++;
			return CanvasRenderingContext2D.prototype.putImageData.call(this, image, ...rest);
		};
		systemHooks.showSaveFileDialog = async () => { };
	});
	// M pressed and held over a row of the canvas, at 64 pixels a second, from pixel `from` to pixel `to`, `ms` apart.
	const m_along = (down, from, to, ms, up) => evaluate(async (down, from, to, ms, up) => {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const rect = main_canvas.getBoundingClientRect(), y = 30;
		const at = (px) => ({ clientX: rect.left + (px + 0.5) * rect.width / main_canvas.width, clientY: rect.top + (y + 0.5) * rect.height / main_canvas.height, bubbles: true });
		if (down) {
			dispatchEvent(new PointerEvent("pointermove", at(from)));
			dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true }));
		}
		for (let px = from; px < to; px++) {
			dispatchEvent(new PointerEvent("pointermove", at(px)));
			if (ms) await wait(ms);
		}
		if (up) dispatchEvent(new KeyboardEvent("keyup", { key: "m", code: "KeyM", bubbles: true }));
	}, down, from, to, ms, up);
	// The reads turn random, and Export Session probes them, in one task.
	const block_and_export = () => evaluate(() => {
		sessionStorage.setItem("goal-reads", "blocked");
		window.export_local_session();
		return window.paint_hard_auto_copy.read_noise();
	});
	try {
		await open_paint(ready, { hide_connection_window: false });
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await play(config("GOAL-GUARDS", slot_data(300, 200, site("guards-gray.png"), GRAY.sha256), { items: COPY_ITEMS }));
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		await m_along(true, 0, 16, 0, false);
		await sleep(300);
		await count_puts();
		const found = await block_and_export(); // before M's next flush
		await m_along(false, 16, 60, 25, true);
		await sleep(800);
		const m = { found, puts: await evaluate(() => window.__puts_blocked), status: await evaluate(() => $status_text.text()) };
		await evaluate(() => { delete main_ctx.putImageData; });
		check("M held when Export Session's probe finds the canvas reads blocked paints nothing more, lets go and says why",
			m.found === "blocked" && m.puts === 0 && m.status === `M stopped: ${BLOCKED_COPY}`, JSON.stringify(m));
		// A clean page again, where auto copy runs.
		await evaluate(() => sessionStorage.setItem("goal-reads", "allowed"));
		await reload_paint(ready, { hide_connection_window: false });
		await connect();
		await wait_state(["ready", "failed", "canceled"]);
		await sleep(500);
		await panel_start();
		await sleep(1500);
		const running = await evaluate(() => window.paint_hard_auto_copy.running());
		await count_puts();
		const auto = { running, found: await block_and_export() }; // before auto copy's next tick
		await sleep(1000);
		Object.assign(auto, { puts: await evaluate(() => window.__puts_blocked), still: await evaluate(() => window.paint_hard_auto_copy.running()), line: await panel_line() });
		await evaluate(() => { delete main_ctx.putImageData; });
		check("...and auto copy running when Export Session's probe finds the reads blocked stops at its next tick, before it paints, and says why",
			auto.running && auto.found === "blocked" && auto.puts === 0 && !auto.still && auto.line === `Stopped: ${BLOCKED_COPY}`, JSON.stringify(auto));
	} finally {
		await evaluate(() => sessionStorage.removeItem("goal-reads")).catch(() => { });
	}
};

try {
	await add_init_script(PAGE);
	await section("site", site_checks);
	await section("https", https_checks);
	await section("hash", hash_checks);
	await section("size", size_checks);
	await section("side", side_checks);
	await section("decode", decode_checks);
	await section("retry", retry_checks);
	await section("closed", closed_checks);
	await section("slow", slow_checks);
	await section("progress", progress_checks);
	await section("reconnect", reconnect_checks);
	await section("drop", drop_checks);
	await section("reload", reload_checks);
	await section("full", full_checks);
	await section("slot", slot_checks);
	await section("tabs", tabs_checks);
	await section("old", old_checks);
	await section("seeds", seeds_checks);
	await section("default", default_checks);
	await section("swap", swap_checks);
	await section("decoders", decoders_checks);
	await section("reads", reads_checks);
	await section("allowed", allowed_checks);
	await section("allowednew", allowednew_checks);
	await section("midpage", midpage_checks);
	await section("readback", readback_checks);
	await section("onelevel", onelevel_checks);
	await section("copyheld", copyheld_checks);
	await section("guards", guards_checks);
	await section("paste", paste_checks);
	await section("attributes", attributes_checks);
	check("no page errors", page_errors.length === 0, page_errors.slice(0, 5).join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	if (left_out.length) console.log(`SKIP  ${left_out.length} of the suite's ${SECTIONS.length} sections: ${left_out.join(", ")}  (PAIN_T_ONLY names ${only.join(", ")})`);
	finish();
}
