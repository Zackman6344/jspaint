// Shared by Pain-T's end-to-end tests. It needs no packages: importing it serves this client itself and starts Chrome,
// driven through the DevTools Protocol over Node's own WebSocket with trusted mouse and keyboard input. Pass --headful
// to watch. Set BROWSER_PATH if Chrome isn't in its default folder.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHROME = process.env.BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HEADFUL = process.argv.includes("--headful");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const results = [];
export function check(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
export const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

// --- A static server for the client ---
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".cur": "image/x-icon", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	let file = path.join(ROOT, decodeURIComponent(url.pathname));
	if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
	if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
	fs.readFile(file, (error, data) => {
		if (error) { res.writeHead(404); return res.end(); }
		res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
		res.end(data);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
export const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// --- Chrome over the DevTools Protocol ---
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pain-t-e2e-"));
// Hidden tabs keep waking once a second. Chrome would wake a tab hidden about a minute only once a minute, which
// two-tabs.e2e.mjs stands in for with a clock it jumps, so its checks can run past that minute.
const chrome = spawn(CHROME, [...(HEADFUL ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1400,900", "--disable-features=IntensiveWakeUpThrottling", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const browser_url = await new Promise((resolve, reject) => {
	let text = "";
	chrome.stderr.on("data", (chunk) => {
		text += chunk;
		const found = text.match(/DevTools listening on (ws:\/\/\S+)/);
		if (found) resolve(found[1]);
	});
	chrome.on("exit", () => reject(new Error(`Chrome exited: ${text}`)));
	setTimeout(() => reject(new Error("Chrome didn't start")), 20000);
});
const socket = new WebSocket(browser_url);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let next_id = 0;
const pending = new Map();
const listeners = [];
socket.onmessage = (message) => {
	const data = JSON.parse(message.data);
	if (data.id && pending.has(data.id)) {
		const { resolve, reject } = pending.get(data.id);
		pending.delete(data.id);
		if (data.error) reject(new Error(`${data.error.message} ${data.error.data ?? ""}`));
		else resolve(data.result);
	} else for (const listener of listeners) listener(data);
};
export const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = ++next_id;
	pending.set(id, { resolve, reject });
	socket.send(JSON.stringify({ id, method, params, sessionId }));
});
const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
export const page = (method, params) => cdp(method, params, sessionId);
export const page_errors = [];
listeners.push((data) => {
	if (data.sessionId !== sessionId || data.method !== "Runtime.exceptionThrown") return;
	const text = data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text;
	if (/not connected/i.test(text)) return; // Paint's own strokes try to send checks too, which throws without a server
	page_errors.push(text);
	console.log("[pageerror]", text.split("\n")[0]);
});
await page("Runtime.enable");
await page("Page.enable");
await page("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await page("Emulation.setFocusEmulationEnabled", { enabled: true });

// Runs an expression in the page and returns its value. Functions get their arguments as JSON.
export async function evaluate(fn, ...args) {
	const expression = typeof fn === "function" ? `(${fn})(...${JSON.stringify(args)})` : fn;
	const { result, exceptionDetails } = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
	return result.value;
}
export const mouse = {
	at: { x: 0, y: 0 },
	async move(x, y, steps = 1) {
		const { x: x0, y: y0 } = this.at;
		for (let i = 1; i <= steps; i++) await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + (x - x0) * i / steps, y: y0 + (y - y0) * i / steps });
		this.at = { x, y };
	},
	async down() { await page("Input.dispatchMouseEvent", { type: "mousePressed", ...this.at, button: "left", buttons: 1, clickCount: 1 }); },
	async up() { await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...this.at, button: "left", buttons: 0, clickCount: 1 }); },
	async click(x, y) { await this.move(x, y); await this.down(); await this.up(); },
};
const KEYS = { m: ["KeyM", 77], z: ["KeyZ", 90], y: ["KeyY", 89], Escape: ["Escape", 27], "=": ["Equal", 187], "-": ["Minus", 189] };
const MODIFIERS = { Shift: 8, Control: 2 };
export const keyboard = {
	async down(key, modifiers = []) {
		const [code, vk] = KEYS[key];
		const shifted = modifiers.includes("Shift") && key.length === 1 ? key.toUpperCase() : key;
		const text = key.length === 1 && !modifiers.includes("Control") ? shifted : undefined;
		await page("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: shifted, code, windowsVirtualKeyCode: vk, text, modifiers: modifiers.reduce((sum, m) => sum + MODIFIERS[m], 0) });
	},
	async up(key, modifiers = []) {
		const [code, vk] = KEYS[key];
		await page("Input.dispatchKeyEvent", { type: "keyUp", key: modifiers.includes("Shift") && key.length === 1 ? key.toUpperCase() : key, code, windowsVirtualKeyCode: vk, modifiers: modifiers.reduce((sum, m) => sum + MODIFIERS[m], 0) });
	},
	async press(key, modifiers = []) { await this.down(key, modifiers); await this.up(key, modifiers); await sleep(100); },
};

// Opens Paint and waits until `ready` holds in the page, then hides the connection window unless a test logs in with it.
export async function open_paint(ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0, { hide_connection_window = true } = {}) {
	await page("Page.navigate", { url: `${ORIGIN}/` });
	for (let i = 0; i < 200 && !(await evaluate(ready).catch(() => false)); i++) await sleep(100);
	await sleep(500);
	await overclock_id(evaluate);
	if (hide_connection_window) await evaluate(() => {
		for (const w of document.querySelectorAll(".window")) if (/Archipelago Connection Options/.test(w.textContent)) w.style.display = "none";
	});
	// point_on() aims between whole pixels, so Chrome has to hand the page the point as it's given.
	await mouse.move(2, 2);
	await evaluate(() => { addEventListener("pointermove", (event) => { window.__harness_move = [event.clientX, event.clientY]; }, { capture: true, once: true }); });
	await mouse.move(3.25, 4.75);
	const delivered = await evaluate(() => window.__harness_move ?? null);
	if (delivered?.[0] !== 3.25 || delivered?.[1] !== 4.75) throw new Error(`Chrome delivered the point (3.25, 4.75) as ${JSON.stringify(delivered)}`);
	const version = await cdp("Browser.getVersion");
	console.log(`browser: ${version.product}  canvas ${await evaluate(() => main_canvas.width + "x" + main_canvas.height)}`);
}

// The client point at the center of pixel (x, y) of the canvas or the goal image, worked out from where the image is
// now. It throws for a pixel off the image, and unless the point maps back to (x, y) through the rect Paint keeps for the
// image. Paint's hover position and Pick Color on the goal map a pointer with that rect; a press on the canvas updates it
// first, and M reads the live one. From a whole-number point, 26 of the goal's 600 rows can't be reached at all, so a
// check aiming there would land on the pixel next door. Paint updates its rect on scroll and resize events, which come
// with the next frame, so this waits for one first. Hiding the Tool Box moves the canvas without an update (upstream's
// own bug), so a test that hides it has to scroll, resize or press the canvas before aiming.
export const point_on = (which, x, y) => evaluate(async (which, x, y) => {
	const el = which === "goal" ? goal_canvas : main_canvas;
	if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= el.width || y >= el.height) throw new Error(`point_on(${which}, ${x}, ${y}) is off the ${el.width}x${el.height} image`);
	await new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 100); }); // a hidden page has no frames
	const r = el.getBoundingClientRect();
	const point = { x: r.left + (x + 0.5) * r.width / el.width, y: r.top + (y + 0.5) * r.height / el.height };
	const kept = which === "goal" ? window.goal_canvas_bounding_client_rect : window.canvas_bounding_client_rect;
	const back = { x: ~~((point.x - kept.left) / kept.width * el.width), y: ~~((point.y - kept.top) / kept.height * el.height) };
	if (back.x !== x || back.y !== y) throw new Error(`point_on(${which}, ${x}, ${y}) maps back to ${back.x},${back.y} through Paint's rect for the image`);
	return point;
}, which, x, y);

// Waits until auto copy's page holds the id it keeps its Overclock totals under (auto-copy.js), a moment after Paint
// loads, and returns it. Nothing is banked before then.
export async function overclock_id(run = evaluate) {
	for (let i = 0; i < 50; i++) {
		const id = await run(() => window.paint_hard_auto_copy?.overclock_record().page ?? null).catch(() => null);
		if (id) return id;
		await sleep(100);
	}
	throw new Error("auto copy's page never got its Overclock id");
}

// The Overclock record the pages wrote for a game (auto-copy.js): every page's totals added up, the fill note, and the
// bank's level they make.
export const overclock_stored = (session = "test") => evaluate((session) => {
	const prefix = `pain-t-overclock-page:${session}:`, stored = { spent: 0, used: 0, pages: 0 };
	for (const key of Object.keys(localStorage)) {
		if (!key.startsWith(prefix)) continue;
		const totals = JSON.parse(localStorage.getItem(key));
		stored.spent += totals.spent;
		stored.used += totals.used;
		stored.pages++;
	}
	stored.fill = JSON.parse(localStorage.getItem(`pain-t-overclock-fill:${session}`) ?? "null");
	stored.level = (stored.fill?.filled ?? 0) - stored.used;
	return stored;
}, session);

// Calls a function from src/functions.js. Without a server, Paint's own strokes throw "not connected" as they send.
export const call = (name, ...args) => evaluate(async (name, args) => {
	const functions = await import("/src/functions.js");
	try { functions[name](...args); } catch (error) { if (!/not connected/i.test(error.message)) throw error; }
}, name, args);

// Prints the tally, shuts Chrome and the server, and exits with 1 if anything failed.
export function finish() {
	const failed = results.filter((r) => !r.ok).length;
	console.log(`\n${results.length - failed}/${results.length} passed`);
	try { socket.close(); } catch { }
	chrome.kill();
	server.close();
	setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(failed ? 1 : 0); }, 500);
}
