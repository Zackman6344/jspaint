// @ts-check
// eslint-disable-next-line no-unused-vars
/* global file_name:writable */
/* global $app, $canvas_area, localize, magnification, main_canvas, main_ctx, redos, undos */
import { $DialogWindow } from "./$ToolWindow.js";
// import { localize } from "./app-localization.js";
import { final_height, final_width, loaded_game } from "./archipelago.js";
import { canvas_tainted, copies_unsaved, reads_are_blocked } from "./auto-copy.js";
import { change_url_param, get_uris, load_image_from_uri, open_from_image_info, open_session_canvas, redo, reset_canvas_and_history, reset_file, show_error_message, show_resource_load_error_message, undo, undoable, update_title } from "./functions.js";
import { drawn_seed_goal, goal_locked } from "./goal.js";
import { $G, debounce, get_help_folder_icon, image_data_match, is_discord_embed, make_canvas, to_canvas_coords } from "./helpers.js";
import { close_db, error_kind, idb_state, on_idb, open_db, request_of, sha256_of, transact } from "./idb.js";
import { storage_quota_exceeded } from "./manage-storage.js";
import { showMessageBox } from "./msgbox.js";
import { localStore } from "./storage.js";

const log = (...args) => {
	window.console?.log(...args);
};

let localStorageAvailable = false;
try {
	localStorage._available = true;
	localStorageAvailable = localStorage._available;
	delete localStorage._available;
} catch (_error) { /* ignore */ }

// @TODO: keep other data in addition to the image data
// such as the file_name and other state
// (maybe even whether it's considered saved? idk about that)
// I could have the image in one storage slot and the state in another

// Upstream's check that the canvas didn't go blank, which reads it whole. Pain-T's local sessions don't make it (task
// 7.4): with transparency off the canvas is never blank. The Firebase and REST sessions still do.
const match_threshold = 1; // 1 is just enough for a workaround for Brave browser's farbling: https://github.com/1j01/jspaint/issues/184
const canvas_has_any_apparent_image_data = () =>
	main_canvas.ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data.some((v) => v > match_threshold);

let $recovery_window;
function show_recovery_window(no_longer_blank) {
	$recovery_window?.close();
	const $w = $recovery_window = $DialogWindow();
	$w.on("close", () => {
		$recovery_window = null;
	});
	$w.title("Recover Document");
	let backup_impossible = false;
	try { window.localStorage.getItem("bogus test key"); } catch (_error) { backup_impossible = true; }
	// TODO: get rid of this invasive dialog https://github.com/1j01/jspaint/issues/325
	// It appears when it shouldn't, in basic scenarios like Ctrl+A in a transparent document,
	// and it gets bigger once you edit the document, which feels... almost aggressive.
	// That said, I've made it more compact and delineated the expanded section with a horizontal rule,
	// so it doesn't feel as much like it's changed out from under you and you have to re-read it.
	$w.$main.append($(`
		<p>Woah! The canvas became empty.</p>
		<p>If this was on purpose, please ignore this message.</p>
		<p>
			If the canvas was cleared due to memory usage,<br>
			click Undo to recover the document.
		</p>
		<!--<p>Remember to save with <b>File > Save</b>!</p>-->
		${backup_impossible ?
			"<p><b>Note:</b> No automatic backup is possible unless you enable Cookies in your browser.</p>" :
			(
				no_longer_blank ?
					`<hr>
					<p style="opacity: 0.8; font-size: 0.9em;">
						Auto-save is paused while this dialog is open.
					</p>
					<p style="opacity: 0.8; font-size: 0.9em;">
						(See <b>File &gt; Manage Storage</b> to view backups.)
					</p>` :
					""
			)
		}
	`));

	const $undo = $w.$Button("Undo", () => {
		undo();
	});
	const $redo = $w.$Button("Redo", () => {
		redo();
	});
	const update_buttons_disabled = () => {
		$undo.prop("disabled", undos.length < 1);
		$redo.prop("disabled", redos.length < 1);
	};
	$G.on("session-update.session-hook", update_buttons_disabled);
	update_buttons_disabled();

	$w.$Button(localize("Close"), () => {
		$w.close();
	});
	$w.center();

	$w.find("button:enabled").focus();
}

let last_undos_length = undos.length;
function handle_data_loss() {
	const window_is_open = $recovery_window && !$recovery_window.closed;
	let save_paused = false;
	if (!canvas_has_any_apparent_image_data()) {
		if (!window_is_open) {
			show_recovery_window();
		}
		save_paused = true;
	} else if (window_is_open) {
		if (undos.length > last_undos_length) {
			show_recovery_window(true);
		}
		save_paused = true;
	}
	last_undos_length = undos.length;
	return save_paused;
}

function save_image_to_storage(key, value, callback) {
	log(`Saving image to storage: ${key}`);
	localStore.set(key, value,
		(err) => {
			if (err) {
				// @ts-ignore (quotaExceeded is added by storage.js)
				if (err.quotaExceeded) {
					storage_quota_exceeded();
				} else {
					// e.g. localStorage is disabled
					// (or there's some other error?)
					// @TODO: show warning with "Don't tell me again" type option
				}
			}
			callback?.(err);
		})
}

// How long a restore may take before the tab stops waiting for it and goes on in a new session (task 7.5). A test can
// set window.paint_hard_restore_timeout_ms before the page loads.
const RESTORE_TIMEOUT_MS = 30000;
// What the latest restore of a stored record came to, for tests: "restored", "failed", "timed out" or "another game",
// or "nothing stored" while the page has restored none.
let restore_outcome = "nothing stored";
// What the session this tab was in last belonged to: its game, { seed, team, slot } or null, with the connection and the
// goal size that game was last logged in with. That session's canvas stays on the page until a record is restored over
// it, so the session that follows starts as that game's, and a login into another game leaves it behind too.
const NO_GAME = { game: null, connection: null, final: null };
let left_as = NO_GAME;
// The palette a page starts with, before a game's items add to it. A login into another game starts from it.
const fresh_palette = [...palette];

const same_game = (a, b) => a.seed === b.seed && a.team === b.team && a.slot === b.slot;
// Whether a stored record may be restored in this tab now (decision 7): any record while the page has no game loaded,
// and with one loaded a record of that game, or of no game yet, which its next login binds. Restored under another
// game, a canvas takes that game's size, is saved so over its record, and is scored in that game. The address handler
// asks first and turns away more (update_session_from_location_hash()). This is asked as a record lands, for a game
// loaded since.
const opens_here = (record) => {
	const loaded = loaded_game();
	return !loaded || !record.game || same_game(record.game, loaded);
};
const ANOTHER_GAME = Symbol("another game");
// When the player last typed in each field of the connection form, by performance.now(). A restore whose read lands
// later, as behind a slow first open of the database, leaves that field as typed.
const typed_at = {};
$(document).on("input change", "[name=aphost], [name=apport], [name=apslot]", (event) => {
	typed_at[event.target.name] = performance.now();
});
// Says where the canvas of the game before went, as a login into another game starts the tab on a new one. `slot` is the
// slot name that game was logged in with, if the session knew one. A second such login puts its message in place of the
// first.
let $left_notice = null;
function say_left(slot) {
	if ($left_notice && !$left_notice.closed) {
		$left_notice.close();
	}
	$left_notice = showMessageBox({
		iconID: "info",
		message: `This tab logged into another game, so it starts on a new canvas. The canvas of the game before${slot ? `, ${slot}'s,` : ""} stays in this browser: File > Manage Storage lists it, and its picture there opens it.`,
	}).$window;
}

// Task 7.4: a session lives in IndexedDB (idb.js) as a record of version 2: its id; the canvas as a PNG from toBlob, and
// its size; the game's goal size (final_width, final_height); the key of its goal image in the goals store
// (goal_key_of()), kept once there however many sessions refer to it, or null before a goal is drawn; the palette; the
// connection's host, port and slot, never its password; the game it belongs to, { seed, team, slot } (decision 7); and
// when it was saved (saved_at).
// A save goes out 100 ms after the change that asks for it, and no sooner than the longer of 5 s and 50 times the time the
// last save held the page after the one before, so a big canvas saves less often. That wait stops at 60 s, whatever a
// save cost. One save is in flight at a time, and one more waits behind it. A test can set
// window.paint_hard_save_every_ms before the page loads, for the 5 s.
const SAVE_EVERY_MS = 5000;
const SAVE_COST_FACTOR = 50;
const SAVE_EVERY_MAX_MS = 60000;
const save_every_floor = () => window.paint_hard_save_every_ms ?? SAVE_EVERY_MS;
// How long saves wait after one that held the page for `cost` ms.
const save_every_after = (cost) => Math.max(save_every_floor(), Math.min(SAVE_EVERY_MAX_MS, SAVE_COST_FACTOR * cost));
// The writes of sessions and goals ask the browser to flush the file and the commit before it reports them done. A save
// replaces the canvas's file, and with the default durability a crash of the computer seconds later could leave the new
// file on disk with its size and without its bytes, and the old file gone.
const STRICT = { durability: "strict" };
// Chrome makes a canvas's PNG in the page's idle moments, and where the page has had none for about a second, all at
// once on the page's thread. With 10 ms tasks back to back, that was one long task of 124-179 ms for a photo-like
// 2000x1500 canvas and of 593-997 ms for 4000x3000, ending 11-13 ms before the PNG came, where the save's own calls took
// under 1 ms. So a save counts the long tasks that ended in the 100 ms before one of its PNGs came and that began 990 ms
// or more after that PNG's toBlob call: Chrome gives a PNG 1 s to begin in an idle moment before it makes it on the
// page's thread. A long task that began sooner is other work's, which only held the PNG up. Firefox makes its PNGs off
// the page's thread and reports no long tasks.
const PNG_TASK_MS = 100;
const PNG_FORCED_AFTER_MS = 990;
const long_tasks = [];
let long_task_watch = null;
try {
	if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
		long_task_watch = new PerformanceObserver((list) => {
			long_tasks.push(...list.getEntries());
			long_tasks.splice(0, long_tasks.length - 200);
		});
		long_task_watch.observe({ type: "longtask" });
	}
} catch (_error) { /* no long tasks reported here */ }
// How long the long tasks took that made one of `pngs`, each { called, came } by performance.now(): those that began
// 990 ms or more after the PNG's toBlob call and ended in the 100 ms before it came. Long tasks from before the last PNG
// came are then forgotten.
function long_task_time(pngs) {
	if (long_task_watch) {
		long_tasks.push(...long_task_watch.takeRecords());
	}
	let time = 0;
	for (const task of long_tasks) {
		const ended = task.startTime + task.duration;
		if (pngs.some(({ called, came }) => task.startTime >= called + PNG_FORCED_AFTER_MS && ended > came - PNG_TASK_MS && ended <= came + 5)) time += task.duration;
	}
	const last = Math.max(...pngs.map((png) => png.came));
	long_tasks.splice(0, long_tasks.length, ...long_tasks.filter((task) => task.startTime > last));
	return time;
}
// A tab asks for its session's Web Lock up to three times, 1 s apart, before it takes the session as another tab's: the
// page a reload replaces lets go of it as it closes, and a duplicated tab's original never does.
const LOCK_ASKS = 3;
const LOCK_ASK_EVERY_MS = 1000;
const lock_name = (id) => `pain-t-session:${id}`;
// As the page goes, a change not yet saved goes to sessionStorage, which keeps it for the tab's next load, a reload among
// them: toBlob answers after the page has gone, and Chrome drops an IndexedDB write begun then. sessionStorage holds
// 5,242,880 characters a tab in Chrome and Firefox, keys and all, and auto copy keeps its Overclock totals there too, so
// the copy takes 4,000,000 at most, with its canvas as a data URL. A canvas whose last PNG was too big for that isn't
// encoded at all, nor one past 4096x4096, where the encode would hold up the page's close for seconds.
const UNLOAD_SAVE_PIXELS = 4096 * 4096;
const UNLOAD_SAVE_CHARS = 4000000;
const staged_key = (id) => `pain-t-unsaved:${id}`;
// The localStorage keys a session kept before it moved to IndexedDB: the record, and the older format's three more.
const local_keys = (id) => ["", "_goal", "_connection_info", "_colors"].map((suffix) => `image#${id}${suffix}`);

// Whether this page has seen a session record in IndexedDB, saved or restored, and the persistent storage it asked for
// (task 7.4): asked once a page, at the Connect click once such a record exists or right after the first save that lands
// from then, and never waited on, since Firefox asks the player and Chrome answers by its own rules. Its answer is kept,
// for tests: Manage Storage asks the browser itself whether it keeps the storage.
let stored_in_idb = false;
const persistence = { wanted: false, asked: 0, answer: null, error: null };
function ask_persistence() {
	if (persistence.asked || !navigator.storage?.persist) return;
	persistence.asked++;
	navigator.storage.persist().then((answer) => {
		persistence.answer = answer;
	}, (error) => {
		persistence.answer = false;
		persistence.error = error?.name ?? String(error);
	});
}
$G.on("connect-click", () => {
	persistence.wanted = true;
	if (stored_in_idb) ask_persistence();
});

// Each storage failure says so once a page, until a save lands again.
let failure_shown = false;
// What the page has said about saves and sends held because the browser blocked canvas reads. Each message shows once a
// page.
const blocked_said = new Set();
const say_blocked = (message) => {
	if (!blocked_said.has(message)) {
		blocked_said.add(message);
		show_error_message(message);
	}
};
// Once reads are allowed again, the canvas may still hold what the blocked reads drew back onto it, so saves and sends
// wait for a reload (auto-copy.js's canvas_tainted()), and the page says so.
$G.on("canvas-reads-allowed", () => {
	say_blocked("Now that canvas reads are allowed, reload this tab to send checks and save.");
});
on_idb("blocked", () => {
	show_error_message("Paint is waiting for another of its tabs, from an older version, to let go of its storage. Close or reload Paint's other tabs.");
});
on_idb("newer", () => {
	show_error_message("Paint was updated in another tab, so this tab can no longer save to its storage. Reload this tab to go on in the new version: its last save stays as it is. If this message comes back after a reload, the browser loaded the old version again: reload once more.");
});
// The database didn't open on this page load: its open ended in an error, or had no answer in 15 s (idb.js). It may hold
// sessions this page can't read, so the page writes nothing under an id it may hold (restore()), and says so once.
const database_unopened = () => idb_state() === "failed" || idb_state() === "silent";
const say_unopened = () => {
	show_error_message("Paint couldn't open its storage on this page load. The sessions it keeps there stay as they are: reload this tab to try again. Until then Paint keeps what it saves in the browser's older storage, apart from them.");
};
on_idb("failed", say_unopened);
on_idb("silent", say_unopened);
// Whether localStorage holds a record for a session id.
const has_local_record = (id) => {
	try {
		return localStorage.getItem(`image#${id}`) !== null;
	} catch (_error) {
		return false;
	}
};

const connection_fields = () => ({ host: $("[name=aphost]").val(), port: $("[name=apport]").val(), slot: $("[name=apslot]").val() });
// A canvas's PNG, with when it was asked for and when it came, by performance.now().
const png_of = (canvas) => new Promise((resolve, reject) => {
	const called = performance.now();
	canvas.toBlob((blob) => (blob ? resolve({ blob, called, came: performance.now() }) : reject(new Error("The canvas gave no PNG to save."))), "image/png");
});
// A data URL's bytes, decoded at once.
function blob_of_data_url(uri) {
	const comma = uri.indexOf(",");
	const head = uri.slice(5, comma), body = uri.slice(comma + 1);
	const type = head.split(";")[0] || "text/plain";
	if (!/;base64$/i.test(head)) {
		return new Blob([decodeURIComponent(body)], { type });
	}
	const text = atob(body), bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
	return new Blob([bytes], { type });
}
const data_url_of = (blob) => new Promise((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(reader.result);
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(blob);
});
// A goal's key in the goals store: the SHA-256 of the bytes stored under it, or, where the page can't hash (no secure
// context), its session's. The bytes are the PNG the browser makes of the goal canvas at the game's size, or the goal of
// a record from localStorage as its data URL held it. The goal's source file has another hash. Firefox writes that PNG
// with other bytes after each restart, so there the same goal gets a new key in each run of the browser, and the record
// under the old key goes once no session refers to it.
const goal_key_of = async (blob, id) => (await sha256_of(blob)) ?? `session:${id}`;
// Task 7.8 and D18: the seed's own goal file, as goal.js drew it and checked it, kept in the goals store under its
// SHA-256 with its address, so a reload or a later visit reads it from there in place of a download. It goes in once,
// in a transaction of its own after the record that refers to it has landed, and is left as stored after that: Firefox
// can let go of a stored file's bytes for a page that read them once its record is put again, and a copy that no longer
// matched the seed's has gone by now (goal.js). The store is only a cache of the file. One without room for it, as a
// full store, keeps no copy and says nothing, and the session's record has landed all the same. A file the store
// refused isn't offered to it again on this page. The put is waited on: Firefox fails a put past the quota on its
// request alone, and once the transaction is told to commit, commits it without the file and with no error.
const seed_files_refused = new Set();
async function store_seed_file(goal) {
	if (seed_files_refused.has(goal.sha256)) return;
	try {
		await transact(["goals"], "readwrite", async ({ goals }) => {
			if (!(await request_of(goals.count(goal.sha256)))) {
				await request_of(goals.put({ sha256: goal.sha256, blob: goal.blob, width: goal.width, height: goal.height, url: goal.url, used_at: Date.now() }));
			}
		}, STRICT);
	} catch (error) {
		seed_files_refused.add(goal.sha256);
		log("The goal image's file wasn't kept in storage:", error_kind(error), error);
	} finally {
		close_db();
	}
}
// Lets go of a blob: address made for a stored goal's file once the goal image holds another address, now or at its
// next load. While the image holds it, a login sets the same address again, which loads it again.
function revoke_when_replaced(url) {
	const image = $goal_image[0];
	const look = () => {
		if (image.getAttribute("src") === url) {
			return;
		}
		image.removeEventListener("load", look);
		URL.revokeObjectURL(url);
	};
	image.addEventListener("load", look);
	look();
}

// The version before task 7.4 kept the room password in every localStorage record, as connection_info.pass, or as pass
// under the older format's _connection_info key. Each page load takes it out of the records still there, which
// otherwise keep it until their session is opened and moved, or for good where sessions stay in localStorage. localStore
// wrote each record as JSON inside a JSON string, so the password's name reads \"pass\" in the raw text, which no data
// URL can hold: only a record with that text is parsed, and only one whose password isn't empty is written back, in the
// encoding it had and otherwise as it was.
function scrub_local_passwords() {
	try {
		for (const key of Object.keys(localStorage)) {
			if (!/^image#/.test(key)) continue;
			const text = localStorage.getItem(key);
			if (!text || !text.includes('\\"pass\\"')) continue;
			try {
				const inner = JSON.parse(JSON.parse(text));
				const connection = /_connection_info$/.test(key) ? inner : inner?.connection_info;
				if (connection && typeof connection === "object" && connection.pass) {
					delete connection.pass;
					localStorage.setItem(key, JSON.stringify(JSON.stringify(inner)));
				}
			} catch (_error) { /* not a record this page knows, or one that couldn't be written back */ }
		}
	} catch (_error) { /* site data blocked */ }
}
scrub_local_passwords();

// A stored session in either format this page wrote to localStorage before task 7.4: the JSON record, or the older
// canvas data URL with the goal, connection info and palette under keys of their own.
function read_record(ls_key, data) {
	try {
		const record = JSON.parse(data);
		if (record?.canvas) {
			return record;
		}
	} catch (_error) { /* the older format */ }
	const stored = (suffix) => {
		try {
			return JSON.parse(localStorage.getItem(ls_key + suffix) ?? "null");
		} catch (_error) {
			return null;
		}
	};
	const parsed = (text) => {
		try {
			return typeof text === "string" ? JSON.parse(text) : null;
		} catch (_error) {
			return null;
		}
	};
	return { canvas: data, goal: stored("_goal"), connection_info: parsed(stored("_connection_info")), colors: parsed(stored("_colors")) };
}

function show_storage_read_error(message, error) {
	if (localStorageAvailable) {
		show_error_message(message, error);
	} else {
		// @TODO: DRY with storage manager message
		showMessageBox({
			message: "Please enable local storage in your browser's settings for local backup. It may be called Cookies, Storage, or Site Data.",
		});
	}
}

// A session's record as localStorage kept it, or null. A record that won't read gives a message, unless `quiet`.
function read_local(id, quiet = false) {
	let record = null;
	localStore.get(`image#${id}`, (err, data) => {
		if (err) {
			if (!quiet) show_storage_read_error("Failed to retrieve image from local storage.", err);
		} else if (data) {
			record = read_record(`image#${id}`, data);
		}
	});
	return record;
}

// A localStorage record as a version 2 record, with its goal's file beside it, as `goal_file`. Its size and saved_at are
// unknown until its canvas decodes. Only an image in a data URL is read, as Paint writes them: any other text would be
// fetched as an address, from a record cut short or from a session file made by hand. A canvas that isn't one fails the
// record, and a goal that isn't one is left out.
const IMAGE_DATA_URL = /^data:image\//i;
async function from_local(id, local) {
	let canvas;
	try {
		if (typeof local.canvas !== "string" || !IMAGE_DATA_URL.test(local.canvas)) {
			throw new Error("This session's canvas isn't an image.");
		}
		canvas = await (await fetch(local.canvas)).blob();
	} catch (error) {
		throw Object.assign(error, { unreadable: true }); // the restore's message says the record can't be read
	}
	let goal_file = null;
	if (typeof local.goal === "string" && IMAGE_DATA_URL.test(local.goal)) {
		try {
			const blob = await (await fetch(local.goal)).blob();
			goal_file = { sha256: await goal_key_of(blob, id), blob, uri: local.goal };
		} catch (_error) { /* a goal that won't read is left out, and the login draws the seed's */ }
	}
	const connection = local.connection_info ?? {};
	return {
		id, version: 2, canvas, width: null, height: null, final_width: null, final_height: null,
		goal: goal_file?.sha256 ?? null,
		colors: Array.isArray(local.colors) ? local.colors : null,
		connection: { host: connection.host, port: connection.port, slot: connection.slot },
		game: local.game ?? null,
		saved_at: 0,
		goal_file,
	};
}

// A copy of a session written to sessionStorage as its tab last closed, or null.
function read_staged(id) {
	try {
		const text = sessionStorage.getItem(staged_key(id));
		return text ? JSON.parse(text) : null;
	} catch (_error) {
		return null;
	}
}
const drop_staged = (id) => {
	try { sessionStorage.removeItem(staged_key(id)); } catch (_error) { /* nothing staged */ }
};
// The sessions with a copy in this tab's sessionStorage, but `id`.
const staged_ids_but = (id) => {
	try {
		const prefix = staged_key("");
		return Object.keys(sessionStorage).filter((key) => key.startsWith(prefix) && key !== staged_key(id)).map((key) => key.slice(prefix.length));
	} catch (_error) {
		return [];
	}
};
// Writes a session's copy to sessionStorage as its page goes. A copy this tab left for a session it has since moved on
// from may hold strokes that are stored nowhere else, so it stays until the write is refused for want of room. Then
// those copies go, the oldest first, until this one fits.
function stage(id, text) {
	let others = null;
	for (; ;) {
		try {
			sessionStorage.setItem(staged_key(id), text);
			return;
		} catch (error) {
			others ??= staged_ids_but(id).map((other) => ({ id: other, saved_at: read_staged(other)?.saved_at ?? 0 })).sort((a, b) => a.saved_at - b.saved_at);
			if (!others.length) {
				throw error;
			}
			drop_staged(others.shift().id);
		}
	}
}
// Drops the copies this tab left for sessions other than `id` whose records are by now as new or newer, as after such a
// session was opened in another tab and saved there, and the copies that no longer read. A copy newer than its record
// stays.
async function sweep_staged(id) {
	for (const other of staged_ids_but(id)) {
		const staged = read_staged(other);
		const record = staged && await transact(["sessions"], "readonly", ({ sessions }) => request_of(sessions.get(other)));
		if (!staged || record?.saved_at >= staged.saved_at) {
			drop_staged(other);
		}
	}
}

// What's stored for a session: its record in IndexedDB, or in localStorage where it hasn't moved yet, as a version 2
// record, with a copy staged as the tab last closed in place of the record where that's newer; its goal's file; where
// the record came from: "idb", "local" or "staged"; whether localStorage holds a record that was read as the session's
// own; and a record that localStorage holds beside the IndexedDB record of the same id (`beside`), which restore()
// sets aside.
async function read_stored(id, db) {
	let record = null, from = null, goal_file = null, in_local = false, beside = null;
	if (db) {
		record = (await transact(["sessions"], "readonly", ({ sessions }) => request_of(sessions.get(id)))) ?? null;
		if (record) {
			from = "idb";
			stored_in_idb = true;
			beside = read_local(id, true);
		}
	}
	if (!record) {
		const local = read_local(id);
		if (local) {
			record = await from_local(id, local);
			goal_file = record.goal_file;
			delete record.goal_file;
			from = "local";
			in_local = true;
		}
	}
	const staged = read_staged(id);
	if (staged && (!record || staged.saved_at > record.saved_at)) {
		record = { ...staged, canvas: blob_of_data_url(staged.canvas) };
		from = "staged";
		// The copy names its goal by its key alone. Where that is the goal of a record still in localStorage, the goal's
		// file stays with the copy: the goals store may not hold it, and the next save puts it there before the
		// localStorage keys go.
		if (goal_file?.sha256 !== record.goal) goal_file = null;
	} else if (staged) {
		drop_staged(id);
	}
	if (record?.goal && !goal_file && db) {
		goal_file = (await transact(["goals"], "readonly", ({ goals }) => request_of(goals.get(record.goal)))) ?? null;
	}
	return { record, from, goal_file, in_local, beside };
}

// Moves a record that localStorage holds beside the IndexedDB record of the same id into IndexedDB, as a session of
// its own under a new id. A page load that couldn't open the database leaves such a record, and so does a tab still
// running a version of Paint from before task 7.4. Nothing chooses between the two: the localStorage record has no
// date. Its keys go once the move has committed, if they still hold what was moved, and one message a page says where
// the second copy is.
let aside_shown = false;
async function set_aside(id, local) {
	try {
		const copy = await from_local(generate_session_id(), local);
		const goal_file = copy.goal_file;
		delete copy.goal_file;
		const bitmap = await createImageBitmap(copy.canvas, { colorSpaceConversion: "none" }).catch(() => null);
		Object.assign(copy, { width: bitmap?.width ?? null, height: bitmap?.height ?? null, saved_at: Date.now() });
		bitmap?.close();
		// Another tab that opened the session may have moved the record by now.
		if (read_local(id, true)?.canvas !== local.canvas) {
			return;
		}
		await transact(["sessions", "goals"], "readwrite", ({ sessions, goals }) => {
			sessions.put(copy);
			if (goal_file) {
				goals.put({ sha256: goal_file.sha256, blob: goal_file.blob, width: null, height: null, used_at: Date.now() });
			}
		}, STRICT);
		if (read_local(id, true)?.canvas === local.canvas) {
			for (const key of local_keys(id)) localStorage.removeItem(key);
		}
		if (!aside_shown) {
			aside_shown = true;
			show_error_message("The session this tab opened had a second saved copy in the browser's older storage. Paint keeps it as a session of its own: File > Manage Storage lists both, and each one's picture there opens it.");
		}
	} catch (error) {
		log("A second copy of the session stayed in localStorage:", error);
	}
}

class LocalSession {
	constructor(session_id, fresh = false) {
		this.id = session_id;
		// Whether the page made this id a moment ago (generate_session_id()), so nothing is stored under it anywhere.
		this.fresh = fresh;
		// When the session began, by performance.now(): a field of the connection form typed in since is the player's.
		this.began = performance.now();
		// The session's own palette: a copy of the page's, so a game's slots aren't pushed into the array app.js puts back
		// at every theme load, which a later game of the tab would then start with.
		this.palette = palette = [...palette];
		// Task 7.5 and decision 7: the game this session belongs to, { seed, team, slot }, stored at its first login; the
		// restored palette, saved as stored until a login applies it, since before one the page's theme puts the default
		// palette back; the connection and the goal size its game was last logged in with, or its record's, which saves
		// write whatever the form and archipelago.js hold later, as they hold the next game's at a login into another
		// game; whether the restore is still under way, which holds saves until it lands, and whether one was asked for
		// meanwhile; whether the goal the restore loads is still loading; and whether this session's record stays as it
		// is for good, after a login into another game or a restore that didn't land.
		// A session starts as the game of the session this tab was in before it, whose canvas is still on the page. A
		// record that lands brings its own game, connection and goal size with its canvas.
		this.game = left_as.game;
		this.connection = left_as.connection;
		this.kept_colors = null;
		this.kept_final = left_as.final;
		this.restoring = true;
		this.save_asked = false;
		this.restoring_goal = false;
		this.left = false;
		this.ended = false;
		// What the restore puts on the page ahead of its canvas, to take off again if the canvas isn't coming
		// (drop_page_state()): the palette the page had before, how to let go of a goal still loading, and the address
		// made for the goal's file. And whether the canvas has landed.
		this.palette_before = null;
		this.unload_goal = null;
		this.goal_url = null;
		this.canvas_landed = false;
		this.goal_unread = false; // whether the stored goal failed to load
		// The game of the record the restore read, ahead of its canvas, and whether a login bound this session while the
		// restore was under way (join()).
		this.record_game = null;
		this.joined = false;
		// Task 7.4: where saves go, "idb" or "local", once the restore knows; the goal this session's record refers to, as
		// { sha256, blob, uri }, and whether a goal was drawn since, which the next save stores; the session a duplicated
		// tab copied; the changes asked to be saved, and how many of them the latest save that landed holds; the bytes of
		// the canvas's PNG as last stored or read; and the pacing: the save waiting, the one in flight, whether another
		// waits behind it, when the last began, and how long saves wait now.
		this.backend = null;
		this.goal = null;
		this.goal_drawn = false;
		// The seed's own goal file, drawn since the last save, from a seed that names its goal (goal.js, task 7.8): the
		// record refers to it under its SHA-256, and the next save stores it in the goals store once, with its address.
		this.seed_goal = null;
		this.copied_from = null;
		this.local_left = false;
		this.changes = 0;
		this.saved_changes = 0;
		this.png_bytes = 0;
		this.timer = null;
		this.in_flight = null;
		this.queued = false;
		this.last_save_at = -Infinity;
		this.save_every = save_every_floor();
		this.last_cost = 0;
		this.release_lock = null;
		// Whether a record under this session's id holds a canvas: one the restore brought back, or one a save stored, which
		// the message for blocked reads names (save()). And the hold on its saves while an import writes over its record
		// (import_local_session()). A page whose canvas reads were blocked holds every save until a reload (save()).
		this.has_record = false;
		this.import_hold = false;
		log(`Session record: ${session_id}`);
		this.restored = this.restore();
		$G.on("session-update.session-hook", () => {
			this.ask_save();
		});
		$G.on("save-colors.session-hook", () => {
			this.ask_save();
		});
		$G.on("restore-colors.session-hook", () => {
			palette = this.palette;
			this.kept_colors = null;
		});
		// A theme that loads puts the palette a page starts with in place (app.js, bound before this hook). After a login
		// the session's palette goes back, and the Colors box is built from it, so the next save doesn't store the
		// starting one. Before a login kept_colors holds a restored palette for the saves, and the login's restore-colors
		// puts the session's palette in place.
		$G.on("theme-load.session-hook", () => {
			if (this.game && !this.kept_colors && palette !== this.palette) {
				palette = this.palette;
				$colorbox.rebuild_palette(palette); // with no palette given, it builds the starting one
			}
		});
		$G.on("save-goal.session-hook", (_event, seed_goal) => {
			// The seed's own goal, which goal.js drew: the record takes its file, in place of a PNG of the goal canvas.
			if (seed_goal) {
				this.seed_goal = seed_goal;
				this.goal_drawn = false;
				this.ask_save();
				return;
			}
			// The goal the restore loads saves nothing: the record keeps it as stored.
			if (this.restoring_goal) {
				return;
			}
			this.seed_goal = null;
			this.goal_drawn = true;
			this.ask_save();
		});
		$G.on("save-connection-info.session-hook", () => {
			// A login into this session's game has gone through. From here its record keeps the connection and the goal
			// size as they are now.
			this.connection = connection_fields();
			this.kept_final = [final_width, final_height];
			this.ask_save();
		});
		$G.on("game-login.session-hook", (_event, game) => {
			this.join(game);
		});
		this.on_pagehide = () => this.save_at_pagehide();
		addEventListener("pagehide", this.on_pagehide);
	}
	// Holds this session's Web Lock until the session ends, so a duplicated tab, whose original holds it, knows to go on in
	// a session of its own (decision 7). Resolves to whether the session is this tab's to use. The lock is asked for with
	// ifAvailable, which the browser answers from who holds it: a wait with a time limit ran out on a page too busy to
	// hear the grant, with no tab holding the lock. While another tab holds it, it is asked for again, at 0, 1 and 2 s,
	// which a background tab's once-a-second timers don't slow. A request the browser refuses, as with site data blocked,
	// is no other tab's hold, and the tab keeps its id, as where there are no Web Locks.
	take_lock(id) {
		if (!navigator.locks?.request) {
			return Promise.resolve(true);
		}
		const ask = () => new Promise((resolve) => {
			Promise.resolve().then(() => navigator.locks.request(lock_name(id), { ifAvailable: true }, (lock) => {
				resolve(lock ? "got" : "held");
				if (!lock) {
					return;
				}
				return new Promise((release) => {
					this.release_lock = release;
					if (this.ended) release();
				});
			})).catch(() => resolve("refused"));
		});
		return (async () => {
			for (let asks = 1; ; asks++) {
				const answer = await ask();
				if (answer !== "held") {
					return true;
				}
				if (asks >= LOCK_ASKS || this.ended) {
					return false;
				}
				await new Promise((resolve) => setTimeout(resolve, LOCK_ASK_EVERY_MS));
			}
		})();
	}
	// Restores this session's record, if it has one (tasks 7.4 and 7.5): the connection fields and the palette at once,
	// then the canvas at its own size, with the record's game, and the goal for a login to draw at the game's size. A field
	// of the form the player typed in since the session began stays as typed, and once a login has bound the session the
	// whole form stays as that login left it. Saves wait for the restore, and so does Connect, until it lands, fails, or
	// takes longer than the timeout. A canvas that doesn't land leaves the record as stored, with a message, and the tab
	// goes on in a new session with the canvas, the game and the palette the page had. So does a record of another game
	// than the page has loaded. A record still in localStorage moves to IndexedDB once it lands, and one that localStorage
	// holds beside the IndexedDB record becomes a session of its own. A tab whose session another tab holds, as a
	// duplicated tab's original does, restores a copy and goes on under an id of its own. So does a tab on a page load
	// where the database didn't open, for an id whose record the database may hold. Where the database opened on this
	// page and doesn't open for the restore, the restore fails. Resolves to what the restore came to.
	restore() {
		let failure = null, found = null, unreadable = false;
		const steps = (async () => {
			const mine = await this.take_lock(this.id);
			const db = await open_db();
			// A session that ended meanwhile, as when the hash changed again, leaves the address and the page alone.
			if (this.ended) {
				return "ended";
			}
			// A later version of Paint holds the database, and this page can't read it. The page has said so (on_idb), and
			// it restores and saves nothing until it reloads: a save to localStorage would be left behind there.
			if (!db && idb_state() === "newer") {
				this.left = true;
				return "nothing stored";
			}
			// The database opened on this page before, and this open of it failed or had no answer. It may hold this id's
			// record, which a save to localStorage would stand beside, so the restore fails with a message and the tab goes
			// on under a new id. An id the page made a moment ago has nothing stored, and its session saves to localStorage.
			if (!db && idb_state() === "open" && !this.fresh) {
				throw Object.assign(new DOMException("Paint's storage didn't open this time.", "NotSupportedError"), { unopened: true });
			}
			this.backend = db ? "idb" : "local";
			// The database didn't open on this page load, and may hold this id's record. Saved to localStorage beside it,
			// this tab's canvas would never be read again: the database's record is the one a later load restores. So
			// nothing is written under the id, unless this page made the id, which the database then can't hold, or
			// localStorage already holds its record. The tab goes on under an id of its own, as a duplicated tab does,
			// with the copy it left in sessionStorage as it last closed, if it left one.
			const unread = !db && database_unopened() && !made_here.has(this.id) && !has_local_record(this.id);
			const stored_id = this.id;
			if (!mine || unread) {
				if (mine) {
					this.release_lock?.();
					this.release_lock = null;
				} else {
					this.copied_from = this.id;
				}
				this.id = generate_session_id();
				// The hash handler sees this session's own id, and keeps it.
				change_url_param("local", this.id, { replace_history_state: true });
				await this.take_lock(this.id);
			}
			found = await read_stored(stored_id, db).catch((error) => {
				unreadable = !!error?.unreadable;
				throw error;
			});
			if (this.ended) {
				return "ended";
			}
			// A duplicated tab starts with a copy of its original's sessionStorage, which it has read by now.
			if (this.copied_from) {
				drop_staged(this.copied_from);
			}
			const record = found.record;
			if (!record) {
				return "nothing stored";
			}
			// A record of another game than the page has loaded stays as stored, and nothing of it goes on the page.
			if (!opens_here(record)) {
				return "another game";
			}
			this.record_game = record.game ?? null;
			// A login that bound this session before the read has put the address it went to in the form (archipelago.js),
			// and the record's older address doesn't go over it.
			for (const name of ["host", "port", "slot"]) {
				if (record.connection?.[name] != null && !(typed_at[`ap${name}`] > this.began) && !this.joined) {
					$(`[name=ap${name}]`).val(record.connection[name]);
				}
			}
			if (Array.isArray(record.colors)) {
				this.palette_before = palette;
				this.palette = record.colors;
				this.kept_colors = record.colors;
				palette = this.palette;
			}
			this.png_bytes = record.canvas.size;
			const stored_goal = found.goal_file;
			this.goal = stored_goal ? { sha256: stored_goal.sha256, blob: stored_goal.blob, uri: stored_goal.uri ?? null, ...(stored_goal.url ? { url: stored_goal.url, width: stored_goal.width, height: stored_goal.height } : {}) } : null;
			const canvas = createImageBitmap(record.canvas, { colorSpaceConversion: "none" }).then((bitmap) => {
				record.width = bitmap.width;
				record.height = bitmap.height;
				// A canvas that lands after the restore stopped waiting for it, or after the session ended, draws nothing.
				if (this.restoring && !this.ended) {
					// A login that landed since the read has loaded a game, and the record may be another's.
					if (!opens_here(record)) {
						throw ANOTHER_GAME;
					}
					// The record's game comes with its canvas, and its connection and goal size with the game. Until the
					// canvas is on the page, the page shows the canvas of the session before, and this session keeps what
					// that one belonged to, so a restore that fails or times out leaves the tab in that game. A login that
					// bound this session while the restore was under way, to the record's game or to a record of none, keeps
					// the game, the connection and the goal size it logged in with.
					if (!this.joined) {
						this.game = record.game ?? null;
						this.connection = ["host", "port", "slot"].some((name) => record.connection?.[name] != null) ? record.connection : null;
						this.kept_final = record.final_width && record.final_height ? [record.final_width, record.final_height] : null;
					}
					this.canvas_landed = true;
					this.has_record = this.id === stored_id;
					open_session_canvas(bitmap);
					// With a seed that locks its goal loaded, the record takes that seed's goal at its next save (task 7.8).
					const seed_goal = drawn_seed_goal();
					if (seed_goal && seed_goal.sha256 !== this.goal?.sha256) {
						this.seed_goal = seed_goal;
					}
				}
			}, (error) => {
				// The record's own canvas won't decode. A copy the tab left in sessionStorage that won't decode leaves its
				// record as readable as it was.
				unreadable = found.from !== "staged";
				throw error;
			});
			// The address made for a goal's file is kept, to revoke it if the goal comes off the page again. A seed's own goal,
			// and any stored goal while a seed that locks its goal is loaded, stays off the page: the login draws the seed's
			// goal (goal.js, task 7.8), and a 4096x4096 file would be decoded for nothing.
			const shows_goal = !!this.goal && !this.goal.url && !goal_locked();
			this.goal_url = shows_goal && !this.goal.uri ? URL.createObjectURL(this.goal.blob) : null;
			const goal = shows_goal ? this.restore_goal(this.goal.uri ?? this.goal_url) : null;
			await Promise.all([canvas, goal]);
			return "restored";
		})().catch((error) => {
			if (error === ANOTHER_GAME) {
				return "another game";
			}
			failure = error;
			return "failed";
		});
		const timeout_ms = window.paint_hard_restore_timeout_ms ?? RESTORE_TIMEOUT_MS;
		let timer;
		const timed_out = new Promise((resolve) => {
			timer = setTimeout(() => resolve("timed out"), timeout_ms);
		});
		return Promise.race([steps, timed_out]).then((outcome) => {
			clearTimeout(timer);
			this.restoring = false;
			if (this.ended) {
				return outcome;
			}
			if (outcome !== "nothing stored") {
				restore_outcome = outcome;
			}
			if (outcome === "failed" || outcome === "timed out" || outcome === "another game") {
				this.left = true;
				// The record's palette and goal went onto the page ahead of its canvas, which isn't coming. The tab goes on
				// in a new session with the canvas the page shows, and they come off again.
				this.drop_page_state();
				// The message says what is known of the record: read and left as stored, read and found unreadable, or
				// not read at all, where the restore stopped before storage answered.
				const read = !!found?.record;
				show_error_message(outcome === "timed out" ?
					(read ?
						`Paint stopped waiting for this tab's canvas to come back from storage after ${timeout_ms / 1000} s. The stored copy stays as it is, under File > Manage Storage, and this tab goes on in a new session.` :
						`Paint stopped waiting for its storage to answer after ${timeout_ms / 1000} s. Anything stored for this tab stays as it is, under File > Manage Storage, and this tab goes on in a new session.`) :
					outcome === "another game" ?
						"This tab has a game loaded, and the session at that address belongs to another game. It wasn't opened here: its saved canvas stays as it is, under File > Manage Storage, and this tab goes on in a new session. Open that session in a tab of its own." :
						unreadable ?
							"Paint couldn't restore this tab's canvas: what is stored for it can't be read. Its record stays listed under File > Manage Storage, where Remove takes it away, and this tab goes on in a new session." :
							read ?
								"Paint couldn't restore this tab's canvas from storage. The stored copy stays as it is, under File > Manage Storage, and this tab goes on in a new session." :
								failure?.unopened ?
									"Paint couldn't restore this tab's canvas: its storage didn't open this time. Anything stored for this tab stays as it is, under File > Manage Storage, and this tab goes on in a new session." :
									"Paint couldn't restore this tab's canvas: its storage gave an error. Anything stored for this tab stays as it is, under File > Manage Storage, and this tab goes on in a new session.",
					failure);
				change_url_param("local", generate_session_id(), { replace_history_state: true });
				return outcome;
			}
			// The goal's own failure is said only beside a canvas that came back: a restore that failed has said so.
			if (outcome === "restored" && this.goal_unread) {
				show_error_message("This session's goal image didn't come back from storage. The seed's own goal loads when you connect.");
			}
			// The address made for the stored goal's file goes once the goal image has loaded another. Until then a login
			// sets the same address again.
			if (outcome === "restored" && this.goal_url) {
				revoke_when_replaced(this.goal_url);
			}
			if (outcome === "restored" && found.beside && this.backend === "idb") {
				set_aside(this.copied_from ?? this.id, found.beside);
			}
			if (this.backend === "idb") {
				sweep_staged(this.id).catch(() => { });
			}
			if (outcome === "restored" && found.in_local) {
				this.local_left = true;
				if (found.from === "local" && this.backend === "idb" && !this.copied_from) {
					this.migrate(found.record, found.goal_file);
				}
			}
			// A copy saves under its own id at once, and a copy staged as the tab closed goes into IndexedDB.
			if (this.copied_from || (outcome === "restored" && found.from === "staged")) {
				this.changes++;
				this.save_asked = true;
			}
			if (this.save_asked) {
				this.save_asked = false;
				this.schedule();
			}
			return outcome;
		});
	}
	// Copies a record that localStorage kept into IndexedDB, as it was stored, and removes its localStorage keys only once
	// that has committed, so a failed copy loses nothing.
	migrate(record, goal_file) {
		const copy = { ...record, saved_at: Date.now() };
		transact(["sessions", "goals"], "readwrite", ({ sessions, goals }) => {
			sessions.put(copy);
			if (goal_file) {
				goals.put({ sha256: goal_file.sha256, blob: goal_file.blob, width: null, height: null, used_at: Date.now() });
			}
		}, STRICT).then(() => {
			stored_in_idb = true;
			this.drop_local_keys();
		}, (error) => this.save_failed(error));
	}
	drop_local_keys() {
		if (!this.local_left) {
			return;
		}
		try {
			for (const key of local_keys(this.id)) localStorage.removeItem(key);
			this.local_left = false;
		} catch (_error) { /* site data blocked since */ }
	}
	// Takes off the page what this session's restore put there ahead of its canvas, where the canvas isn't coming: the
	// restore failed or timed out, the record is another game's, or the session ended first. The palette the page had goes
	// back, and the goal image lets go of the stored goal, so the next login draws its own and counts its own palette
	// slots. Where the canvas did land, its palette stays with it, and only a goal still loading goes.
	drop_page_state() {
		if (this.palette_before && !this.canvas_landed) {
			palette = this.palette_before;
		}
		this.palette_before = null;
		if (this.unload_goal) {
			this.unload_goal();
		} else if (this.goal && !this.canvas_landed) {
			$goal_image.removeAttr("src");
		} else {
			return;
		}
		if (this.goal_url) {
			URL.revokeObjectURL(this.goal_url);
			this.goal_url = null;
		}
	}
	// Loads the stored goal into the goal image, for the page to show and for a login to draw at the game's size. Its load
	// saves nothing. A goal that doesn't load gives way to the seed's own goal at the login, and the restore says so
	// once its canvas has landed.
	restore_goal(uri) {
		this.restoring_goal = true;
		const image = $goal_image[0];
		return new Promise((resolve) => {
			const settle = () => {
				image.removeEventListener("load", landed);
				image.removeEventListener("error", landed);
				this.unload_goal = null;
				this.restoring_goal = false;
				resolve();
			};
			const landed = (event) => {
				settle();
				if (event.type === "error") {
					$goal_image.removeAttr("src");
					this.goal_unread = true;
				}
			};
			// Lets go of a goal still loading: it draws nothing, and its listener goes too. Left on, the listener would
			// answer the next login's goal load, and take an error there for this session's goal.
			this.unload_goal = () => {
				settle();
				$goal_image.removeAttr("src");
			};
			image.addEventListener("load", landed);
			image.addEventListener("error", landed);
			$goal_image.attr("src", uri);
		});
	}
	// Everything a record holds but its canvas, as it is now.
	fields() {
		return {
			id: this.id,
			version: 2,
			width: main_canvas.width,
			height: main_canvas.height,
			final_width: this.kept_final?.[0] ?? final_width,
			final_height: this.kept_final?.[1] ?? final_height,
			goal: this.goal?.sha256 ?? null,
			colors: [...(this.kept_colors ?? palette)],
			connection: this.connection ?? connection_fields(),
			game: this.game,
			saved_at: Date.now(),
		};
	}
	ask_save() {
		if (this.left || this.ended) {
			return;
		}
		this.changes++;
		if (this.restoring) {
			this.save_asked = true;
			return;
		}
		this.schedule();
	}
	schedule() {
		if (this.timer || this.left || this.ended) {
			return;
		}
		if (this.in_flight) {
			this.queued = true;
			return;
		}
		const wait = Math.max(100, this.last_save_at + this.save_every - performance.now());
		this.timer = setTimeout(() => {
			this.timer = null;
			this.save();
		}, wait);
	}
	// Saves the session now, unless canvas reads are blocked, or were at any point since the page loaded (auto-copy.js's
	// canvas_tainted(), which probes at each ask while the page counts as clean). A blocked read's PNG comes out blank,
	// and what the page read and wrote back onto the canvas while reads were blocked, as an undo or an Undo Trap does, is
	// the browser's placeholder, which stays on the canvas once reads are allowed. A save would store either over the
	// session's record, or as a record where there was none. So no session saves on such a page, and a reload restores
	// the last save, or a blank canvas where nothing was stored. While reads are blocked the page says once that it can't
	// save, and once they are allowed it says to reload (canvas-reads-allowed). A last save, as the session ends, goes
	// even with another in flight.
	save({ last = false } = {}) {
		if (this.left || this.import_hold || (this.ended && !last)) {
			return Promise.resolve();
		}
		if (canvas_tainted()) {
			if (reads_are_blocked()) {
				say_blocked(this.has_record ?
					"Your browser blocks reading the canvas, so Paint can't save this tab's canvas. Its last save stays as it is, and what you paint before a reload isn't saved. Allow canvas reads for this site, then reload this tab to go on from that save. Paint sends no checks until then." :
					"Your browser blocks reading the canvas, so what you paint before a reload isn't saved. Allow canvas reads for this site, then reload this tab. Paint sends no checks until then.");
			}
			return Promise.resolve();
		}
		if (this.in_flight && !last) {
			this.queued = true;
			return this.in_flight;
		}
		this.last_save_at = performance.now();
		const changes = this.changes;
		const flight = (this.backend === "idb" ? this.write_idb(this.in_flight) : this.write_local()).then(() => {
			this.saved_changes = Math.max(this.saved_changes, changes);
			this.has_record = true;
			failure_shown = false;
			drop_staged(this.id);
			if (this.backend === "idb") {
				stored_in_idb = true;
				if (persistence.wanted) ask_persistence();
				this.drop_local_keys();
			}
		}, (error) => this.save_failed(error)).finally(() => {
			if (this.in_flight === flight) {
				this.in_flight = null;
			}
			if (this.queued && !this.ended) {
				this.queued = false;
				this.schedule();
			}
		});
		this.in_flight = flight;
		return flight;
	}
	save_failed(error) {
		const kind = error_kind(error);
		log("Session save failed:", kind, error);
		if (kind === "closed" && !this.ended) {
			// The database closed under this save a second time, where transact() had opened it again once, or Firefox
			// handed the save the transaction that follows a refused one, whose put throws: the next save tries again.
			this.queued = true;
			return;
		}
		if (kind === "newer" || failure_shown) {
			return; // said once already
		}
		failure_shown = true;
		if (kind === "quota") {
			storage_quota_exceeded();
		} else {
			show_error_message("Paint couldn't save this tab's canvas to the browser's storage. The last save stays as it is. File > Save keeps the picture as a file meanwhile.", error);
		}
	}
	// Holds this session's saves while an import writes its record, so none lands over the file. A change that waits goes
	// out first, after the save in flight, with the pixels auto copy and M painted since they last asked. While the hold
	// lasts, neither the session's end nor a login into another game saves, so a session that ends then loses only what
	// was painted during the hold. The saves asked for meanwhile wait. Resolves once the saves from before the hold have
	// landed or failed.
	hold_saves() {
		clearTimeout(this.timer);
		this.timer = null;
		const flushed = this.changes > this.saved_changes || copies_unsaved() ? this.save({ last: true }) : this.in_flight;
		this.import_hold = true;
		return Promise.resolve(flushed);
	}
	// Lets the saves go on after an import that didn't land, and saves a change that waits.
	release_saves() {
		this.import_hold = false;
		if (this.changes > this.saved_changes) {
			this.schedule();
		}
	}
	// One save to IndexedDB. What it stores is taken as it begins: the record's fields, and the canvas, and the goal when
	// one was drawn since, as toBlob copies them before it answers, so what the page does next, a later session's
	// restore among it, isn't in the record. The browser makes the PNGs after the call returns, then one transaction puts
	// the record and the goal, after the record of `before`, a save still in flight. A goal no session refers to any more
	// goes with it. A seed's own goal file goes in a transaction of its own once the record has landed (store_seed_file()).
	// Once the transactions have committed, the page closes its connection to the database, and the next use opens it
	// again: Firefox keeps the file of the canvas this save replaced until then. The time the save held the page, in its
	// own calls and in the long tasks that made its PNGs, sets how long the next waits.
	async write_idb(before = null) {
		const began = performance.now();
		const fields = this.fields();
		const canvas = png_of(main_canvas);
		const redrawn = this.goal_drawn;
		const goal_png = redrawn ? png_of(goal_canvas) : null;
		const goal_size = { width: goal_canvas.width, height: goal_canvas.height };
		const seed = this.seed_goal;
		this.goal_drawn = false;
		this.seed_goal = null;
		const cost = performance.now() - began;
		let goal = null;
		try {
			const { blob, called, came } = await canvas;
			const pngs = [{ called, came }];
			if (goal_png) {
				const file = await goal_png;
				pngs.push({ called: file.called, came: file.came });
				goal = { sha256: await goal_key_of(file.blob, this.id), blob: file.blob, uri: null, ...goal_size };
			} else if (seed) {
				goal = { sha256: seed.sha256, blob: seed.blob, uri: null, width: seed.width, height: seed.height, url: seed.url };
			}
			await Promise.resolve(before).catch(() => { });
			const old_goal = this.goal?.sha256 ?? null;
			const kept = goal ?? this.goal;
			const record = { ...fields, canvas: blob, goal: kept?.sha256 ?? null };
			await transact(["sessions", "goals"], "readwrite", async ({ sessions, goals }) => {
				sessions.put(record);
				// A seed's own goal file, which has its address, goes in a transaction of its own once this one has landed
				// (store_seed_file()).
				if (goal && !goal.url) {
					goals.put({ sha256: goal.sha256, blob: goal.blob, width: goal.width, height: goal.height, used_at: Date.now() });
				} else if (kept && !kept.url && !(await request_of(goals.count(kept.sha256)))) {
					// Removed in another tab's Manage Storage while this page went on with it. A seed's goal comes back only from
					// goal.js's next draw, which checks it.
					goals.put({ sha256: kept.sha256, blob: kept.blob, width: null, height: null, used_at: Date.now() });
				}
				if (old_goal && old_goal !== record.goal && !(await request_of(sessions.index("goal").count(old_goal)))) {
					goals.delete(old_goal);
				}
			}, STRICT);
			close_db();
			if (goal) this.goal = goal;
			this.png_bytes = blob.size;
			// The save's own calls, and the long tasks that made its PNGs. Those have ended and been reported by now, some
			// tasks after the PNGs came.
			this.last_cost = cost + long_task_time(pngs);
		} catch (error) {
			if (redrawn) this.goal_drawn = true;
			if (seed) this.seed_goal ??= seed;
			throw error;
		}
		if (goal?.url) await store_seed_file(goal);
		this.save_every = save_every_after(this.last_cost);
	}
	// One save to localStorage, where IndexedDB isn't available: the JSON record from before task 7.4, the canvas and the
	// goal as data URLs.
	write_local() {
		const began = performance.now();
		// A seed's own goal isn't kept here: at 4096x4096 its data URL would pass localStorage's room many times over, and
		// the login loads it again (task 7.8).
		if (this.seed_goal) {
			this.seed_goal = null;
			this.goal = null;
		}
		let goal = this.goal?.uri ?? null;
		if (this.goal_drawn) {
			this.goal_drawn = false;
			goal = goal_canvas.toDataURL("image/png");
			this.goal = { sha256: null, blob: null, uri: goal };
		}
		const data = JSON.stringify({
			canvas: main_canvas.toDataURL("image/png"),
			goal,
			connection_info: this.connection ?? connection_fields(),
			colors: this.kept_colors ?? palette,
			game: this.game,
		});
		return new Promise((resolve, reject) => {
			save_image_to_storage(`image#${this.id}`, data, (err) => {
				this.last_cost = performance.now() - began;
				this.save_every = save_every_after(this.last_cost);
				// The Storage Error box has shown, as it did before task 7.4.
				if (err) {
					failure_shown = true;
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}
	// As the page goes, a change not yet saved goes out at once, as best it can: a toDataURL, and the record with it to
	// sessionStorage, for the tab's next load, in the room of the copies this tab left for earlier sessions if it has to
	// (stage()). A data URL is 4 characters for each 3 bytes of the PNG. With localStorage, an ordinary save, which
	// lands. Auto copy and M ask for a save at most every 5 s, so pixels they painted since count as a change too: the
	// session asks them as it looks, whichever pagehide listener runs first. A session whose saves are held leaves no copy.
	save_at_pagehide() {
		if (this.left || this.ended || this.restoring || this.import_hold || (this.changes <= this.saved_changes && !copies_unsaved())) {
			return;
		}
		if (canvas_tainted() || main_canvas.width * main_canvas.height > UNLOAD_SAVE_PIXELS) {
			return;
		}
		try {
			if (this.backend !== "idb") {
				this.write_local().catch(() => { });
				return;
			}
			if (this.png_bytes * 4 / 3 > UNLOAD_SAVE_CHARS) {
				return;
			}
			const text = JSON.stringify({ ...this.fields(), canvas: main_canvas.toDataURL("image/png") });
			if (text.length <= UNLOAD_SAVE_CHARS) {
				stage(this.id, text);
			}
		} catch (error) {
			log("The save as the page went failed:", error);
		}
	}
	// A session belongs to the game its first login names (decision 7). A login into another game leaves this session's
	// record behind, and the tab goes on in a new session with a blank canvas, the seed's own goal and the palette a page
	// starts with, so no canvas, goal or palette slot of the old game carries into the new one. A message says where the
	// old game's canvas stays.
	join(game) {
		// A record still restoring that belongs to another game than this login's is turned away as its canvas lands
		// (restore()). What its restore put on the page ahead of its canvas comes off now, before the login draws its goal
		// and takes this session's palette.
		if (this.restoring && this.record_game && !same_game(this.record_game, game)) {
			this.drop_page_state();
			this.goal = null;
			this.palette = palette = [...palette];
			this.kept_colors = null;
		}
		if (!this.game) {
			this.game = game;
			this.joined ||= this.restoring;
			return;
		}
		if (same_game(this.game, game)) {
			this.joined ||= this.restoring;
			return;
		}
		// A change still waiting for its save goes out first, as a session's end saves one, with the pixels auto copy and
		// M painted since they last asked. The canvas, the goal and the palette are still the old game's here, and the
		// record keeps this session's own connection and goal size, where the form and archipelago.js already hold the
		// new game's. A record that was up to date stays as it is. Nothing is saved while this session's restore is under
		// way: the canvas on the page isn't its own yet, and end() saves nothing then either.
		if (!this.restoring && (this.changes > this.saved_changes || copies_unsaved())) {
			this.save({ last: true });
		}
		const stored = this.png_bytes > 0 || this.saved_changes > 0 || !!this.in_flight;
		const slot = this.connection?.slot;
		this.left = true;
		clearTimeout(this.timer);
		this.timer = null;
		// A restore still under way lets go of the page first, or its palette would go back over the fresh one below.
		if (this.restoring) {
			this.drop_page_state();
		}
		palette = [...fresh_palette];
		$goal_image.removeAttr("src");
		reset_canvas_and_history();
		change_url_param("local", generate_session_id(), { replace_history_state: true });
		if (current_session instanceof LocalSession) {
			// The new session is the new game's. The login's save-connection-info gives it its connection and goal size.
			current_session.game = game;
			current_session.connection = null;
			current_session.kept_final = null;
		}
		if (stored) {
			say_left(slot);
		}
	}
	// The session as a .appaint file holds it: the canvas and goal as data URLs, the connection without its password, the
	// palette and the game.
	async collect_session_data() {
		const goal = !this.goal || this.goal_drawn ? goal_canvas.toDataURL("image/png") : (this.goal.uri ?? await data_url_of(this.goal.blob));
		return JSON.stringify({
			canvas: main_canvas.toDataURL("image/png"),
			goal,
			connection_info: this.connection ?? connection_fields(),
			colors: this.kept_colors ?? palette,
			game: this.game,
		});
	}
	// Ends the session, with a last save at once where a change waits for one, and lets go of its lock once its saves have
	// landed. Resolves then. A session with nothing new to save leaves its record as it is, and one that never changed
	// leaves none. A session that left for another game saved in join(), and its lock waits for that save.
	end() {
		clearTimeout(this.timer);
		this.timer = null;
		const unsaved = !this.restoring && !this.left && (this.changes > this.saved_changes || copies_unsaved());
		const last = unsaved ? this.save({ last: true }) : Promise.resolve(this.in_flight);
		// A session that ends while its restore is under way, as when the address changes again, takes its palette and its
		// goal off the page: its canvas isn't coming.
		if (this.restoring) {
			this.drop_page_state();
		}
		this.ended = true;
		// Remove session-related hooks
		$G.off(".session-hook");
		removeEventListener("pagehide", this.on_pagehide);
		return last.finally(() => {
			this.release_lock?.();
		});
	}
}


// The user ID is not persistent
// A person can enter a session multiple times,
// and is always given a new user ID
let user_id;
// @TODO: I could make the color persistent, though.
// You could still have multiple cursors and they would just be the same color.
// There could also be an option to change your color

// The data in this object is stored in the server when you enter a session
// It is (supposed to be) removed when you leave
const user = {
	// Cursor status
	cursor: {
		// cursor position in canvas coordinates
		x: 0,
		y: 0,
		// whether the user is elsewhere, such as in another tab
		away: true,
	},
	// Currently selected tool (@TODO)
	tool: localize("Pencil"),
	// Color components
	hue: ~~(Math.random() * 360),
	saturation: ~~(Math.random() * 50) + 50,
	lightness: ~~(Math.random() * 40) + 50,
};

// The main cursor color
user.color = `hsla(${user.hue}, ${user.saturation}%, ${user.lightness}%, 1)`;
// Unused
user.color_transparent = `hsla(${user.hue}, ${user.saturation}%, ${user.lightness}%, 0.5)`;
// (@TODO) The color (that may be) used in the toolbar indicating to other users it is selected by this user
user.color_desaturated = `hsla(${user.hue}, ${~~(user.saturation * 0.4)}%, ${user.lightness}%, 0.8)`;


// The image used for other people's cursors
const cursor_image = new Image();
cursor_image.src = "images/cursors/default.png";


class FirebaseSession {
	constructor(session_id) {
		this.id = session_id;
		this._fb_listeners = [];

		file_name = `[Loading ${this.id}]`;
		update_title();
		const on_firebase_loaded = () => {
			file_name = `[${this.id}]`;
			update_title();
			this.start();
		};
		if (!FirebaseSession.fb_root) {
			var script = document.createElement("script");
			script.addEventListener("load", () => {
				const config = {
					apiKey: "AIzaSyBgau8Vu9ZE8u_j0rp-Lc044gYTX5O3X9k",
					authDomain: "jspaint.firebaseapp.com",
					databaseURL: "https://jspaint.firebaseio.com",
					projectId: "firebase-jspaint",
					storageBucket: "",
					messagingSenderId: "63395010995",
				};
				firebase.initializeApp(config);
				FirebaseSession.fb_root = firebase.database().ref("/");
				on_firebase_loaded();
			});
			script.addEventListener("error", () => {
				show_error_message("Failed to load Firebase; the document will not load, and changes will not be saved.");
				file_name = `[Failed to load ${this.id}]`;
				update_title();
			});
			script.src = "lib/firebase.js";
			document.head.appendChild(script);
		} else {
			on_firebase_loaded();
		}
	}
	start() {
		// @TODO: how do you actually detect if it's failing???
		showMessageBox({
			messageHTML: `
				<p>The document may not load. Changes may not save.</p>
				<p>Multiuser sessions are public. There is no security.</p>
			`,
		});
		// "<p>The document may not load. Changes may not save. If it does save, it's public. There is no security.</p>"// +
		// "<p>I haven't found a way to detect Firebase quota limits being exceeded, " +
		// "so for now I'm showing this message regardless of whether it's working.</p>" +
		// "<p>If you're interested in using multiuser mode, please thumbs-up " +
		// "<a href='https://github.com/1j01/jspaint/issues/68'>this issue</a> to show interest, and/or subscribe for updates.</p>"

		// Wrap the Firebase API because they don't
		// provide a great way to clean up event listeners
		const _fb_on = (fb, event_type, callback, error_callback) => {
			this._fb_listeners.push({ fb, event_type, callback, error_callback });
			fb.on(event_type, callback, error_callback);
		};
		// Get Firebase references
		this.fb = FirebaseSession.fb_root.child(this.id);
		this.fb_data = this.fb.child("data");
		this.fb_users = this.fb.child("users");
		if (user_id) {
			this.fb_user = this.fb_users.child(user_id);
		} else {
			this.fb_user = this.fb_users.push();
			user_id = this.fb_user.key;
		}
		// Remove the user from the session when they disconnect
		this.fb_user.onDisconnect().remove();
		// Make the user present in the session
		this.fb_user.set(user);
		// @TODO: Execute the above two lines when .info/connected
		// For each existing and new user
		_fb_on(this.fb_users, "child_added", (snap) => {
			// Is this you?
			if (snap.key === user_id) {
				// You already have a cursor.
				return;
			}
			// Get the Firebase reference for this user
			const fb_other_user = snap.ref;
			// Get the user object stored on the server
			let other_user = snap.val();
			// @TODO: display other cursor types?
			// @TODO: display pointer button state?
			// @TODO: display selections
			const cursor_canvas = make_canvas(32, 32);
			// Make the cursor element
			const $cursor = $(cursor_canvas).addClass("user-cursor").appendTo($app);
			$cursor.css({
				display: "none",
				position: "absolute",
				left: 0,
				top: 0,
				opacity: 0,
				zIndex: 5, // @#: z-index
				pointerEvents: "none",
				transition: "opacity 0.5s",
			});
			// When the cursor data changes
			_fb_on(fb_other_user, "value", (snap) => {
				other_user = snap.val();
				// If the user has left
				if (other_user == null) {
					// Remove the cursor element
					$cursor.remove();
				} else {
					// Draw the cursor
					const draw_cursor = () => {
						cursor_canvas.width = cursor_image.width;
						cursor_canvas.height = cursor_image.height;
						const cursor_ctx = cursor_canvas.ctx;
						cursor_ctx.fillStyle = other_user.color;
						cursor_ctx.fillRect(0, 0, cursor_canvas.width, cursor_canvas.height);
						cursor_ctx.globalCompositeOperation = "multiply";
						cursor_ctx.drawImage(cursor_image, 0, 0);
						cursor_ctx.globalCompositeOperation = "destination-atop";
						cursor_ctx.drawImage(cursor_image, 0, 0);
					};
					if (cursor_image.complete) {
						draw_cursor();
					} else {
						$(cursor_image).one("load", draw_cursor);
					}
					// Update the cursor element
					const canvas_rect = window.canvas_bounding_client_rect;
					$cursor.css({
						display: "block",
						position: "absolute",
						left: canvas_rect.left + magnification * other_user.cursor.x,
						top: canvas_rect.top + magnification * other_user.cursor.y,
						opacity: 1 - other_user.cursor.away,
					});
				}
			});
		});
		let previous_uri;
		// let pointer_operations = []; // the multiplayer syncing stuff is a can of worms, so this is disabled
		this.write_canvas_to_database_immediately = () => {
			const save_paused = handle_data_loss();
			if (save_paused) {
				return;
			}
			// Sync the data from this client to the server (one-way)
			const uri = main_canvas.toDataURL();
			if (previous_uri !== uri) {
				// log("clear pointer operations to set data", pointer_operations);
				// pointer_operations = [];
				log("Write canvas data to Firebase");
				this.fb_data.set(uri);
				previous_uri = uri;
			} else {
				log("(Don't write canvas data to Firebase; it hasn't changed)");
			}
		};
		this.write_canvas_to_database_soon = debounce(this.write_canvas_to_database_immediately, 100);
		let ignore_session_update = false;
		$G.on("session-update.session-hook", () => {
			if (ignore_session_update) {
				log("(Ignore session-update from Sync Session undoable)");
				return;
			}
			this.write_canvas_to_database_soon();
		});
		// Any time we change or receive the image data
		_fb_on(this.fb_data, "value", (snap) => {
			log("Firebase data update");
			const uri = snap.val();
			if (uri == null) {
				// If there's no value at the data location, this is a new session
				// Sync the current data to it
				this.write_canvas_to_database_soon();
			} else {
				previous_uri = uri;
				// Load the new image data
				const img = new Image();
				img.onload = () => {
					// Cancel any in-progress pointer operations
					// if (pointer_operations.length) {
					// 	$G.triggerHandler("pointerup", "cancel");
					// }

					const test_canvas = make_canvas(img);
					const image_data_remote = test_canvas.ctx.getImageData(0, 0, test_canvas.width, test_canvas.height);
					const image_data_local = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);

					if (!image_data_match(image_data_remote, image_data_local, 5)) {
						ignore_session_update = true;
						undoable({
							name: "Sync Session",
							icon: get_help_folder_icon("p_database.png"),
						}, () => {
							// Write the image data to the canvas
							main_ctx.copy(img);
							$canvas_area.trigger("resize");
						});
						ignore_session_update = false;
					}

					// (transparency = has_any_transparency(main_ctx); here would not be ideal
					// Perhaps a better way of syncing transparency
					// and other options will be established)
					/*
					// Playback recorded in-progress pointer operations
					log("Playback", pointer_operations);

					for (const e of pointer_operations) {
						// Trigger the event at each place it is listened for
						$canvas.triggerHandler(e, ["synthetic"]);
						$G.triggerHandler(e, ["synthetic"]);
					}
					*/
				};
				img.src = uri;
			}
		}, (error) => {
			show_error_message("Failed to retrieve data from Firebase. The document will not load, and changes will not be saved.", error);
			file_name = `[Failed to load ${this.id}]`;
			update_title();
		});
		// Update the cursor status
		$G.on("pointermove.session-hook", (e) => {
			const m = to_canvas_coords(e);
			this.fb_user.child("cursor").update({
				x: m.x,
				y: m.y,
				away: false,
			});
		});
		$G.on("blur.session-hook", () => {
			this.fb_user.child("cursor").update({
				away: true,
			});
		});
		// @FIXME: the cursor can come back from "away" via a pointer event
		// while the window is blurred and stay there when the user goes away
		// maybe replace "away" with a timestamp of activity and then
		// clients can decide whether a given cursor should be visible

		/*
		const debug_event = (e, synthetic) => {
			// const label = synthetic ? "(synthetic)" : "(normal)";
			// window.console?.debug?.debug(e.type, label);
		};

		$canvas_area.on("pointerdown.session-hook", "*", (e, synthetic) => {
			debug_event(e, synthetic);
			if (synthetic) { return; }

			pointer_operations = [e];
			const pointermove = (e, synthetic) => {
				debug_event(e, synthetic);
				if (synthetic) { return; }

				pointer_operations.push(e);
			};
			$G.on("pointermove.session-hook", pointermove);
			$G.one("pointerup.session-hook", (e, synthetic) => {
				debug_event(e, synthetic);
				if (synthetic) { return; }

				$G.off("pointermove.session-hook", pointermove);
			});
		});
		*/
	}
	end() {
		// Skip debounce and save immediately
		this.write_canvas_to_database_soon.cancel();
		this.write_canvas_to_database_immediately();
		// Remove session-related hooks
		$G.off(".session-hook");
		// $canvas_area.off("pointerdown.session-hook");
		// Remove collected Firebase event listeners
		this._fb_listeners.forEach(({ fb, event_type, callback, _error_callback }) => {
			log(`Remove listener for ${fb.path.toString()} .on ${event_type}`);
			fb.off(event_type, callback);
		});
		this._fb_listeners.length = 0;
		// Remove the user from the session
		this.fb_user.remove();
		// Remove any cursor elements
		$app.find(".user-cursor").remove();
		// Reset to "untitled"
		reset_file();
	}
}

/**
 * fb_root is the root reference for the Firebase Realtime Database
 * @memberof FirebaseSession
 * @type {any} - @TODO: install types for Firebase or ditch Firebase
 */
FirebaseSession.fb_root = null;


// class WebSocketSession {
// 	constructor(session_id) {
// 		this.id = session_id;
// 		this._listeners = [];

// 		// this.ws = new WebSocket(`wss://${location.host}/api/sessions/${this.id}`);
// 		this.ws = new WebSocket(`ws://${location.host}/api/session`);

// 		file_name = `[${this.id}]`;
// 		update_title();
// 		this.start();
// 	}
// 	start() {
// 		this.ws.addEventListener("open", () => {
// 			this.ws.send(JSON.stringify({
// 				type: "join",
// 				user,
// 				session_id: this.id,
// 			}));
// 		});

// 		this.ws.addEventListener("message", e => {
// 			const data = JSON.parse(e.data);
// 			if (data.type === "image") {
// 				// TODO: transfer as binary data
// 				const img = new Image();
// 				img.onload = () => {
// 					undoable({
// 						name: "Sync Session",
// 						icon: get_help_folder_icon("p_database.png"),
// 					}, () => {
// 						main_ctx.copy(img);
// 						$canvas_area.trigger("resize");
// 					});
// 				};
// 				img.src = data.uri;
// 			} else if (data.type === "cursor") {
// 				const cursor_canvas = make_canvas(32, 32);
// 				const $cursor = $(cursor_canvas).addClass("user-cursor").appendTo($app);
// 				$cursor.css({
// 					display: "none",
// 					position: "absolute",
// 					left: 0,
// 					top: 0,
// 					opacity: 0,
// 					zIndex: 5, // @#: z-index
// 					pointerEvents: "none",
// 					transition: "opacity 0.5s",
// 				});
// 				const draw_cursor = () => {
// 					cursor_canvas.width = cursor_image.width;
// 					cursor_canvas.height = cursor_image.height;
// 					const cursor_ctx = cursor_canvas.ctx;
// 					cursor_ctx.fillStyle = data.color;
// 					cursor_ctx.fillRect(0, 0, cursor_canvas.width, cursor_canvas.height);
// 					cursor_ctx.globalCompositeOperation = "multiply";
// 					cursor_ctx.drawImage(cursor_image, 0, 0);
// 					cursor_ctx.globalCompositeOperation = "destination-atop";
// 					cursor_ctx.drawImage(cursor_image, 0, 0);
// 				};
// 				if (cursor_image.complete) {
// 					draw_cursor();
// 				}
// 				else {
// 					$(cursor_image).one("load", draw_cursor);
// 				}
// 				// Update the cursor element
// 				const canvas_rect = window.canvas_bounding_client_rect;
// 				$cursor.css({
// 					display: "block",
// 					position: "absolute",
// 					left: canvas_rect.left + magnification * data.x,
// 					top: canvas_rect.top + magnification * data.y,
// 					opacity: 1 - data.away,
// 				});
// 			} else {
// 				console.warn("Unknown message type", data.type);
// 			}
// 		});


// 		// // For each existing and new user
// 		// _fb_on(this.fb_users, "child_added", snap => {
// 		// 	// Is this you?
// 		// 	if (snap.key === user_id) {
// 		// 		// You already have a cursor.
// 		// 		return;
// 		// 	}
// 		// 	// Get the Firebase reference for this user
// 		// 	const fb_other_user = snap.ref;
// 		// 	// Get the user object stored on the server
// 		// 	let other_user = snap.val();
// 		// 	// @TODO: display other cursor types?
// 		// 	// @TODO: display pointer button state?
// 		// 	// @TODO: display selections
// 		// 	const cursor_canvas = make_canvas(32, 32);
// 		// 	// Make the cursor element
// 		// 	const $cursor = $(cursor_canvas).addClass("user-cursor").appendTo($app);
// 		// 	$cursor.css({
// 		// 		display: "none",
// 		// 		position: "absolute",
// 		// 		left: 0,
// 		// 		top: 0,
// 		// 		opacity: 0,
// 		// 		zIndex: 5, // @#: z-index
// 		// 		pointerEvents: "none",
// 		// 		transition: "opacity 0.5s",
// 		// 	});
// 		// 	// When the cursor data changes
// 		// 	_fb_on(fb_other_user, "value", snap => {
// 		// 		other_user = snap.val();
// 		// 		// If the user has left
// 		// 		if (other_user == null) {
// 		// 			// Remove the cursor element
// 		// 			$cursor.remove();
// 		// 		}
// 		// 		else {
// 		// 			// Draw the cursor
// 		// 			const draw_cursor = () => {
// 		// 				cursor_canvas.width = cursor_image.width;
// 		// 				cursor_canvas.height = cursor_image.height;
// 		// 				const cursor_ctx = cursor_canvas.ctx;
// 		// 				cursor_ctx.fillStyle = other_user.color;
// 		// 				cursor_ctx.fillRect(0, 0, cursor_canvas.width, cursor_canvas.height);
// 		// 				cursor_ctx.globalCompositeOperation = "multiply";
// 		// 				cursor_ctx.drawImage(cursor_image, 0, 0);
// 		// 				cursor_ctx.globalCompositeOperation = "destination-atop";
// 		// 				cursor_ctx.drawImage(cursor_image, 0, 0);
// 		// 			};
// 		// 			if (cursor_image.complete) {
// 		// 				draw_cursor();
// 		// 			}
// 		// 			else {
// 		// 				$(cursor_image).one("load", draw_cursor);
// 		// 			}
// 		// 			// Update the cursor element
// 		// 			const canvas_rect = window.canvas_bounding_client_rect;
// 		// $cursor.css({
// 		// 				display: "block",
// 		// 				position: "absolute",
// 		// 				left: canvas_rect.left + magnification * other_user.cursor.x,
// 		// 				top: canvas_rect.top + magnification * other_user.cursor.y,
// 		// 				opacity: 1 - other_user.cursor.away,
// 		// 			});
// 		// 		}
// 		// 	});
// 		// });
// 		// let previous_uri;
// 		// // let pointer_operations = []; // the multiplayer syncing stuff is a can of worms, so this is disabled
// 		// this.write_canvas_to_database_immediately = () => {
// 		// 	const save_paused = handle_data_loss();
// 		// 	if (save_paused) {
// 		// 		return;
// 		// 	}
// 		// 	// Sync the data from this client to the server (one-way)
// 		// 	const uri = main_canvas.toDataURL();
// 		// 	if (previous_uri !== uri) {
// 		// 		// log("clear pointer operations to set data", pointer_operations);
// 		// 		// pointer_operations = [];
// 		// 		log("Write canvas data to Firebase");
// 		// 		this.fb_data.set(uri);
// 		// 		previous_uri = uri;
// 		// 	}
// 		// 	else {
// 		// 		log("(Don't write canvas data to Firebase; it hasn't changed)");
// 		// 	}
// 		// };
// 		// this.write_canvas_to_database_soon = debounce(this.write_canvas_to_database_immediately, 100);
// 		// let ignore_session_update = false;
// 		// $G.on("session-update.session-hook", () => {
// 		// 	if (ignore_session_update) {
// 		// 		log("(Ignore session-update from Sync Session undoable)");
// 		// 		return;
// 		// 	}
// 		// 	this.write_canvas_to_database_soon();
// 		// });
// 		// // Any time we change or receive the image data
// 		// _fb_on(this.fb_data, "value", snap => {
// 		// 	log("Firebase data update");
// 		// 	const uri = snap.val();
// 		// 	if (uri == null) {
// 		// 		// If there's no value at the data location, this is a new session
// 		// 		// Sync the current data to it
// 		// 		this.write_canvas_to_database_soon();
// 		// 	}
// 		// 	else {
// 		// 		previous_uri = uri;
// 		// 		// Load the new image data
// 		// 		const img = new Image();
// 		// 		img.onload = () => {
// 		// 			// Cancel any in-progress pointer operations
// 		// 			// if (pointer_operations.length) {
// 		// 			// 	$G.triggerHandler("pointerup", "cancel");
// 		// 			// }

// 		// 			const test_canvas = make_canvas(img);
// 		// 			const image_data_remote = test_canvas.ctx.getImageData(0, 0, test_canvas.width, test_canvas.height);
// 		// 			const image_data_local = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);

// 		// 			if (!image_data_match(image_data_remote, image_data_local, 5)) {
// 		// 				ignore_session_update = true;
// 		// 				undoable({
// 		// 					name: "Sync Session",
// 		// 					icon: get_help_folder_icon("p_database.png"),
// 		// 				}, () => {
// 		// 					// Write the image data to the canvas
// 		// 					main_ctx.copy(img);
// 		// 					$canvas_area.trigger("resize");
// 		// 				});
// 		// 				ignore_session_update = false;
// 		// 			}
// 		// 		};
// 		// 		img.src = uri;
// 		// 	}
// 		// }, error => {
// 		// 	show_error_message("Failed to retrieve data from Firebase. The document will not load, and changes will not be saved.", error);
// 		// 	file_name = `[Failed to load ${this.id}]`;
// 		// 	update_title();
// 		// });
// 		// // Update the cursor status
// 		// $G.on("pointermove.session-hook", e => {
// 		// 	const m = to_canvas_coords(e);
// 		// 	this.fb_user.child("cursor").update({
// 		// 		x: m.x,
// 		// 		y: m.y,
// 		// 		away: false,
// 		// 	});
// 		// });
// 		// $G.on("blur.session-hook", () => {
// 		// 	this.fb_user.child("cursor").update({
// 		// 		away: true,
// 		// 	});
// 		// });
// 		// @FIXME: the cursor can come back from "away" via a pointer event
// 		// while the window is blurred and stay there when the user goes away
// 		// maybe replace "away" with a timestamp of activity and then
// 		// clients can decide whether a given cursor should be visible
// 	}
// 	end() {
// 		// Skip debounce and save immediately
// 		this.write_canvas_to_database_soon.cancel();
// 		this.write_canvas_to_database_immediately();
// 		// Remove session-related hooks
// 		$G.off(".session-hook");
// 		// $canvas_area.off("pointerdown.session-hook");
// 		// Remove collected Firebase event listeners
// 		this._fb_listeners.forEach(({ fb, event_type, callback, _error_callback }) => {
// 			log(`Remove listener for ${fb.path.toString()} .on ${event_type}`);
// 			fb.off(event_type, callback);
// 		});
// 		this._fb_listeners.length = 0;
// 		// Remove the user from the session
// 		this.fb_user.remove();
// 		// Remove any cursor elements
// 		$app.find(".user-cursor").remove();
// 		// Reset to "untitled"
// 		reset_file();
// 	}
// }


class RESTSession {
	constructor(session_id) {
		this.id = session_id;

		file_name = `[Loading ${this.id}]`;
		update_title();
		this.start();

		this._previous_uri = "";
		this._ignore_session_update = false;
		this._poll_tid = -1;
		this._poll_fetch_start_time = -1;
		this._last_write_time = -1;
	}
	async _write_canvas_to_server_immediately() {
		const save_paused = handle_data_loss();
		if (save_paused) {
			return;
		}
		// Sync the data from this client to the server (one-way)
		const uri = main_canvas.toDataURL();
		if (this._previous_uri !== uri) {
			// log("clear pointer operations to set data", pointer_operations);
			// pointer_operations = [];
			log("Write canvas data to server");
			this._previous_uri = uri;
			this._last_write_time = performance.now(); // not sure about this
			await fetch(`/api/rooms/${this.id}/data`, {
				method: "PUT",
				body: uri,
			});
			this._last_write_time = performance.now(); // not sure about this
		} else {
			log("(Don't write canvas data to server; it hasn't changed)");
		}
	}
	start() {
		this._write_canvas_to_server_soon = debounce(this._write_canvas_to_server_immediately, 100);
		$G.on("session-update.session-hook", () => {
			if (this._ignore_session_update) {
				log("(Ignore session-update from Sync Session undoable)");
				return;
			}
			this._write_canvas_to_server_soon();
			this._last_write_time = performance.now(); // not sure about this
		});
		// Poll for changes
		const poll = async () => {
			let received_image_data_uri;
			try {
				this._poll_fetch_start_time = performance.now();
				const response = await fetch(`/api/rooms/${this.id}/data`);
				if (response.status === 404) {
					// If the image data wasn't found, this is a new session
					received_image_data_uri = null;
				} else {
					received_image_data_uri = await response.text();
				}
			} catch (error) {
				show_error_message("Failed to load image document from the server.", error);
				file_name = `[Failed to load ${this.id}]`;
				update_title();
				return; // Uh, TODO: retry?
			}
			file_name = `[${this.id}]`;
			update_title();
			this.handle_data_snapshot(received_image_data_uri, this._poll_fetch_start_time);
			// @ts-ignore  (stupid @types/node interference, with their setTimeout typing)
			this._poll_tid = setTimeout(poll, 1000);
		};
		poll();
	}
	handle_data_snapshot(uri, start_time) {
		// Any time we change or receive the image data
		if (!uri) {
			// This is a new session; sync the current data to it
			this._write_canvas_to_server_soon();
			this._last_write_time = performance.now(); // not sure about this
		} else {
			this._previous_uri = uri;
			// Load the new image data
			const img = new Image();
			img.onload = () => {

				if (this._last_write_time > start_time) {
					// If the image data was written since we started fetching it,
					// ignore the likely-stale data.
					log("(Ignore stale image data)");
					return;
				}

				// Cancel any in-progress pointer operations
				// if (pointer_operations.length) {
				// 	$G.triggerHandler("pointerup", "cancel");
				// }

				const test_canvas = make_canvas(img);
				const image_data_remote = test_canvas.ctx.getImageData(0, 0, test_canvas.width, test_canvas.height);
				const image_data_local = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);

				if (!image_data_match(image_data_remote, image_data_local, 5)) {
					this._ignore_session_update = true;
					undoable({
						name: "Sync Session",
						icon: get_help_folder_icon("p_database.png"),
					}, () => {
						// Write the image data to the canvas
						main_ctx.copy(img);
						$canvas_area.trigger("resize");
					});
					this._ignore_session_update = false;
				}
			};
			img.onerror = () => {
				// uri is invalid, so it might be an error message or something; I'll include it in the expandible details.
				show_error_message("Failed to load image document from the server. Invalid image data.", uri);
			};
			img.src = uri;
		}
	}
	end() {
		// Stop polling
		clearTimeout(this._poll_tid);
		// Skip debounce and save immediately
		this._write_canvas_to_server_soon.cancel();
		this._write_canvas_to_server_immediately();
		// Remove session-related hooks
		$G.off(".session-hook");
		// Remove any cursor elements
		$app.find(".user-cursor").remove();
		// Reset to "untitled"
		reset_file();
	}
}


// Handle the starting, switching, and ending of sessions from the location.hash

let current_session;
// Ends the current session, and notes what it belonged to for the session that follows it. Resolves once its last save
// has landed.
const end_current_session = () => {
	let last = Promise.resolve();
	if (current_session) {
		log("Ending current session");
		left_as = current_session instanceof LocalSession ? { game: current_session.game ?? null, connection: current_session.connection ?? null, final: current_session.kept_final ?? null } : NO_GAME;
		last = Promise.resolve(current_session.end()).catch(() => { });
		current_session = null;
	}
	return last;
};
// A new session id. It counts as fresh for the rest of the task that made it, in which the address handler sees it and
// starts its session: nothing is stored under it yet. Every id this page made is kept too (made_here): a database that
// never opened on this page holds no record of them.
const fresh_ids = new Set(), made_here = new Set();
const generate_session_id = () => {
	const id = (Math.random() * (2 ** 32)).toString(16).replace(".", "");
	made_here.add(id);
	fresh_ids.add(id);
	queueMicrotask(() => fresh_ids.delete(id));
	return id;
};
// The game a stored session belongs to, read without decoding its canvas, from where the restore would read it:
// { found, game }.
async function stored_game_of(id) {
	let record = null;
	if (await open_db()) {
		record = (await transact(["sessions"], "readonly", ({ sessions }) => request_of(sessions.get(id)))) ?? null;
	}
	record ??= read_local(id) ?? read_staged(id);
	return { found: !!record, game: record?.game ?? null };
}
const hash_names_local = (id) => {
	const match = location.hash.match(/^#?(?:.*,)?(session|local):(.*)$/i);
	return !!match && match[1].toLowerCase() === "local" && match[2] === id;
};
// The address's latest switch to another session that waits for its look-up, counted so that an answer for an address
// the tab has moved on from is dropped, and the id whose look-up let the switch go ahead.
let switch_turn = 0, switch_cleared = null;
const update_session_from_location_hash = () => {
	const session_match = location.hash.match(/^#?(?:.*,)?(session|local):(.*)$/i);
	const load_from_url_match = location.hash.match(/^#?(?:.*,)?(load):(.*)$/i);
	if (session_match) {
		const local = session_match[1].toLowerCase() === "local";
		const session_id = session_match[2];
		const fresh = fresh_ids.delete(session_id);
		if (session_id === "") {
			log("Invalid session ID; session ID cannot be empty");
			end_current_session();
		} else if (!local && session_id.match(/[./[\]#$]/)) {
			log("Session ID is not a valid Firebase location; it cannot contain any of ./[]#$");
			end_current_session();
		} else if (!session_id.match(/[-0-9A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02af\u1d00-\u1d25\u1d62-\u1d65\u1d6b-\u1d77\u1d79-\u1d9a\u1e00-\u1eff\u2090-\u2094\u2184-\u2184\u2488-\u2490\u271d-\u271d\u2c60-\u2c7c\u2c7e-\u2c7f\ua722-\ua76f\ua771-\ua787\ua78b-\ua78c\ua7fb-\ua7ff\ufb00-\ufb06]+/)) {
			log("Invalid session ID; it must consist of 'alphanumeric-esque' characters");
			end_current_session();
		} else if (
			current_session && current_session.id === session_id &&
			local === (current_session instanceof LocalSession)
		) {
			log("Hash changed but the session ID and session type are the same");
		} else {
			// With a game loaded, the tab's session gives way only to a stored session of that game, or to an id with
			// nothing stored (decision 7). A stored session of another game, or of none yet, stays closed and as stored:
			// opened here its canvas would take this game's size, be saved so over its record, and be scored in this
			// game. One message says so, the address goes back, and the tab's own session goes on with its canvas, its
			// undo history and its saves. The look-up comes before the tab's session ends, so the switch waits for it.
			// An id this page made a moment ago has nothing stored and switches at once: join() gives the new session
			// its game right after it changes the address.
			const loaded = loaded_game();
			if (local && loaded && current_session instanceof LocalSession && switch_cleared !== session_id && !fresh) {
				const from = current_session, turn = ++switch_turn;
				stored_game_of(session_id).catch(() => ({ found: false, game: null })).then((stored) => {
					if (turn !== switch_turn || current_session !== from || !hash_names_local(session_id)) {
						return;
					}
					if (stored.found && !(stored.game && same_game(stored.game, loaded))) {
						show_error_message("This tab has a game loaded, and the session at that address belongs to another game, or to none yet. It wasn't opened here, and its saved canvas stays as it is. Open it in a tab of its own.");
						change_url_param("local", from.id, { replace_history_state: true });
						return;
					}
					switch_cleared = session_id;
					try {
						update_session_from_location_hash();
					} finally {
						switch_cleared = null;
					}
				});
				return;
			}
			// @TODO: Ask if you want to save before starting a new session
			end_current_session();
			let online_session_implementation = is_discord_embed ? "RESTSession" : "FirebaseSession";
			try {
				online_session_implementation = localStorage["online_session_implementation"] || online_session_implementation;
			} catch (_error) {
				// ignore, as this is only for development
			}
			if (local) {
				log(`Starting a new LocalSession, ID: ${session_id}`);
				current_session = new LocalSession(session_id, fresh);
			} else if (online_session_implementation === "RESTSession") {
				// log(`Starting a new WebSocketSession, ID: ${session_id}`);
				// current_session = new WebSocketSession(session_id);
				log(`Starting a new RESTSession, ID: ${session_id}`);
				current_session = new RESTSession(session_id);
			} else if (online_session_implementation === "FirebaseSession") {
				log(`Starting a new FirebaseSession, ID: ${session_id}`);
				current_session = new FirebaseSession(session_id);
			} else {
				show_error_message(`Invalid online session implementation '${online_session_implementation}'`);
				current_session = new LocalSession(session_id);
			}
		}
	} else if (load_from_url_match) {
		const url = decodeURIComponent(load_from_url_match[2]);

		const uris = get_uris(url);
		if (uris.length === 0) {
			show_error_message("Invalid URL to load (after #load: in the address bar). It must include a protocol (https:// or http://)");
			return;
		}

		log("Switching to new session from #load: URL (to #local: URL with session ID)");
		// Note: could use into_existing_session=false on open_from_image_info instead of creating the new session beforehand
		end_current_session();
		change_url_param("local", generate_session_id());

		load_image_from_uri(url).then((info) => {
			// The picture takes the canvas's place, so from here the session belongs to the game the page has loaded, or
			// to none before a login, whatever the session before it belonged to.
			const loaded = loaded_game();
			if (current_session instanceof LocalSession && !(current_session.game && loaded && same_game(current_session.game, loaded))) {
				Object.assign(current_session, { game: loaded, connection: null, kept_final: null });
			}
			open_from_image_info(info, null, null, true, true);
		}, show_resource_load_error_message);

	} else {
		log("No session ID in hash");
		const old_hash = location.hash;
		end_current_session();
		change_url_param("local", generate_session_id(), { replace_history_state: true });
		log("After replaceState:", location.hash);
		if (old_hash === location.hash) {
			// e.g. on Wayback Machine
			show_error_message("Autosave is disabled. Failed to update URL to start session.");
		} else {
			update_session_from_location_hash();
		}
	}
};

$G.on("hashchange popstate change-url-params", (e) => {
	log(e.type, location.hash);
	update_session_from_location_hash();
});

// The session restore as the Connect button and tests see it (task 7.5): whether the current session's restore has landed
// or failed, a promise that settles then, the session's id, and what the latest restore came to. And task 7.4's: where
// saves go ("idb" or "local"), the SHA-256 of the session's goal, how long saves wait now and how long the last one held
// the page, the session a duplicated tab copied, and the persistent storage asked for and its answer.
window.paint_hard_session = {
	get ready() {
		return !(current_session instanceof LocalSession && current_session.restoring);
	},
	get restored() {
		return current_session instanceof LocalSession ? current_session.restored : Promise.resolve("nothing stored");
	},
	get id() {
		return current_session?.id ?? null;
	},
	get outcome() {
		return restore_outcome;
	},
	get backend() {
		return current_session instanceof LocalSession ? current_session.backend : null;
	},
	get goal() {
		return current_session instanceof LocalSession ? current_session.goal?.sha256 ?? null : null;
	},
	get save_every() {
		return current_session instanceof LocalSession ? { every: current_session.save_every, cost: current_session.last_cost } : null;
	},
	get copied_from() {
		return current_session instanceof LocalSession ? current_session.copied_from : null;
	},
	get persistence() {
		return { ...persistence };
	},
};

const new_local_session = () => {
	end_current_session();
	log("Changing URL to start new session...");
	change_url_param("local", generate_session_id());
};

const session_export_format = {
	formatID: "application/vnd.jspaint.session",
	mimeType: "application/json",
	name: localize("JS Paint Session (*.appaint)"),
	nameWithExtensions: localize("JS Paint Session (*.appaint)"),
	extensions: ["appaint"],
};

async function export_local_session() {
	if (!current_session || !(current_session instanceof LocalSession)) {
		show_error_message(localize("No local session is available to export."));
		return;
	}
	// A browser that blocks canvas reads gives a blank picture in place of the canvas, and the file would hold that. Once
	// reads are allowed, the canvas may hold what the blocked reads drew back onto it, until a reload (canvas_tainted()).
	if (canvas_tainted()) {
		show_error_message(reads_are_blocked() ?
			"Your browser blocks reading the canvas, so Paint can't write this session to a file. Allow canvas reads for this site, then reload this tab and export again." :
			"Your browser blocked reading the canvas earlier on this page, so Paint can't write this session to a file. Reload this tab, then export again.");
		return;
	}
	const session_id = current_session.id;

	// Package local session data
	let payload = {
		version: 1, // Allows us to make changes to the formatting later without breaking compatibility
		session_id,
		data: await current_session.collect_session_data()
	}

	const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });

	await systemHooks.showSaveFileDialog({
		dialogTitle: localize("Export Session"),
		formats: [session_export_format],
		defaultFileName: `${session_id}`,
		getBlob: () => Promise.resolve(blob),
	});
}

async function import_local_session() {
	const { file } = await systemHooks.showOpenFileDialog({
		formats: [session_export_format],
	});
	if (!file) {
		return;
	}

	// The file is judged whole before anything is stored and before this tab's session ends, so a file that is refused
	// leaves the tab, its session and its record as they were. A message names the file, never its content.
	const refuse = (why) => {
		show_error_message(`Paint didn't import ${file.name}: ${why} Nothing was stored, and this tab stays as it was.`);
	};
	let payload;
	try {
		payload = JSON.parse(await file.text());
	} catch (_error) {
		payload = null;
	}
	if (!payload || typeof payload !== "object") {
		show_error_message(localize("Invalid session file format."));
		return;
	}

	if (payload.version !== 1) {
		show_error_message(localize("Invalid session file version. This file may have been created by a newer version of the software."));
		return;
	}

	let data = null;
	try {
		data = typeof payload.session_id === "string" && payload.session_id && typeof payload.data === "string" ? JSON.parse(payload.data) : null;
	} catch (_error) { /* judged below */ }
	if (!data || typeof data !== "object") {
		refuse("it isn't a session file as Export Session writes one.");
		return;
	}
	// A file of another game than the page has loaded isn't imported: opened here, its canvas would take this game's
	// size and be scored in this game. A file with no game imports, and its next login binds it (decision 7).
	const loaded = loaded_game();
	if (loaded && data.game && !same_game(data.game, loaded)) {
		show_error_message("This session file belongs to another game than the one this tab has loaded, so it wasn't imported here. Import it in a tab that is logged into that game.");
		return;
	}
	if (!Array.isArray(data.colors) || !data.colors.every((color) => typeof color === "string")) {
		refuse("it has no palette that Paint can read.");
		return;
	}
	// The canvas has to be a PNG inside the file, as Export Session writes it: any other text would be fetched as an
	// address. Its size is read from its header before anything decodes it, and then it has to decode.
	const size = png_size(data.canvas);
	if (!size || !size[0] || !size[1]) {
		refuse("its canvas isn't a PNG that Paint can read.");
		return;
	}
	if (size[0] * size[1] > IMPORT_MAX_PIXELS) {
		refuse(`its canvas is ${size[0]}x${size[1]}, and Paint takes at most ${IMPORT_MAX_PIXELS.toLocaleString("en-US")} pixels (4096x4096) from a file.`);
		return;
	}
	if (!await decodes(data.canvas)) {
		refuse("its canvas isn't a PNG that Paint can read.");
		return;
	}
	// A goal that isn't such a PNG is left out, and the next login draws the seed's own.
	const goal_size = png_size(data.goal);
	if (data.goal != null && !(goal_size && goal_size[0] * goal_size[1] <= IMPORT_MAX_PIXELS && await decodes(data.goal))) {
		data.goal = null;
	}
	// The page's connection stays: the file's own isn't taken.
	data.connection_info = connection_fields();
	// The file keeps its id only where that is this tab's own session, whose lock this tab holds. Under any other id the
	// write could land on a record that another tab has open, or under an id that no address can carry, so the import
	// gets an id of its own. A session still restoring doesn't know yet whether its id is its own.
	const own = current_session instanceof LocalSession && !current_session.restoring ? current_session.id : null;
	const keeps_id = payload.session_id === own;
	const id = keeps_id ? own : generate_session_id();

	// A file that keeps the tab's own id lands on the session's record. The session saves a change that waits, then holds
	// its saves until the write is done, so none lands over the file. A write that is refused leaves the session as it
	// was, with its canvas and its undo history, and lets its saves go on; one that lands ends it with no last save. Under
	// an id of its own the file is stored first, and the tab's session goes on until that has landed.
	const from = current_session;
	const held = keeps_id ? from : null;
	if (held) {
		await held.hold_saves();
	}
	try {
		await write_imported(id, data, size);
	} catch (error) {
		// Nothing of the file was stored. A session that ended meanwhile, as when the address moved, saves nothing more,
		// and the tab has gone on in another session.
		const stayed = current_session === from;
		show_error_message(`Paint couldn't store the session from ${file.name}, so it wasn't imported.${stayed ? " This tab goes on in the session it had." : ""}`, error);
		if (held && stayed) {
			held.release_saves();
		}
		return;
	}
	if (held && current_session === held) {
		held.left = true; // its record holds the file now
	}
	// The tab's session ends before the address changes: with a game loaded, the address handler would turn away a
	// stored session of no game yet, which a file may be (decision 7).
	await end_current_session();
	try {
		const colors = [...data.colors];
		while (colors.length < palette.length) colors.push("#FFFFFF");
		$colorbox.rebuild_palette(colors);
	} catch (_error) { /* the restore puts the palette in place */ }

	// Switch to the imported session
	change_url_param("local", id);
}

// The most pixels the canvas of an imported file may have, 4096x4096 of them: decoding it takes a whole bitmap at once,
// and a small PNG can name a huge one.
const IMPORT_MAX_PIXELS = 4096 * 4096;
// The width and height a PNG in a data URL names in its header, read without decoding it: the signature, then the
// IHDR chunk's length and name, its width and its height, 24 bytes in all. Null for anything else.
function png_size(uri) {
	const prefix = "data:image/png;base64,";
	if (typeof uri !== "string" || !uri.startsWith(prefix)) {
		return null;
	}
	let head;
	try {
		head = atob(uri.slice(prefix.length, prefix.length + 32));
	} catch (_error) {
		return null;
	}
	if (head.length < 24 || head.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || head.slice(12, 16) !== "IHDR") {
		return null;
	}
	const number = (at) => ((head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)) >>> 0;
	return [number(16), number(20)];
}
// Whether the picture in a data URL decodes.
const decodes = (uri) => fetch(uri).then((response) => response.blob()).then((blob) => createImageBitmap(blob)).then((bitmap) => {
	bitmap.close();
	return true;
}, () => false);

// Writes an imported .appaint session where sessions live (task 7.4): into IndexedDB as a version 2 record, or to
// localStorage where IndexedDB isn't available, as before. `size` is the canvas's width and height.
async function write_imported(id, data, size) {
	const db = await open_db();
	if (!db) {
		await new Promise((resolve, reject) => save_image_to_storage(`image#${id}`, JSON.stringify(data), (err) => (err ? reject(err) : resolve())));
		return;
	}
	const record = await from_local(id, data);
	const goal_file = record.goal_file;
	delete record.goal_file;
	Object.assign(record, { width: size[0], height: size[1], saved_at: Date.now() });
	await transact(["sessions", "goals"], "readwrite", async ({ sessions, goals }) => {
		const old = await request_of(sessions.get(id));
		sessions.put(record);
		if (goal_file) {
			goals.put({ sha256: goal_file.sha256, blob: goal_file.blob, width: null, height: null, used_at: Date.now() });
		}
		if (old?.goal && old.goal !== record.goal && !(await request_of(sessions.index("goal").count(old.goal)))) {
			goals.delete(old.goal);
		}
	}, STRICT);
	// The record this replaced, if any, held another canvas file.
	close_db();
	for (const key of local_keys(id)) {
		try { localStorage.removeItem(key); } catch (_error) { /* nothing kept there */ }
	}
}

window.export_local_session = export_local_session;
window.import_local_session = import_local_session;
// @TODO: Session GUI
// @TODO: Indicate when the session ID is invalid
// @TODO: Indicate when the session switches

// @TODO: Indicate when there is no session!
// Probably in app.js so as to handle the possibility of sessions.js failing to load.


if (is_discord_embed) {
	// I'm using top level await WITHIN the discord-activity-client.js module,
	// but not here due to lack of support in the current browser version used for Cypress tests.
	// This async IIFE could be eliminated if Cypress was updated.
	(async () => {
		const { /*Discord,*/ discordSdk, newAuth, guildMember, handleExternalLinks, discordActivitySystemHooks } = await import("./discord-activity-client.js");
		// const { Events } = Discord;

		log("Discord SDK", discordSdk);
		log("New Auth:", newAuth);
		log("Guild Member", guildMember);

		// Handle external links
		handleExternalLinks();

		// Start session for the Discord Activity instance
		// (Would channelId be better?)
		log(`Starting session for Discord Activity instance ${discordSdk.instanceId}`);
		change_url_param("session", `discord-activity-${discordSdk.instanceId}`);

		// Apply system hooks
		Object.assign(window.systemHooks, discordActivitySystemHooks);

		// // Fetch
		// const participants = await discordSdk.commands.getInstanceConnectedParticipants();
		// console.log("Initial participants", participants);

		// // Subscribe
		// discordSdk.subscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, updateParticipants);
		// // Unsubscribe
		// discordSdk.unsubscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, updateParticipants);
	})();
} else {
	log("Initializing with location hash:", location.hash);
	update_session_from_location_hash();
}

// function updateParticipants(participants) {
// 	// Do something really cool
// 	console.log("Updated participants:", participants);
// }

export { new_local_session };
// Temporary globals until all dependent code is converted to ES Modules
window.new_local_session = new_local_session; // used by functions.js

