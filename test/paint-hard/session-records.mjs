// What Paint keeps of its sessions, as the suites that check it read it (sessions.e2e.mjs, storage.e2e.mjs): a record in
// IndexedDB (task 7.4), or one in localStorage from before. RECORDS is a script for the page to run before it loads; the
// functions below call it.
import { evaluate } from "./harness.mjs";

// The page's side: a pattern for test rows that no shift or cut keeps, a digest of RGBA bytes, a rectangle of an image's
// digest ("outside" past its edges), a PNG decoded as UPNG decodes it, Paint's database opened without making it where it
// doesn't exist (null after 5 s of waiting), a session's record as stored (a digest of all of it, its canvas's size and a
// rectangle of it, its goal's size and digest, and its other fields), and every write to a session record since the page
// loaded: "sessions:<id>" for a put into IndexedDB and "image#<id>" for a localStorage write, with the times of the puts
// in `puts`, and of the canvas's PNG encodes, which begin each save, in `encodes`.
export const RECORDS = `window.__t = {
	writes: [],
	puts: [],
	encodes: [],
	pattern: (x, y) => [(x * 7 + y * 3) & 255, (x * 5 + y * 11 + 64) & 255, (x ^ (y * 3)) & 255],
	digest(data) { let h = 2166136261; for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); },
	rect(image, x0, y0, w, h) {
		if (x0 + w > image.width || y0 + h > image.height) return "outside";
		const out = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) out.set(image.data.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x0 + w) * 4), y * w * 4);
		return __t.digest(out);
	},
	canvas(ctx, x0, y0, w, h) { return __t.rect(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height), x0, y0, w, h); },
	async png(source) {
		const buffer = typeof source === "string" ? await (await fetch(source)).arrayBuffer() : source instanceof Blob ? await source.arrayBuffer() : source;
		const png = UPNG.decode(buffer);
		return { width: png.width, height: png.height, data: new Uint8Array(UPNG.toRGBA8(png)[0]) };
	},
	db() {
		return new Promise((resolve) => {
			let request, gave_up = false;
			try { request = indexedDB.open("pain-t"); } catch { resolve(null); return; }
			request.onupgradeneeded = () => request.transaction.abort();
			request.onsuccess = () => { if (gave_up) request.result.close(); else resolve(request.result); };
			request.onerror = (event) => { event.preventDefault(); resolve(null); };
			// An open waits behind another tab's upgrade for as long as that is blocked.
			setTimeout(() => { gave_up = true; resolve(null); }, 5000);
		});
	},
	async read(store, key) {
		const db = await __t.db();
		if (!db) return null;
		try {
			if (!db.objectStoreNames.contains(store)) return null;
			return await new Promise((resolve, reject) => {
				const source = db.transaction(store).objectStore(store);
				const request = key === undefined ? source.getAll() : source.get(key);
				request.onsuccess = () => resolve(request.result ?? null);
				request.onerror = () => reject(request.error);
			});
		} finally { db.close(); }
	},
	async drop(store, key) {
		const db = await __t.db();
		if (!db) return;
		try {
			await new Promise((resolve, reject) => {
				const transaction = db.transaction(store, "readwrite");
				transaction.objectStore(store).delete(key);
				transaction.oncomplete = resolve;
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { db.close(); }
	},
	async record(id, area) {
		const stored = await __t.read("sessions", id);
		if (stored) {
			const bytes = new Uint8Array(await stored.canvas.arrayBuffer());
			const canvas = await __t.png(bytes.slice().buffer).catch(() => null);
			const goal = stored.goal ? await __t.read("goals", stored.goal) : null;
			const goal_png = goal?.blob ? await __t.png(goal.blob).catch(() => null) : null;
			const fields = { id: stored.id, version: stored.version, goal_sha: stored.goal, colors: stored.colors, connection: stored.connection, game: stored.game ?? null, width: stored.width, height: stored.height, final: [stored.final_width, stored.final_height], saved_at: stored.saved_at };
			return { from: "idb", raw: __t.digest(bytes) + "-" + __t.digest(new TextEncoder().encode(JSON.stringify(fields))), bytes: bytes.length, type: stored.canvas.type, size: canvas && canvas.width + "x" + canvas.height, area: canvas && area ? __t.rect(canvas, ...area) : null, goal_found: !!goal, goal: goal_png && goal_png.width + "x" + goal_png.height, goal_digest: goal_png && __t.digest(goal_png.data), keys: Object.keys(stored).sort(), ...fields };
		}
		const raw = localStorage.getItem("image#" + id);
		if (!raw) return null;
		let record = JSON.parse(raw);
		try { const parsed = JSON.parse(record); if (parsed?.canvas) record = parsed; } catch { }
		if (typeof record === "string") record = { canvas: record };
		const canvas = await __t.png(record.canvas).catch(() => null), goal = record.goal ? await __t.png(record.goal).catch(() => null) : null;
		return { from: "local", raw: __t.digest(new TextEncoder().encode(raw)), size: canvas && canvas.width + "x" + canvas.height, area: canvas && area ? __t.rect(canvas, ...area) : null, goal: goal && goal.width + "x" + goal.height, goal_digest: goal && __t.digest(goal.data), game: record.game ?? null, colors: record.colors ?? null, connection: record.connection_info ?? null };
	},
	local_keys: () => Object.keys(localStorage).filter((key) => key.startsWith("image#")),
	async forget(id) {
		const record = await __t.read("sessions", id);
		await __t.drop("sessions", id);
		if (record?.goal && !((await __t.read("sessions")) ?? []).some((other) => other.goal === record.goal)) await __t.drop("goals", record.goal);
		for (const suffix of ["", "_goal", "_connection_info", "_colors"]) localStorage.removeItem("image#" + id + suffix);
	},
};
(() => {
	const set_item = Storage.prototype.setItem;
	Storage.prototype.setItem = function (key, value) {
		if (this === localStorage && String(key).startsWith("image#")) __t.writes.push(String(key));
		return set_item.call(this, key, value);
	};
	const to_blob = HTMLCanvasElement.prototype.toBlob;
	HTMLCanvasElement.prototype.toBlob = function (...args) {
		if (typeof main_canvas !== "undefined" && this === main_canvas) __t.encodes.push(performance.now());
		return to_blob.apply(this, args);
	};
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (value, ...rest) {
		if (this.name === "sessions") {
			__t.writes.push("sessions:" + value?.id);
			__t.puts.push({ id: value?.id, at: performance.now(), width: value?.width ?? null });
		}
		return put.call(this, value, ...rest);
	};
})();`;

// A session's record as stored, with a rectangle [x, y, width, height] of its canvas's digest, or null.
export const record_of = (id, area = null) => evaluate((id, area) => __t.record(id, area), id, area);
// Removes a session's record from IndexedDB and localStorage, behind Paint's back, and its goal if no other session
// refers to it.
export const forget = (id) => evaluate((id) => __t.forget(id), id);
// The session records left in localStorage.
export const local_keys = () => evaluate(() => __t.local_keys());
// How many writes went to a session's record since the page loaded.
export const writes_of = (id) => evaluate((id) => __t.writes.filter((key) => key === "sessions:" + id || key === "image#" + id).length, id);
