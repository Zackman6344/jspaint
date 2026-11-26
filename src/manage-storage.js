// @ts-check
/* global localize */
import { $DialogWindow } from "./$ToolWindow.js";
// import { localize } from "./app-localization.js";
import { show_error_message } from "./functions.js";
import { E, is_discord_embed } from "./helpers.js";
import { close_db, idb_state, open_db, request_of, transact } from "./idb.js";
import { showMessageBox } from "./msgbox.js";

/** @type {OSGUI$Window & I$DialogWindow} */
let $storage_manager;
let $quota_exceeded_window;
let ignoring_quota_exceeded = false;

async function storage_quota_exceeded() {
	if ($quota_exceeded_window) {
		$quota_exceeded_window.close();
		$quota_exceeded_window = null;
	}
	if (ignoring_quota_exceeded) {
		return;
	}
	const { promise, $window } = showMessageBox({
		title: "Storage Error",
		messageHTML: `
			<p>Paint normally keeps a local backup of images you edit.</p>
			<p>However, it has run out of space to do so.</p>
			<p>You can still save the current image with <b>File > Save</b>. You should save frequently, or free up space for backups.</p>
		`,
		buttons: [
			{ label: "Manage Storage", value: "manage", default: true },
			{ label: "Ignore", value: "ignore" },
		],
		iconID: "warning",
	});
	$quota_exceeded_window = $window;
	const result = await promise;
	if (result === "ignore") {
		ignoring_quota_exceeded = true;
	} else if (result === "manage") {
		ignoring_quota_exceeded = false;
		manage_storage();
	}
}

// File > Manage Storage (task 7.4): the sessions this browser keeps in IndexedDB, newest first, each with thumbnails of
// its canvas and goal that createImageBitmap makes at thumbnail size, its size and its canvas's bytes, when it was
// saved, the slot and address its game was last logged in with, and Remove; then the sessions in localStorage, with the
// slot and address too, which move to IndexedDB when opened; how much storage the site uses of what the browser allows
// it; and whether the browser keeps that storage until it's removed, with a Keep button that asks it to. Removing a
// session removes its goal too, unless another session or this page uses it. A session that another tab has open keeps
// its record: its Remove is disabled, since that tab would lose its canvas at its next load. The focus starts on Close.
function manage_storage() {
	if ($storage_manager) {
		$storage_manager.close();
	}
	const $w = $storage_manager = $DialogWindow();
	$w.title("Manage Storage").addClass("storage-manager squish");
	// @TODO: way to remove all (with confirmation)
	const $table = $(E("table")).appendTo($w.$main);
	const $unlisted = $(E("p")).addClass("storage-unlisted").appendTo($w.$main);
	const $message = $(E("p")).appendTo($w.$main).html(
		"Any images you've saved to your computer with <b>File > Save</b> will not be affected."
	);
	const $usage = $(E("p")).addClass("storage-usage").appendTo($w.$main);
	const $kept = $(E("p")).addClass("storage-kept").appendTo($w.$main);
	// Whether the browser answered no to Keep in this window. Chrome answers by its own rules, with nothing shown.
	let declined = false;
	const $keep = $w.$Button("Keep", () => {
		$keep.prop("disabled", true);
		navigator.storage.persist().then((kept) => {
			declined = !kept;
			show_kept();
		}, show_kept);
	}).addClass("keep-button");
	const $close = $w.$Button("Close", () => {
		$w.close();
	});
	// The Electron app is a single window for now. This isn't a great experience, but it's better than a broken link.
	// The Discord Activity can open a external links (with a prompt), but opening internally seems better,
	// and it was opening a new tab with the app but not loading the document, so this fixes that.
	// (It seemed to be a separate storage area, despite the same origin? only glancing, not sure.)
	const target = window.is_electron_app || is_discord_embed ? "_self" : "_blank";

	const show_kept = () => {
		if (!navigator.storage?.persisted) {
			$kept.text("");
			$keep.hide();
			return;
		}
		navigator.storage.persisted().then((persisted) => {
			$kept.text(persisted ?
				"Your browser keeps this storage until you remove it." :
				declined ?
					"Your browser may clear this storage when your disk runs low on space. It declined to keep it for now." :
					"Your browser may clear this storage when your disk runs low on space. Keep asks it not to.");
			$keep.prop("disabled", persisted);
		}, () => $kept.text(""));
	};
	// The figures are the browser's for IndexedDB and its other stores. Where sessions keep to localStorage, they say
	// nothing of the room sessions have, and the line stays empty.
	let sessions_in_idb = true;
	const show_usage = () => {
		if (!navigator.storage?.estimate || !sessions_in_idb) {
			$usage.text("");
			return;
		}
		navigator.storage.estimate().then(({ usage, quota }) => {
			$usage.text(sessions_in_idb ? `This site uses ${size_text(usage)} of the ${size_text(quota)} your browser allows it.` : "");
		}, () => $usage.text(""));
	};
	// Whether the list holds every session there is: not where the database couldn't be read.
	let listed_all = true;
	const all_clear = () => {
		if ($table.find("tr").length == 0 && listed_all) {
			$message.html("<p>All clear!</p>");
		}
	};

	// A row: its thumbnails, which open the session, its details, and Remove. Each part of the details, [text, the
	// separator before it, whether it may wrap], gets a line of its own, so no figure breaks in two. The separators stay
	// in the cell's text and aren't shown. A session that another tab has open (`open`) keeps its record.
	const add_row = (id, thumbnails, parts, remove, open = false) => {
		const $tr = $(E("tr")).attr("data-session", id).appendTo($table);
		const $remove = $(E("button")).text("Remove").addClass("remove-button").attr("type", "button");
		const $thumbnail_open_link = $(E("a")).attr({ href: `#local:${id}`, target }).addClass("thumbnail-container");
		$thumbnail_open_link.append(thumbnails);
		$(E("td")).append($thumbnail_open_link).appendTo($tr);
		const $details = $(E("td")).addClass("session-details").appendTo($tr);
		for (const [text, lead = ", ", wraps = false] of parts.filter(([text]) => text)) {
			if ($details.children().length) {
				$(E("span")).addClass("between").text(lead).appendTo($details);
			}
			$(E("span")).addClass(wraps ? "part wraps" : "part").text(text).appendTo($details);
		}
		$(E("td")).append($remove).appendTo($tr);
		if (open) {
			$remove.prop("disabled", true).attr("title", "This session is open in another tab. Close that tab first, then remove it here.");
		}

		$remove.on("click", () => {
			// Focus the next or previous row's remove button, or the close button if there are no more rows.
			// Try focusing controls in reverse order of priority, so the highest priority control gets focus.
			$close.focus();
			$tr.prev().find(".remove-button").focus();
			$tr.next().find(".remove-button").focus();
			$remove.prop("disabled", true);
			Promise.resolve(remove()).then(() => {
				$tr.remove();
				all_clear();
				show_usage();
			}, (error) => {
				$remove.prop("disabled", false);
				show_error_message("Paint couldn't remove that session.", error);
			});
		});
	};

	let localStorageAvailable = false;
	try {
		if (localStorage.length > 0) {
			// This is needed in case it's COMPLETELY full.
			// Test with https://stackoverflow.com/questions/45760110/how-to-fill-javascript-localstorage-to-its-max-capacity-quickly
			// Of course, this dialog only manages images, not other data (for now anyway).
			localStorageAvailable = true;
		} else {
			localStorage._available = true;
			localStorageAvailable = localStorage._available;
			delete localStorage._available;
		}
	} catch (_error) { /* ignore */ }

	(async () => {
		// An open that takes its time says so. It answers, or stops being waited for after 15 s (idb.js).
		const waiting = setTimeout(() => $unlisted.text("Paint is still opening its storage. The list comes once it answers."), 1000);
		const db = await open_db();
		clearTimeout(waiting);
		// A database this page can't read may hold sessions that the list then lacks: one that a newer version holds, one
		// that didn't open on this page load, and one that opened before and didn't open this time, which the next list
		// opens again (idb.js).
		const state = idb_state();
		listed_all = !!db || state === "unavailable";
		$unlisted.text(listed_all ? "" : state === "newer" ?
			"Paint was updated in another tab, so this tab can't list the sessions in its storage. Reload this tab to see them." :
			state === "open" ?
				"Paint couldn't open its storage just now, so the sessions it keeps there aren't listed. Opening File > Manage Storage again tries once more." :
				"Paint couldn't open its storage on this page load, so the sessions it keeps there aren't listed. Reload this tab to try again.");
		sessions_in_idb = !!db;
		show_usage();
		// The sessions that a tab has open hold their Web Locks (sessions.js).
		let held = new Set();
		try {
			held = new Set((await navigator.locks.query()).held.map((lock) => lock.name));
		} catch (_error) { /* no Web Locks here: no session is known to be open */ }
		const own_id = window.paint_hard_session?.id;
		const mark_of = (id) => (id === own_id ? "(this tab)" : held.has(`pain-t-session:${id}`) ? "(open in another tab)" : "");
		const in_idb = new Set();
		if (db) {
			const [sessions, goals] = await transact(["sessions", "goals"], "readonly", async ({ sessions, goals }) => [
				await request_of(sessions.getAll()),
				await request_of(goals.getAll()),
			]);
			const goal_of = new Map(goals.map((goal) => [goal.sha256, goal]));
			// A goal that several sessions share is decoded once, and each row gets a copy of its thumbnail.
			const goal_thumbnails = new Map();
			const goal_thumbnail = async (goal) => {
				if (!goal) {
					return thumbnail(null);
				}
				if (!goal_thumbnails.has(goal.sha256)) {
					goal_thumbnails.set(goal.sha256, thumbnail(goal.blob, goal.width, goal.height).then(async (made) => {
						const again = made.width ? null : await read_again("goals", goal.sha256);
						return again?.blob ? thumbnail(again.blob, again.width, again.height) : made;
					}));
				}
				return copy_of(await goal_thumbnails.get(goal.sha256));
			};
			sessions.sort((a, b) => (b.saved_at ?? 0) - (a.saved_at ?? 0));
			for (const record of sessions) in_idb.add(record.id);
			for (let record of sessions) {
				if ($storage_manager !== $w || $w.closed) {
					return;
				}
				const goal = record.goal ? goal_of.get(record.goal) : null;
				const thumbnails = await Promise.all([thumbnail(record.canvas, record.width, record.height), goal_thumbnail(goal)]);
				// A canvas that gives no thumbnail is read again, once, before its row says it can't be read: Firefox lets go
				// of the file of a canvas that a save replaced after the list read it, once the connection that read it has
				// closed, as each save closes it (idb.js).
				if (!thumbnails[0].width) {
					const again = await read_again("sessions", record.id);
					if (again?.canvas) {
						record = again;
						thumbnails[0] = await thumbnail(record.canvas, record.width, record.height);
					}
				}
				// The canvas's own bytes: a goal's are shared by every session that refers to it, and Remove frees them only
				// with the last of those. A canvas that gave no thumbnail won't restore either, and the row says so.
				const unreadable = !thumbnails[0].width;
				const size = record.width && record.height ? `${record.width}x${record.height}, ` : "";
				const saved = record.saved_at ? `saved ${new Date(record.saved_at).toLocaleString(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
				const mark = mark_of(record.id);
				add_row(record.id, thumbnails, [[`${size}${size_text(record.canvas?.size)}`], [unreadable ? "its canvas can't be read" : ""], [saved], [game_text(record.connection), ", ", true], [mark, " "]], () => remove_session(record.id), mark === "(open in another tab)");
			}
		}
		if (localStorageAvailable) {
			for (const k in localStorage) {
				if ($storage_manager !== $w || $w.closed) {
					return;
				}
				if (k.match(/^image#/) && !k.match(/_/)) {
					let v = localStorage[k], img = "", img2 = "", connection = null;
					try {
						v = JSON.parse(v);
						if (v[0] === '{') {
							v = JSON.parse(v);
							img = v.canvas;
							img2 = v.goal;
							connection = v.connection_info;
						}
						else {
							img = v;
							img2 = JSON.parse(localStorage[k + "_goal"]);
						}
					} catch (_error) { /* ignore */ }
					const $img = $(E("img")).attr({ src: img }).addClass("thumbnail-img");
					const $img2 = $(E("img")).attr({ src: img2 }).addClass("thumbnail-img");
					const id = k.slice("image#".length);
					// With the database open, a record here moves into it when its session is opened. One beside a record
					// the database holds under the same id becomes a session of its own then (sessions.js).
					const mark = mark_of(id);
					const kept = !db ? "" : in_idb.has(id) ?
						"A second copy of a session listed above, kept in the browser's older storage: it becomes a session of its own when you open it." :
						"Kept in the browser's older storage: it moves when you open it.";
					add_row(id, [$img, $img2], [[kept, ", ", true], [game_text(connection), ", ", true], [mark, " "]], () => {
						for (const key of [k, `${k}_goal`, `${k}_connection_info`, `${k}_colors`]) localStorage.removeItem(key);
						drop_copy(id);
					}, mark === "(open in another tab)");
				}
			}
		}
		if (!db && !localStorageAvailable) {
			// @TODO: DRY with similar message
			// @TODO: instructions for your browser; it's called Cookies in chrome/chromium at least, and "storage" gives NO results
			$message.html("<p>Please enable local storage in your browser's settings for local backup. It may be called Cookies, Storage, or Site Data.</p>");
		} else {
			all_clear();
		}
		$w.center();
	})().catch((error) => {
		show_error_message("Paint couldn't list the sessions it keeps.", error);
	});
	show_usage();
	show_kept();

	$w.$content.width(Math.min(560, Math.max(300, window.innerWidth - 40)));
	$w.center();
	// The focus starts on Close, so a key pressed as the window opens removes nothing.
	$close.focus();
}

// A size in bytes for a person to read: kB below 0.1 MB, MB to one decimal place, and GB from 1,000 MB.
const size_text = (bytes) => {
	const size = bytes ?? 0;
	if (size < 99950) {
		return `${size ? Math.max(1, Math.round(size / 1e3)) : 0} kB`;
	}
	return size < 999.95e6 ? `${(size / 1e6).toFixed(1)} MB` : `${(size / 1e9).toFixed(1)} GB`;
};

// The slot and the address a session's game was last logged in with, which tell two games' rows apart: "Painter at
// host:port", or as much of that as its connection holds.
const game_text = (connection) => {
	const { host, port, slot } = connection ?? {};
	const address = host ? `${host}${port ? `:${port}` : ""}` : "";
	return slot && address ? `${slot} at ${address}` : slot || address || "";
};

// A thumbnail of an image file, at most 64 pixels a side, decoded at that size. Empty for no file, or one that won't
// decode.
async function thumbnail(blob, width, height) {
	const canvas = /** @type {HTMLCanvasElement} */ (E("canvas"));
	canvas.className = "thumbnail-img";
	canvas.width = canvas.height = 0;
	if (!blob) {
		return canvas;
	}
	const scale = width && height ? Math.min(1, 64 / Math.max(width, height)) : 0;
	const options = scale ?
		{ resizeWidth: Math.max(1, Math.round(width * scale)), resizeHeight: Math.max(1, Math.round(height * scale)), resizeQuality: "medium" } :
		{ resizeWidth: 64, resizeQuality: "medium" };
	try {
		const bitmap = await createImageBitmap(blob, /** @type {ImageBitmapOptions} */ (options));
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext("2d").drawImage(bitmap, 0, 0);
		bitmap.close();
	} catch (_error) { /* an image that won't decode shows as nothing */ }
	canvas.style.maxWidth = canvas.style.maxHeight = "64px";
	return canvas;
}

// A record as its store holds it now, read in a transaction of its own, or null.
const read_again = (store, key) => transact([store], "readonly", (stores) => request_of(stores[store].get(key))).catch(() => null);

// A thumbnail's picture on a canvas of its own, for another row to show.
function copy_of(thumbnail) {
	const canvas = /** @type {HTMLCanvasElement} */ (thumbnail.cloneNode());
	if (thumbnail.width && thumbnail.height) {
		canvas.getContext("2d").drawImage(thumbnail, 0, 0);
	}
	return canvas;
}

// Drops the copy of a session that this tab left in sessionStorage as it last closed (sessions.js). Left there, it
// would bring a removed session back when its id is opened in this tab.
function drop_copy(id) {
	try { sessionStorage.removeItem(`pain-t-unsaved:${id}`); } catch (_error) { /* nothing staged */ }
}

// Removes a session's record, and its goal unless another session refers to it or this page uses it. The write is
// flushed before it counts as done, as a save's is, and the page then closes its connection to the database, which
// lets Firefox remove the files at once.
async function remove_session(id) {
	const keep = window.paint_hard_session?.goal ?? null;
	await transact(["sessions", "goals"], "readwrite", async ({ sessions, goals }) => {
		const record = await request_of(sessions.get(id));
		sessions.delete(id);
		if (record?.goal && record.goal !== keep && !(await request_of(sessions.index("goal").count(record.goal)))) {
			goals.delete(record.goal);
		}
	}, { durability: "strict" });
	close_db();
	drop_copy(id);
}

export {
	manage_storage, storage_quota_exceeded
};

