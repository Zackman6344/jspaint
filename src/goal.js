// @ts-check
/* global $Window, $status_similarity, goal_canvas, goal_ctx, UPNG */
// The seed's goal (task 7.8 of the fork's ROADMAP.md, D17, D18 and decision 19). From version 1.2.0 a seed's slot data
// names its goal: goal_image is "default", for the bundled image of the goal's size, or an image of the player's own, an
// https URL or a path in the client's own site; goal_image_sha256 is that file's SHA-256, or empty; and final_width and
// final_height are the goal's size. Every such seed locks its goal: the one this module draws is the only goal, and
// File > Open Goal Image, a dropped image and a session's restore can't put another in its place. A file whose SHA-256
// equals the seed's goes in place of the download, the way around a dead link.
// A login loads the goal once for each seed, team, slot, reference, hash and size, so a reconnect leaves the goal canvas
// alone. Until the goal is drawn the goal-ready flag is down: archipelago.js holds the checks and sends once the goal is
// there, auto copy waits, M says why it can't copy, and the status bar says the goal is loading. A goal Paint can't score
// against is refused with one message, naming the file and what is wrong, and a Retry: a side past 4096, a download that
// fails, a hash or a size other than the seed's, or a file that won't decode. Seeds from before 1.2.0 keep the bundled
// image of their size, a restored session's goal and upstream's File > Open (archipelago.js).
// The file goes into the goals store (idb.js) under its SHA-256, with its address, once the session that drew it saves
// (sessions.js), so a reload or a later visit reads it from there. A stored copy is used only while its SHA-256 and its
// size match the seed's, and goes where they don't.
// Decoding never converts colors (decision 19): UPNG up to 16,000,000 pixels, and past that createImageBitmap with color
// space conversion off, which decodes off the page's thread in a third of UPNG's time at 4096x4096. A file with
// transparency or 16 bits a channel stays with UPNG up to 4096x4096, since only UPNG gives it the same bytes in every
// browser. Transparency is flattened onto white, so the goal shows what the score asks for.
import { $G } from "./helpers.js";
import { request_of, transact } from "./idb.js";
import { showMessageBox } from "./msgbox.js";

const UPNG_MOST_PIXELS = 16000000;
const MOST_SIDE = 4096; // goals past 4096 a side wait for session 7d (task 7.10)
const SHOW_AFTER_MS = 1000; // a goal that loads faster than this shows no window, as one from the goals store mostly does
const PROGRESS_EVERY_MS = 100;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * @typedef {{ key: string, game: { seed: string, team: number, slot: number }, reference: string, sha256: string, width: number, height: number, named: boolean }} SeedGoal
 * @typedef {{ sha256: string, blob: Blob, width: number, height: number, url: string }} DrawnGoal
 */

/** @type {SeedGoal | null} the goal the loaded seed asks for, or null for a seed that doesn't lock its goal */
let wanted = null;
// "none" (no seed locks a goal), "loading", "ready", "failed" or "canceled"
let state = "none";
/** @type {DrawnGoal & { key: string } | null} the seed's goal as drawn on the goal canvas */
let drawn = null;
/** @type {{ what: string, lead: string, message: string } | null} why the last load failed */
let failure = null;
let turn = 0; // each load's own number: a load that a later one or a cancel replaced draws nothing
/** @type {AbortController | null} */
let controller = null;
let show_timer = 0;
const progress = { stage: "", got: 0, total: 0, shown_at: 0 };
const counts = { loads: 0, downloads: 0, stored_reads: 0, files: 0 };
// What the last load did, and when, in ms from its start, for tests and the measurements: where the file came from, its
// size, its SHA-256, the decoder, and the times it was fetched, hashed, decoded and drawn.
let last = null;
/** @type {any} */
let $window = null, $text = null, $buttons = null;

// A goal Paint won't score against, with what is wrong as the end of the sentence the window says it in.
const refusal = (what, message, lead = "Paint can't use the goal image") => Object.assign(new Error(message), { refusal: what, lead });
const DOWNLOAD_LEAD = "Paint couldn't download the goal image";
const canceled = () => Object.assign(new Error("canceled"), { canceled: true });
const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
// The goal's name for a message: the reference as its YAML gives it, cut short past 200 characters.
const name_of = (spec) => (spec.reference.length > 200 ? `${spec.reference.slice(0, 200)}...` : spec.reference);

/**
 * The goal a seed asks for, from its slot data's goal_image and goal_image_sha256 and its game, at the size archipelago.js
 * read from it, or null for a seed from before 1.2.0, whose goal isn't locked.
 * @param {any} goal_image
 * @param {any} goal_image_sha256
 * @param {{ seed: string, team: number, slot: number }} game
 * @param {number} width
 * @param {number} height
 * @param {boolean} before_1_2_0
 * @returns {SeedGoal | null}
 */
function seed_goal_of(goal_image, goal_image_sha256, game, width, height, before_1_2_0) {
	if (before_1_2_0) return null;
	const text = typeof goal_image === "string" ? goal_image : "default";
	const named = text !== "default" && text !== "";
	const reference = named ? text : `images/archipelago/${width}x${height}.png`;
	const sha256 = typeof goal_image_sha256 === "string" ? goal_image_sha256.toLowerCase() : "";
	const key = JSON.stringify([game.seed, game.team, game.slot, reference, sha256, width, height]);
	return { key, game: { ...game }, reference, sha256, width, height, named };
}

/**
 * A login into a seed that locks its goal. A reconnect, with the goal canvas kept and the same goal asked for, leaves the
 * goal as it is, drawn or still loading. A goal that failed or was canceled is tried again. Any other goal loads.
 * @param {SeedGoal} spec
 * @param {boolean} cleared whether the login started the goal canvas over
 */
function take_seed_goal(spec, cleared) {
	const same = wanted?.key === spec.key;
	wanted = spec;
	if (same && (state === "loading" || (state === "ready" && !cleared))) return;
	load(spec, { retry: same && (state === "failed" || state === "canceled") });
}

/** A login into a seed from before 1.2.0: no goal is locked, and a load under way stops. */
function release_seed_goal() {
	if (!wanted && state === "none") return;
	turn++;
	controller?.abort();
	controller = null;
	clearTimeout(show_timer);
	wanted = null;
	drawn = null;
	failure = null;
	state = "none";
	close_window();
	show_status();
}

/** Whether the loaded seed locks its goal (D18). */
const goal_locked = () => wanted !== null;

/** The goal-ready flag: down while a seed that locks its goal hasn't had it drawn. */
const goal_ready = () => wanted === null || state === "ready";

/** What the status bar's similarity field says while the flag is down, or null when the goal is ready. */
const goal_status_text = () => (goal_ready() ? null : state === "loading" ? "Loading goal" : "No goal");

/** The seed's goal as drawn, for the session's record (sessions.js), or null. A page that can't hash stores none. */
const drawn_seed_goal = () => (state === "ready" && drawn?.sha256 ? { sha256: drawn.sha256, blob: drawn.blob, width: drawn.width, height: drawn.height, url: drawn.url } : null);

/** Tries a goal that failed or was canceled again, downloading it afresh. */
function retry_goal() {
	if (wanted && (state === "failed" || state === "canceled")) load(wanted, { retry: true });
}

/** Stops the load under way. The goal stays missing, and the window offers Retry. */
function cancel_goal() {
	if (state !== "loading") return;
	turn++;
	controller?.abort();
	controller = null;
	clearTimeout(show_timer);
	state = "canceled";
	failure = null;
	show_status();
	show_window();
}

// An address for the reference: a path in this site, resolved against the page, or an https URL with no user name. A
// loopback host may be asked over http, which the browser counts as secure, for a copy of the client served on this
// computer and its tests. Anything else is null.
function resolve(reference) {
	let url;
	try {
		url = new URL(reference, document.baseURI);
	} catch (_error) {
		return null;
	}
	if (!/^[a-z][a-z0-9+.-]*:/i.test(reference) && !reference.startsWith("//") && !reference.startsWith("\\")) {
		return url.origin === location.origin ? url : null;
	}
	if (url.username || url.password) return null;
	if (url.protocol === "https:") return url;
	return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url : null;
}

// Whether this browser makes a canvas of the goal's size that holds what is drawn on it. One that can't gives a canvas
// that draws nothing, and its pixels read as transparent black. The corner's 2x2 pixels are read back: where the browser
// answers reads with random bytes, as Firefox's resistFingerprinting does, one pixel reads as transparent black once in
// 256 reads, and four of them next to never.
function canvas_fits(width, height) {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx || canvas.width !== width || canvas.height !== height) return false;
		const w = Math.min(2, width), h = Math.min(2, height);
		ctx.fillStyle = "#010203";
		ctx.fillRect(width - w, height - h, w, h);
		const read = ctx.getImageData(width - w, height - h, w, h).data;
		canvas.width = canvas.height = 0;
		return read.some((value) => value > 0);
	} catch (_error) {
		return false;
	}
}

// The PNG's size and format from its IHDR, or null for a file that isn't a PNG.
function png_head(bytes) {
	if (bytes.length < 33 || PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) return null;
	if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20), depth: bytes[24], color: bytes[25], interlace: bytes[28], exact: false };
}

// Channels a pixel for each PNG color type: gray, RGB, palette, gray and alpha, RGBA.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// The bytes a PNG's image data inflates to: each row with its filter byte, in Adam7's seven passes when interlaced.
function raw_size({ width, height, depth, color, interlace }) {
	const row = (w) => 1 + Math.ceil(w * CHANNELS[color] * depth / 8);
	if (!interlace) return height * row(width);
	let size = 0;
	for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
		const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
		if (w > 0 && h > 0) size += h * row(w);
	}
	return size;
}

// Whether the PNG's image data inflates whole, to the bytes its header asks for, checked by the browser's own zlib with
// its checksum. UPNG's inflater loops for good on image data that is damaged or cut short, with the page held. Where the
// browser has no DecompressionStream, nothing is checked.
async function image_data_whole(bytes, head) {
	if (typeof DecompressionStream !== "function") return true;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const stream = new DecompressionStream("deflate");
	const writer = stream.writable.getWriter();
	for (let at = 8; at + 12 <= bytes.length;) {
		const length = view.getUint32(at);
		if (at + 12 + length > bytes.length) break;
		if (String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]) === "IDAT") writer.write(bytes.subarray(at + 8, at + 8 + length)).catch(() => { });
		at += 12 + length;
	}
	writer.close().catch(() => { });
	const expected = raw_size(head), reader = stream.readable.getReader();
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > expected) {
				reader.cancel().catch(() => { });
				return false;
			}
		}
	} catch (_error) {
		// Damaged data, or data cut short. Bytes after a whole stream end it with an error too, once it is whole.
	}
	return total === expected;
}

// The PNG's chunks from its signature to its IEND chunk: whether they run whole, and whether one is a tRNS. A file cut
// short, as by a host that stored part of it, decodes with its missing rows black in UPNG, which would score a seed
// with no hash against them.
function png_chunks(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const name = (at) => String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
	let transparency = false;
	for (let at = 8; at + 12 <= bytes.length;) {
		const end = at + 12 + view.getUint32(at);
		if (end > bytes.length) break;
		if (name(at) === "IEND") return { whole: true, transparency };
		if (name(at) === "tRNS") transparency = true;
		at = end;
	}
	return { whole: false, transparency };
}

// The SHA-256 of bytes as 64 hex digits, or null where the page can't work one out (no secure context).
async function sha256_hex(bytes) {
	if (!window.crypto?.subtle) return null;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The seed's goal from the goals store: the record under the seed's SHA-256, or for a seed with no hash the one stored
// from the same address. It counts only while its bytes have that SHA-256 and the seed's size, and goes otherwise. Its
// bytes are read at once: Firefox can let go of a stored file's bytes once its record is put again. Null where the store
// has none, or doesn't open.
async function stored_file(spec, url) {
	try {
		const record = await transact(["goals"], "readonly", ({ goals }) => request_of(spec.sha256 ? goals.get(spec.sha256) : goals.index("url").get(url.href)));
		if (!record?.blob) return null;
		const bytes = new Uint8Array(await record.blob.arrayBuffer());
		const sha256 = await sha256_hex(bytes);
		if (!sha256) return null; // a page that can't hash can't check it either
		const head = png_head(bytes);
		if (sha256 === record.sha256 && head?.width === spec.width && head.height === spec.height) {
			counts.stored_reads++;
			return { bytes, sha256 };
		}
		await transact(["goals"], "readwrite", ({ goals }) => { goals.delete(record.sha256); }).catch(() => { });
		return null;
	} catch (_error) {
		return null;
	}
}

// Downloads the file, with CORS for another site, and reports how much has come. A Retry asks past the browser's cache.
async function download(url, spec, signal, retry, my) {
	counts.downloads++;
	let response;
	try {
		response = await fetch(url.href, { mode: "cors", credentials: "same-origin", cache: retry ? "reload" : "default", signal });
	} catch (error) {
		if (signal.aborted) throw canceled();
		throw refusal("download", `the request failed (${error?.message ?? error}). Its host may be down, or may not let other sites load its files.`, DOWNLOAD_LEAD);
	}
	if (!response.ok) {
		throw refusal("download", `the server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`, DOWNLOAD_LEAD);
	}
	// A PNG of the goal's size is at most 8 bytes a pixel, at 16 bits a channel with alpha, stored with no compression.
	const most = spec.width * spec.height * 8 + 1048576;
	const total = Number(response.headers.get("content-length")) || 0;
	if (total > most) {
		throw refusal("size", `it is ${megabytes(total)}, more than any PNG of ${spec.width}x${spec.height} can be.`);
	}
	if (!response.body) {
		return new Uint8Array(await response.arrayBuffer());
	}
	const reader = response.body.getReader();
	let bytes = new Uint8Array(total || 1 << 20), got = 0;
	for (;;) {
		let chunk;
		try {
			chunk = await reader.read();
		} catch (error) {
			if (signal.aborted) throw canceled();
			throw refusal("download", `the download broke off after ${megabytes(got)} (${error?.message ?? error}).`, DOWNLOAD_LEAD);
		}
		if (chunk.done) break;
		const value = chunk.value;
		if (got + value.length > most) {
			reader.cancel().catch(() => { });
			throw refusal("size", `it is more than ${megabytes(most)}, more than any PNG of ${spec.width}x${spec.height} can be.`);
		}
		if (got + value.length > bytes.length) {
			const grown = new Uint8Array(Math.max(bytes.length * 2, got + value.length));
			grown.set(bytes.subarray(0, got));
			bytes = grown;
		}
		bytes.set(value, got);
		got += value.length;
		if (my === turn) {
			progress.got = got;
			progress.total = total;
			if (performance.now() - progress.shown_at >= PROGRESS_EVERY_MS) update_window();
		}
	}
	return got === bytes.length ? bytes : bytes.slice(0, got);
}

// Decodes the PNG into the goal's pixels, with no color conversion: UPNG's RGBA bytes with transparency flattened onto
// white, or past UPNG's size an ImageBitmap, which draw() puts on white. A file with transparency or 16 bits a channel
// goes to UPNG at any size up to 4096x4096: there the browsers' own flattening and rounding differ by a level here and
// there, Chrome's from Firefox's, where UPNG's give every browser the same bytes. An 8-bit file with no transparency
// decodes to the same bytes either way. A test can pick the decoder with window.paint_hard_goal_decoder, "upng" or
// "bitmap".
async function decode(bytes, head) {
	const pixels = head.width * head.height;
	const decoder = window.paint_hard_goal_decoder ?? (pixels <= UPNG_MOST_PIXELS || (head.exact && pixels <= MOST_SIDE * MOST_SIDE) ? "upng" : "bitmap");
	last.decoder = decoder;
	if (decoder === "upng") {
		if (!(head.color in CHANNELS) || !(await image_data_whole(bytes, head))) {
			throw refusal("decode", "it won't decode as a PNG: its image data is damaged or cut short.");
		}
		let rgba;
		try {
			const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
			const png = UPNG.decode(buffer);
			if (png.width !== head.width || png.height !== head.height) throw new Error(`its image data is ${png.width}x${png.height}`);
			rgba = new Uint8ClampedArray(UPNG.toRGBA8(png)[0]);
		} catch (error) {
			throw refusal("decode", `it won't decode as a PNG (${error?.message ?? error}).`);
		}
		if (rgba.length !== head.width * head.height * 4) throw refusal("decode", "it won't decode as a PNG: its image data is short.");
		flatten(rgba);
		return { rgba, bitmap: null };
	}
	let bitmap;
	try {
		bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
	} catch (error) {
		throw refusal("decode", `it won't decode as a PNG (${error?.message ?? error}).`);
	}
	if (bitmap.width !== head.width || bitmap.height !== head.height) {
		bitmap.close();
		throw refusal("decode", `it won't decode as a PNG: its image data is ${bitmap.width}x${bitmap.height}.`);
	}
	return { rgba: null, bitmap };
}

// Each pixel that isn't opaque, as it shows over white: what the goal view shows is what the score asks for.
function flatten(rgba) {
	for (let i = 3; i < rgba.length; i += 4) {
		const alpha = rgba[i];
		if (alpha === 255) continue;
		const white = 255 - alpha;
		rgba[i - 3] = Math.round(rgba[i - 3] * alpha / 255) + white;
		rgba[i - 2] = Math.round(rgba[i - 2] * alpha / 255) + white;
		rgba[i - 1] = Math.round(rgba[i - 1] * alpha / 255) + white;
		rgba[i] = 255;
	}
}

function draw(pixels, spec) {
	if (goal_canvas.width !== spec.width || goal_canvas.height !== spec.height) {
		goal_canvas.width = spec.width;
		goal_canvas.height = spec.height;
	}
	if (pixels.rgba) {
		goal_ctx.putImageData(new ImageData(pixels.rgba, spec.width, spec.height), 0, 0);
		return;
	}
	goal_ctx.save();
	goal_ctx.globalCompositeOperation = "source-over";
	goal_ctx.globalAlpha = 1;
	goal_ctx.imageSmoothingEnabled = false;
	goal_ctx.fillStyle = "#ffffff";
	goal_ctx.fillRect(0, 0, spec.width, spec.height);
	goal_ctx.drawImage(pixels.bitmap, 0, 0);
	goal_ctx.restore();
	pixels.bitmap.close();
}

/**
 * Loads the seed's goal: from a file the player opened whose SHA-256 is the seed's, from the goals store, or by download.
 * Each is checked for its size and, where the seed names one, its SHA-256, before it is decoded and drawn.
 * @param {SeedGoal} spec
 * @param {{ retry?: boolean, file?: { bytes: Uint8Array, sha256: string } }} [options]
 */
async function load(spec, { retry = false, file = undefined } = {}) {
	const my = ++turn;
	controller?.abort();
	const abort = controller = new AbortController();
	state = "loading";
	failure = null;
	counts.loads++;
	const facts = last = { key: spec.key, reference: spec.reference, url: null, from: null, decoder: null, bytes: 0, sha256: null, started: performance.now(), times: {} };
	const mark = (name) => { facts.times[name] = Math.round(performance.now() - facts.started); };
	Object.assign(progress, { stage: "download", got: 0, total: 0 });
	clearTimeout(show_timer);
	show_timer = setTimeout(() => {
		if (my === turn && state === "loading") show_window();
	}, SHOW_AFTER_MS);
	update_window();
	show_status();
	try {
		if (spec.width > MOST_SIDE || spec.height > MOST_SIDE) {
			throw refusal("side", `this seed's goal is ${spec.width}x${spec.height}, and this version of Paint plays goals up to ${MOST_SIDE} pixels a side.`);
		}
		if (spec.sha256 && !/^[0-9a-f]{64}$/.test(spec.sha256)) {
			throw refusal("hash", "the seed's goal_image_sha256 isn't 64 hex digits.");
		}
		const url = resolve(spec.reference);
		if (!url) {
			throw refusal("address", "a goal comes from an https address or from a path in Paint's own site.", "Paint can't load the goal image");
		}
		facts.url = url.href;
		if (spec.sha256 && !window.crypto?.subtle) {
			throw refusal("hash", "this page can't work out a SHA-256 to check it with. Open Paint from its https address.");
		}
		if (!canvas_fits(spec.width, spec.height)) {
			throw refusal("canvas", `this browser couldn't make a ${spec.width}x${spec.height} canvas for it.`);
		}
		let source = file ?? null;
		if (source) {
			facts.from = "file";
			counts.files++;
		} else {
			source = await stored_file(spec, url);
			if (my !== turn) return;
			if (source) {
				facts.from = "store";
			} else {
				facts.from = "network";
				source = { bytes: await download(url, spec, abort.signal, retry, my), sha256: null };
			}
		}
		if (my !== turn) return;
		mark("fetched");
		const bytes = source.bytes;
		facts.bytes = bytes.byteLength;
		const head = png_head(bytes);
		if (!head) throw refusal("decode", "it isn't a PNG file, and Paint takes PNG goal images only.");
		if (head.width !== spec.width || head.height !== spec.height) {
			throw refusal("size", `it is ${head.width}x${head.height}, and the seed's goal is ${spec.width}x${spec.height}.`);
		}
		const chunks = png_chunks(bytes);
		if (!chunks.whole) throw refusal("decode", "it won't decode as a PNG: the file ends before its last chunk.");
		head.exact = head.color === 4 || head.color === 6 || head.depth === 16 || chunks.transparency;
		progress.stage = "check";
		update_window();
		const sha256 = source.sha256 ?? await sha256_hex(bytes);
		if (my !== turn) return;
		mark("hashed");
		facts.sha256 = sha256;
		if (spec.sha256 && sha256 !== spec.sha256) {
			throw refusal("hash", `its SHA-256 is ${sha256}, and the seed's goal_image_sha256 is ${spec.sha256}.`);
		}
		progress.stage = "decode";
		update_window();
		// The window's text shows before UPNG holds the page: a frame goes by first, or 50 ms in a hidden tab.
		await new Promise((resolve) => {
			requestAnimationFrame(() => setTimeout(resolve, 0));
			setTimeout(resolve, 50);
		});
		if (my !== turn) return;
		const pixels = await decode(bytes, head);
		if (my !== turn) {
			pixels.bitmap?.close();
			return;
		}
		mark("decoded");
		draw(pixels, spec);
		mark("drawn");
		drawn = { key: spec.key, sha256, blob: new Blob([bytes], { type: "image/png" }), width: spec.width, height: spec.height, url: url.href };
		state = "ready";
		controller = null;
		clearTimeout(show_timer);
		close_window();
		show_status();
		// The first handler, archipelago.js's, drops the goal as read and scores the canvas against it, and sends what a
		// held send asked for. The session takes the file for its record.
		$G.triggerHandler("save-goal", [drawn_seed_goal()]);
		mark("scored");
	} catch (error) {
		if (my !== turn) return;
		controller = null;
		clearTimeout(show_timer);
		if (error?.canceled) {
			state = "canceled";
		} else {
			state = "failed";
			failure = error?.refusal ?
				{ what: error.refusal, lead: error.lead, message: error.message } :
				{ what: "load", lead: "Paint couldn't load the goal image", message: `${error?.message ?? error}.` };
			facts.failure = failure;
		}
		show_status();
		show_window();
	}
}

/**
 * File > Open Goal Image, a dropped image or Electron's open-file, while the seed locks its goal: the file goes in place of
 * the download only when its SHA-256 is the seed's, and is checked and drawn as a download is. Any other file is refused
 * with a line saying where the goal comes from. Returns false where no goal is locked, for the page to open the file as
 * upstream does.
 * @param {Blob} file
 */
async function offer_goal_file(file) {
	const spec = wanted;
	if (!spec) return false;
	const name = file instanceof File && file.name ? file.name : "this file";
	if (!spec.sha256) {
		showMessageBox({ iconID: "info", message: `This seed's goal comes from its YAML, ${name_of(spec)}, which names no SHA-256 to check another file against. Paint loads the goal from there alone.` });
		return true;
	}
	let bytes, sha256;
	try {
		bytes = new Uint8Array(await file.arrayBuffer());
		sha256 = await sha256_hex(bytes);
	} catch (error) {
		showMessageBox({ iconID: "error", message: `Paint couldn't read ${name}: ${error?.message ?? error}` });
		return true;
	}
	if (sha256 !== spec.sha256 || wanted !== spec) {
		showMessageBox({ iconID: "info", message: `This seed's goal comes from its YAML, ${name_of(spec)}. Paint takes a file in its place only when the file's SHA-256 is the seed's goal_image_sha256, and ${name}'s isn't.` });
		return true;
	}
	load(spec, { file: { bytes, sha256 } });
	return true;
}

// --- What the player sees ---

// The status bar's similarity field, while the goal-ready flag is down: it says the goal is loading or missing, and a
// click on it shows the Goal Image window again (show_goal_window()), whose Close, Escape and title-bar close let it go
// with its Cancel or Retry. Once the goal is drawn, its rescore puts the score back in the field, and the tip goes.
const FIELD_TIP = "Click to show the Goal Image window.";
function show_status() {
	const text = goal_status_text(), $field = window.$status_similarity;
	if (!$field) return;
	if (text !== null) $field.text(text);
	$field.attr("title", text === null ? null : FIELD_TIP).css("cursor", text === null ? "" : "pointer");
}

/** Shows the Goal Image window again while the seed's goal is loading or missing: a click on the status bar's field. */
function show_goal_window() {
	if (!goal_ready()) show_window();
}

function window_text() {
	const spec = wanted;
	if (!spec) return "";
	const name = name_of(spec);
	if (state === "loading") {
		const step = progress.stage === "check" ? `Checking the goal image ${name}.` :
			progress.stage === "decode" ? `Decoding the goal image ${name}.` :
				progress.total ? `Loading the goal image ${name}: ${megabytes(progress.got)} of ${megabytes(progress.total)}.` :
					progress.got ? `Loading the goal image ${name}: ${megabytes(progress.got)} so far.` :
						`Loading the goal image ${name}.`;
		return `${step} Paint sends no checks until it is drawn.`;
	}
	if (state === "canceled") {
		return `You canceled the goal image ${name} before it loaded. Paint sends no checks until it loads.`;
	}
	if (state === "failed" && failure) {
		return `${failure.lead} ${name}: ${failure.message} Paint sends no checks until the goal loads.`;
	}
	return "";
}

function show_window() {
	if (!wanted) return;
	if (!$window || $window.closed) {
		$window = $Window({ title: "Goal Image", resizable: false, maximizeButton: false, minimizeButton: false });
		$window.addClass("goal-image-window");
		$text = $("<p>").css({ margin: "10px 12px", whiteSpace: "normal", overflowWrap: "anywhere", maxWidth: "440px", minWidth: "300px" });
		$buttons = $("<div>").css({ display: "flex", justifyContent: "flex-end", gap: "6px", margin: "0 12px 12px" });
		$window.$content.append($text, $buttons);
		$window.onClosed?.(() => {
			$window = null;
		});
		update_window();
		$window.center();
		return;
	}
	update_window();
}

function update_window() {
	if (!$window || $window.closed) return;
	progress.shown_at = performance.now();
	$text.text(window_text());
	const wants = state === "loading" ? "loading" : state === "failed" || state === "canceled" ? "retry" : "";
	if ($buttons.attr("data-for") === wants) return;
	$buttons.attr("data-for", wants).empty();
	const button = (label, action) => $("<button>").text(label).css({ minWidth: "75px", height: "23px" }).on("click", action).appendTo($buttons);
	if (wants === "loading") {
		button("Cancel", cancel_goal);
	} else if (wants === "retry") {
		button("Retry", () => retry_goal()).addClass("default");
		button("Close", () => close_window());
	}
}

function close_window() {
	if ($window && !$window.closed) $window.close();
	$window = null;
}

// For tests and the measurements: the goal's state, the last load's facts and the counts of loads, downloads, reads of
// the goals store and files taken, and the window's text while it shows.
window.paint_hard_goal = {
	status: () => ({
		state, locked: goal_locked(), ready: goal_ready(), key: wanted?.key ?? null, reference: wanted?.reference ?? null,
		sha256: wanted?.sha256 ?? null, size: wanted ? [wanted.width, wanted.height] : null,
		drawn: drawn ? { key: drawn.key, sha256: drawn.sha256, url: drawn.url } : null,
		failure: failure && { ...failure }, last: last && { ...last, times: { ...last.times } }, counts: { ...counts },
		window: $window && !$window.closed ? $text.text() : null, status_text: goal_status_text(),
	}),
	retry: retry_goal,
	cancel: cancel_goal,
};

export { cancel_goal, drawn_seed_goal, goal_locked, goal_ready, goal_status_text, offer_goal_file, release_seed_goal, retry_goal, seed_goal_of, show_goal_window, take_seed_goal };
