// @ts-check
// Pain-T's IndexedDB database (task 7.4, decision 6): "pain-t" at version 1, with its three stores made together, so the
// goal cache (7.8) needs no later version, which would wait on every tab still open.
//   sessions: a tab's session, one record a #local: id (key "id"), indexed by the goal it refers to ("goal"); sessions.js
//   goals: a session's goal image, one record a SHA-256 (key "sha256"), indexed by its URL and when it was last used.
//     The key is the SHA-256 of the bytes the record holds: the PNG the browser makes of the goal canvas at the game's
//     size, or the goal of a record from localStorage. The goal's source file has another hash, and Firefox writes
//     that PNG with other bytes after each restart, so there one goal gets a new key in each run of the browser.
//   packages: a game's data package, one record a game and checksum (key ["game", "checksum"]), indexed by game;
//     archipelago.js
// A tab closes the database when another tab opens a later version, so that tab's upgrade can go on, and after each
// save of a session (close_db()), and opens it again at its next use. Where IndexedDB can't open, as with site data
// blocked, the database is unavailable for the page's life, and sessions keep to localStorage. A database that fails to
// open as the page first asks, or doesn't answer in 15 s, stays out for the page's life too. Nothing but IndexedDB's
// own requests is awaited inside a transaction, which commits as soon as nothing more is asked of it.

const NAME = "pain-t";
const VERSION = 1;
// How long an open may go without an answer. A test can set window.paint_hard_open_timeout_ms before the page loads.
const OPEN_WAIT_MS = 15000;

/** @type {Promise<IDBDatabase | null> | null} */
let opening = null;
/** @type {IDBDatabase | null} */
let current = null; // the database as now open
// "unknown" before the first open, "open", "unavailable" (no IndexedDB here, or site data blocked), "newer" (another
// tab opened a later version, so this page's code is older than the database), "failed" (the page's first open ended in
// an error, as on a damaged database or a full disk) or "silent" (the page's first open had no answer in 15 s). In the
// last two the database may hold sessions that this page can't read, and it never opened on this page.
let state = "unknown";
// Why the last open gave no database, for the details of a message.
/** @type {Error | null} */
let open_error = null;
const handlers = { blocked: [], newer: [], failed: [], silent: [] };

// The version this page opens. A test can set window.paint_hard_idb_version before the page loads, to play the page of a
// later deploy.
const version = () => window.paint_hard_idb_version ?? VERSION;
// Whether the browser refuses this site its storage as a whole, as with site data blocked: localStorage throws then.
const storage_refused = () => {
	try {
		localStorage.getItem(NAME);
		return false;
	} catch (_error) {
		return true;
	}
};

/**
 * Runs `handler` when this page's open waits on another tab that holds the database at an older version ("blocked"),
 * when the database turns out newer than this page ("newer"), or when the page's first open ends in an error ("failed")
 * or has no answer in 15 s ("silent").
 * @param {"blocked" | "newer" | "failed" | "silent"} event
 * @param {() => void} handler
 */
function on_idb(event, handler) {
	handlers[event].push(handler);
}
const fire = (event) => {
	for (const handler of handlers[event]) {
		try { handler(); } catch (error) { console.error(error); }
	}
};

/**
 * The database, opened and kept open until close_db() or another tab's upgrade closes it, or null where there's none to
 * use.
 * @returns {Promise<IDBDatabase | null>}
 */
function open_db() {
	if (state === "unavailable" || state === "newer" || state === "failed" || state === "silent") return Promise.resolve(null);
	return opening ??= new Promise((resolve) => {
		/** @type {IDBOpenDBRequest} */
		let request;
		try {
			request = indexedDB.open(NAME, version()); // throws SecurityError where site data is blocked
		} catch (error) {
			state = "unavailable";
			open_error = error;
			opening = null;
			resolve(null);
			return;
		}
		// An open with no answer, as on a browser fault, stops being waited for. The page's first open then leaves the
		// database out for the page's life; a later one is asked again at the next use. A connection that answers after
		// that is closed at once, so no other tab's upgrade waits on it.
		let gave_up = false;
		const wait_ms = window.paint_hard_open_timeout_ms ?? OPEN_WAIT_MS;
		const timer = setTimeout(() => {
			gave_up = true;
			opening = null;
			open_error = new DOMException(`Paint's storage didn't answer in ${wait_ms / 1000} s.`, "TimeoutError");
			if (state === "unknown") {
				state = "silent";
				fire("silent");
			}
			resolve(null);
		}, wait_ms);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains("sessions")) {
				db.createObjectStore("sessions", { keyPath: "id" }).createIndex("goal", "goal");
			}
			if (!db.objectStoreNames.contains("goals")) {
				const goals = db.createObjectStore("goals", { keyPath: "sha256" });
				goals.createIndex("url", "url");
				goals.createIndex("used_at", "used_at");
			}
			if (!db.objectStoreNames.contains("packages")) {
				db.createObjectStore("packages", { keyPath: ["game", "checksum"] }).createIndex("game", "game");
			}
		};
		request.onblocked = () => fire("blocked");
		request.onsuccess = () => {
			clearTimeout(timer);
			if (gave_up) {
				request.result.close();
				return;
			}
			const db = current = request.result;
			db.onversionchange = () => {
				db.close();
				if (current === db) {
					current = null;
					opening = null;
				}
			};
			// Closed by the browser, as when the player clears site data: the next use opens it again.
			db.onclose = () => {
				if (current === db) {
					current = null;
					opening = null;
				}
			};
			state = "open";
			open_error = null;
			resolve(db);
		};
		request.onerror = (event) => {
			clearTimeout(timer);
			event.preventDefault();
			if (gave_up) {
				return;
			}
			opening = null;
			open_error = request.error;
			if (request.error?.name === "VersionError") {
				state = "newer";
				fire("newer");
			} else if (state === "unknown") {
				// Firefox's private windows before version 115 refuse with InvalidStateError, and Chrome answers with
				// UnknownError where site data is blocked, where localStorage refuses too: no IndexedDB there, and sessions
				// keep to localStorage. Any other error is a database that may hold sessions and didn't open on this page
				// load: sessions.js says so, and writes nothing under an id the database may hold.
				state = request.error?.name === "InvalidStateError" || storage_refused() ? "unavailable" : "failed";
				if (state === "failed") fire("failed");
			}
			resolve(null);
		};
	});
}

const idb_state = () => state;

/**
 * Closes this page's connection once the transactions on it have finished. The next use opens the database again.
 * Firefox keeps the file of a canvas that a save replaced, or that Remove took, for as long as the connection that
 * stored or read it stays open, and counts it in the site's usage.
 */
function close_db() {
	const db = current;
	if (!db) return;
	current = null;
	opening = null;
	try { db.close(); } catch (_error) { /* closed already */ }
}

/**
 * A request's result, as a promise.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function request_of(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/**
 * Runs `work` in one transaction over `stores` and resolves with what it returns once the transaction has committed, or
 * rejects with what aborted it: the error of the first request that failed, where one did. `work` gets the stores by
 * name and may await their requests (request_of()), and nothing else, or the transaction commits under it. `options`
 * are the transaction's own, as { durability: "strict" } for a write that has to be on disk once this resolves.
 * @template T
 * @param {string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(stores: Record<string, IDBObjectStore>, transaction: IDBTransaction) => T | Promise<T>} work
 * @param {IDBTransactionOptions} [options]
 * @returns {Promise<T>}
 */
async function transact(stores, mode, work, options = undefined) {
	/** @type {IDBTransaction} */
	let transaction;
	for (let tries = 1; !transaction; tries++) {
		const db = await open_db();
		if (!db) {
			if (state === "newer") throw new DOMException("Paint's storage was opened by a newer version in another tab.", "VersionError");
			throw new DOMException(open_error ? `Paint's storage didn't open (${open_error.name}: ${open_error.message})` : "IndexedDB isn't available here.", "NotSupportedError");
		}
		try {
			transaction = db.transaction(stores, mode, options);
		} catch (error) {
			// InvalidStateError: the connection closed since it opened, after a save (close_db()) or for another tab's
			// upgrade. The database is opened again and the transaction tried once more.
			if (error?.name !== "InvalidStateError") throw error;
			if (current === db) {
				current = null;
				opening = null;
			}
			if (tries > 1) throw error;
		}
	}
	return new Promise((resolve, reject) => {
		let result, failure = null, cause = null;
		// The first request to fail says why the transaction aborted, as QuotaExceededError on a full store. The abort
		// then fails every request still waiting with AbortError, and after commit() Firefox gives the transaction itself
		// AbortError too. An error event rises from its request to the transaction.
		const real = (error) => (error && error.name !== "AbortError" ? error : null);
		transaction.onerror = (event) => {
			cause ??= real(/** @type {IDBRequest} */ (event.target)?.error);
		};
		transaction.oncomplete = () => resolve(result);
		transaction.onabort = () => reject(cause ?? real(failure) ?? real(transaction.error) ?? failure ?? transaction.error ?? new DOMException("The transaction was aborted.", "AbortError"));
		const named = Object.fromEntries(stores.map((name) => [name, transaction.objectStore(name)]));
		let pending;
		try {
			pending = Promise.resolve(work(named, transaction));
		} catch (error) {
			pending = Promise.reject(error);
		}
		pending.then((value) => {
			result = value;
			try { transaction.commit?.(); } catch (_error) { /* already committing */ }
		}, (error) => {
			failure = error;
			try { transaction.abort(); } catch (_error) { /* already aborting */ }
		});
	});
}

/**
 * What kind of failure a storage error is: "quota" (out of space), "unknown" (the browser's storage failed, as on a disk
 * error), "aborted" (the transaction was cut short, as when the page closes), "newer" (a later version holds the
 * database), "closed" (the database closed under the work) or "other".
 * @param {any} error
 */
function error_kind(error) {
	switch (error?.name) {
		case "QuotaExceededError":
		case "NS_ERROR_DOM_QUOTA_REACHED":
			return "quota";
		case "UnknownError":
			return "unknown";
		case "AbortError":
			return "aborted";
		case "VersionError":
			return "newer";
		case "InvalidStateError":
		case "TransactionInactiveError":
			return "closed";
		default:
			return "other";
	}
}

/**
 * The SHA-256 of a file as 64 hex digits, through crypto.subtle, which only secure contexts have (https, or a page on this
 * computer). Elsewhere, null.
 * @param {Blob} blob
 */
async function sha256_of(blob) {
	if (!window.crypto?.subtle) return null;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { close_db, error_kind, idb_state, on_idb, open_db, request_of, sha256_of, transact };
