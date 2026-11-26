// Shared by Pain-T's end-to-end tests. It needs no packages: importing it serves this client from two origins and starts
// a browser, driven with trusted mouse and keyboard input over Node's own WebSocket: Chrome, Edge or Brave through the
// DevTools Protocol, or Firefox through WebDriver BiDi. Pick one with --browser=chrome|edge|brave|firefox or
// PAIN_T_BROWSER (Chrome when neither names one), and set BROWSER_PATH if it isn't in its default folder. The browser's
// profile and the files tests serve go under PAIN_T_TMP, or the system's temp folder when it's unset. Pass --headful to
// watch. PAIN_T_CALL_LIMIT_MS sets how long a call to the browser may wait for its answer, and PAIN_T_FIREFOX_PREFS and
// PAIN_T_FIREFOX_ARGS hand Firefox prefs and arguments for one run.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HEADFUL = process.argv.includes("--headful");
const DEFAULT_PATHS = {
	chrome: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	edge: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	brave: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
	firefox: "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
};
const flag = process.argv.findIndex((arg) => arg === "--browser" || arg.startsWith("--browser="));
const named = flag < 0 ? null : process.argv[flag].startsWith("--browser=") ? process.argv[flag].slice("--browser=".length) : process.argv[flag + 1];
export const BROWSER = (named || process.env.PAIN_T_BROWSER || "chrome").toLowerCase();
if (!(BROWSER in DEFAULT_PATHS)) throw new Error(`--browser and PAIN_T_BROWSER take ${Object.keys(DEFAULT_PATHS).join(", ")}, not "${BROWSER}"`);
export const firefox = BROWSER === "firefox";
export const chromium = !firefox; // Chrome, Edge and Brave
const EXECUTABLE = process.env.BROWSER_PATH || DEFAULT_PATHS[BROWSER];
export const TMP = path.resolve(process.env.PAIN_T_TMP || os.tmpdir());
fs.mkdirSync(TMP, { recursive: true });
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const results = [];
export function check(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
export const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

// --- The client, served from two origins ---
// Both serve the client repo, and under /__test__/ a folder of this run's own, TEST_FILES, for the goals and uploads
// tests make. Files are streamed with their length. Switches in any request's query: cors=1 adds
// Access-Control-Allow-Origin: *, delay=<ms> holds the answer that long, status=<code> answers that status with no
// file, and cache=<seconds> answers cache-control: max-age=<seconds>, as a static host does, where every other answer
// says no-store, which keeps a page out of the browser's back-forward cache. A POST or PUT under /__test__/ stores its
// body there. A request from another site's page, by its Origin, or for another Host than the server's own gets 403. One
// the server can't read gets 400, and one it fails on 500: the servers go on. `requests` logs every request to either
// origin with the status answered, null for one whose connection closed before its file's answer began.
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".cur": "image/x-icon", ".webmanifest": "application/manifest+json" };
export const TEST_FILES = fs.mkdtempSync(path.join(TMP, "pain-t-files-"));
export const requests = [];
// How many requests asked for a path, at either origin or at "main" or "second" alone.
export const request_count = (pathname, origin = null) => requests.filter((r) => r.path === pathname && (!origin || r.origin === origin)).length;
// Each answer's entry in `requests`, for the 500 the servers give a request they fail on.
const entry_of = new WeakMap();
const serve = (origin) => async (req, res) => {
	const entry = { origin, method: req.method, path: null, search: "", status: null, at: Date.now() };
	requests.push(entry);
	entry_of.set(res, entry);
	let url, base, file;
	try {
		url = new URL(req.url, "http://x");
		const name = decodeURIComponent(url.pathname);
		if (name.includes("\0")) throw new Error("a NUL in the path");
		base = name.startsWith("/__test__/") ? TEST_FILES : ROOT;
		file = path.join(base, base === TEST_FILES ? name.slice("/__test__/".length) : name);
	} catch {
		entry.status = 400;
		res.writeHead(400, { "cache-control": "no-store" });
		return res.end();
	}
	entry.path = url.pathname;
	entry.search = url.search;
	const switches = url.searchParams, headers = { "cache-control": "no-store" };
	if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || (req.headers.origin !== undefined && !own_origins.has(req.headers.origin))) {
		entry.status = 403;
		res.writeHead(403, { "cache-control": "no-store" });
		return res.end();
	}
	if (switches.get("cors") === "1") Object.assign(headers, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, POST, PUT", "access-control-allow-headers": "content-type" });
	if (/^\d+$/.test(switches.get("cache") ?? "")) headers["cache-control"] = `max-age=${Number(switches.get("cache"))}`;
	const answer = (status, more = {}) => {
		entry.status = status;
		res.writeHead(status, { ...headers, ...more });
	};
	const delay = Number(switches.get("delay")) || 0;
	if (delay > 0) await sleep(delay);
	if (file !== base && !file.startsWith(base + path.sep)) { answer(403); return res.end(); }
	if (req.method === "OPTIONS") { answer(204); return res.end(); }
	const status = Number(switches.get("status")) || 0;
	if (status && !(Number.isInteger(status) && status >= 200 && status <= 599)) { answer(400); return res.end(); }
	if (status) { answer(status, { "content-type": "text/plain" }); return res.end(`status ${status}`); }
	if (req.method === "POST" || req.method === "PUT") {
		if (base !== TEST_FILES || file === base) { answer(405); return res.end(); }
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const out = fs.createWriteStream(file);
		return pipeline(req, out, (error) => {
			if (error) { answer(500); return res.end(); }
			answer(201, { "content-type": "application/json" });
			res.end(JSON.stringify({ path: url.pathname, bytes: out.bytesWritten }));
		});
	}
	if (req.method !== "GET" && req.method !== "HEAD") { answer(405); return res.end(); }
	let stat = await fs.promises.stat(file).catch(() => null);
	if (stat?.isDirectory()) {
		file = path.join(file, "index.html");
		stat = await fs.promises.stat(file).catch(() => null);
	}
	if (!stat?.isFile()) { answer(404); return res.end(); }
	// A page that reloads or leaves closes its requests. One closed during the waits above gets no answer, and its file
	// is never opened: a read stream can't be piped into a closed connection, and would stay open.
	if (res.destroyed) return;
	answer(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": stat.size });
	if (req.method === "HEAD") return res.end();
	pipeline(fs.createReadStream(file), res, () => { });
};
const servers = [], own_origins = new Set();
const listen = async (origin) => {
	const handle = serve(origin);
	const server = http.createServer((req, res) => handle(req, res).catch(() => { try { if (!res.headersSent) { res.writeHead(500, { "cache-control": "no-store" }); entry_of.get(res).status = 500; } res.end(); } catch { } }));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	own_origins.add(`http://127.0.0.1:${server.address().port}`);
	return `http://127.0.0.1:${server.address().port}`;
};
export const ORIGIN = await listen("main");
// Another port is another origin: a page from ORIGIN reads from this one only with CORS.
export const SECOND_ORIGIN = await listen("second");

// --- The browser's processes ---
const IMAGE = path.basename(EXECUTABLE).toLowerCase();
const profile = fs.mkdtempSync(path.join(TMP, "pain-t-e2e-"));
let child = null, output = "", spawn_error = null;
const note_output = (chunk) => { if (output.length < 8000) output += chunk; };
const started = (spawned) => {
	spawned.on("error", (error) => { spawn_error = error; });
	return spawned;
};
// The browser's processes still running, read from Windows: those of its program whose command line names this run's
// profile, and every process of the same program they started. Firefox's content processes don't name the profile, and
// a browser that relaunched itself detached from the process the harness spawned is found by the profile alone. Each
// comes with its PID, its parent's PID, its command line and `created`, the time Windows made it, a string of digits
// (100 ns ticks, UTC), or null where Windows gave none. A PID goes to a new process once its own has gone, and a PID
// with its `created` names one process for good. When Windows can't be asked (PowerShell doesn't start, runs past 30 s,
// or prints something else than a list of processes) the list is empty and its `failed` says why.
export function browser_processes() {
	const script = "Get-CimInstance Win32_Process -Filter \"Name='$env:PAIN_T_IMAGE'\" | Select-Object ProcessId, ParentProcessId, CommandLine, @{n='Created';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress";
	let text = "", all = [];
	try {
		text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, PAIN_T_IMAGE: IMAGE }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30000 }).trim();
		all = text ? [].concat(JSON.parse(text)) : [];
		if (!all.every((p) => Number.isInteger(p?.ProcessId))) throw new Error("PowerShell printed something else than a list of processes");
	} catch (error) {
		return Object.assign([], { failed: `${String(error.stderr || error.message).trim().split("\n")[0].slice(0, 200)}${text ? `: ${text.slice(0, 100)}` : ""}` });
	}
	// The profile as a whole folder name, in any letter case, as Windows reads a path: followed by a quote, a space or the
	// line's end, not by more of a name.
	const folder = profile.toLowerCase();
	const names_profile = (p) => {
		const line = (p.CommandLine ?? "").toLowerCase();
		for (let at = line.indexOf(folder); at >= 0; at = line.indexOf(folder, at + 1)) if (/^(?:["\s]|$)/.test(line.slice(at + folder.length))) return true;
		return false;
	};
	const by_pid = new Map(all.map((p) => [p.ProcessId, p]));
	const mine = new Set(all.filter(names_profile).map((p) => p.ProcessId));
	// Windows hands a dead process's PID to new ones, so a child has to have been created after its parent.
	// A process whose creation time Windows didn't give is never taken as a child, and has no child taken.
	const created = (p) => typeof p.Created === "string" && /^\d+$/.test(p.Created) ? BigInt(p.Created) : null;
	const child_of_mine = (p) => {
		if (!mine.has(p.ParentProcessId)) return false;
		const parent = created(by_pid.get(p.ParentProcessId)), own = created(p);
		return parent !== null && own !== null && parent <= own;
	};
	for (let grew = true; grew;) {
		grew = false;
		for (const p of all) if (!mine.has(p.ProcessId) && child_of_mine(p)) { mine.add(p.ProcessId); grew = true; }
	}
	return all.filter((p) => mine.has(p.ProcessId)).map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, command_line: p.CommandLine ?? "", created: created(p)?.toString() ?? null }));
}
// Kills what a look-up listed, each with its tree, the heads of the trees first: the rest have mostly gone with them
// by their turn. Windows may by then have handed a listed PID to a new process, so one PowerShell takes each in turn,
// holds the process open, which keeps its PID from going to another, and looks it up again: taskkill runs only for a
// process still created at the time listed. The hold is Get-Process's Handle, tested by its value: Windows PowerShell
// gives $null for a process it can't open, with no error. A process that has gone, one it can't hold open, one made
// since under the same PID, and one listed with no creation time are passed over, and one it can't hold open goes only
// with the tree of a head named before it. A look-up that failed is said: it killed nothing. So is a kill whose
// PowerShell doesn't start, runs past 60 s or exits with an error, with the PIDs it may have left running. Returns why
// the kill couldn't run, or null.
function kill_trees(listed) {
	if (listed.failed) console.log(`[harness] Windows couldn't be asked for the browser's processes, so none was killed: ${listed.failed}`);
	const pids = new Set(listed.map((p) => p.pid));
	const named = [...listed.filter((p) => !pids.has(p.parent)), ...listed.filter((p) => pids.has(p.parent))].filter((p) => p.created);
	if (!named.length) return null;
	// The script ends with exit 0: PowerShell's own exit code is 1 when the last process it names had gone.
	const script = "foreach ($entry in $env:PAIN_T_KILL.Split(' ')) { $id, $created = $entry.Split(':'); $held = Get-Process -Id $id -ErrorAction SilentlyContinue; if (-not $held) { continue }; try { $handle = $held.Handle } catch { $handle = $null }; if (-not $handle) { continue }; $now = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\"; if ($now -and $now.CreationDate.ToUniversalTime().Ticks.ToString() -eq $created) { taskkill.exe /T /F /PID $id 2>&1 | Out-Null } }; exit 0";
	try {
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, PAIN_T_KILL: named.map((p) => `${p.pid}:${p.created}`).join(" ") }, stdio: "ignore", windowsHide: true, timeout: 60000 });
		return null;
	} catch (error) {
		const why = error.code ?? `exit code ${error.status}`;
		console.log(`[harness] the kill couldn't run (${why}): ${named.map((p) => p.pid).join(", ")} may still be running`);
		return why;
	}
}
// Polls `probe` every 50 ms until it gives something, for up to 20 s.
const wait_for = async (what, probe) => {
	for (let i = 0; i < 400; i++) {
		if (spawn_error) throw new Error(`${EXECUTABLE} didn't start: ${spawn_error.message}`);
		const found = probe();
		if (found) return found;
		await sleep(50);
	}
	throw new Error(`${what} didn't appear in 20 s${child && child.exitCode !== null ? ` (the process the harness started exited with ${child.exitCode})` : ""}: ${output.slice(0, 600)}`);
};
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };

// --- One socket, for either protocol ---
let socket = null, next_id = 0;
const pending = new Map(), listeners = [];
const connect = async (url) => {
	socket = new WebSocket(url);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`no WebSocket at ${url}`)); });
	// A browser that closes or dies answers nothing more: the calls waiting on it fail, so a run stops rather than hang.
	socket.onclose = () => {
		for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("the browser's connection closed")); }
		pending.clear();
	};
	socket.onmessage = (message) => {
		const data = JSON.parse(message.data);
		// A tab that closes answers nothing more: the calls waiting on it fail, and so do calls made to it after.
		if (data.method === "Target.detachedFromTarget") {
			closed_sessions.add(data.params.sessionId);
			for (const [id, waiting] of pending) if (waiting.session === data.params.sessionId) { pending.delete(id); clearTimeout(waiting.timer); waiting.reject(new Error(`${waiting.method}: the tab closed`)); }
		}
		if (data.id && pending.has(data.id)) {
			const { resolve, reject, timer } = pending.get(data.id);
			pending.delete(data.id);
			clearTimeout(timer);
			if (data.error) reject(new Error(typeof data.error === "string" ? `${data.error}: ${data.message}` : `${data.error.message} ${data.error.data ?? ""}`));
			else resolve(data.result);
		} else for (const listener of listeners) listener(data);
	};
};
// The harness's two limits, in ms, which a test may change for a step. No call to the browser waits longer than `call`
// for its answer: 120 s, or PAIN_T_CALL_LIMIT_MS. No navigation or reload waits longer than `leave` for the document it
// leaves to go: 20 s.
export const limits = { call: Number(process.env.PAIN_T_CALL_LIMIT_MS) || 120000, leave: 20000 };
const closed_sessions = new Set();
const send = (message, limit = limits.call) => new Promise((resolve, reject) => {
	if (socket.readyState !== WebSocket.OPEN) return reject(new Error(`${message.method}: the browser's connection is closed`));
	if (message.sessionId && closed_sessions.has(message.sessionId)) return reject(new Error(`${message.method}: the tab is closed`));
	const id = ++next_id;
	const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`${message.method}: no answer in ${limit / 1000} s`)); }, limit);
	timer.unref();
	pending.set(id, { resolve, reject, timer, session: message.sessionId, method: message.method });
	socket.send(JSON.stringify({ id, ...message }));
});
// Raw protocol calls, for what the helpers below don't cover: cdp() and page() in Chrome, Edge and Brave, bidi() in Firefox.
export const cdp = (method, params = {}, sessionId) => chromium ? send({ method, params, sessionId }) : Promise.reject(new Error(`cdp(${method}): ${BROWSER} doesn't speak the DevTools Protocol`));
export const bidi = (method, params = {}) => firefox ? send({ method, params }) : Promise.reject(new Error(`bidi(${method}): ${BROWSER} doesn't speak WebDriver BiDi`));

export const page_errors = [];
const note_page_error = (text) => {
	if (/not connected/i.test(text)) return; // Paint's own strokes try to send checks too, which throws without a server
	page_errors.push(text);
	console.log("[pageerror]", text.split("\n")[0]);
};

// --- Chrome, Edge and Brave, over the DevTools Protocol ---
const CDP_MODIFIERS = { Alt: 1, Control: 2, Shift: 8 };
const KEYS = { m: ["KeyM", 77], w: ["KeyW", 87], y: ["KeyY", 89], z: ["KeyZ", 90], Escape: ["Escape", 27], "=": ["Equal", 187], "-": ["Minus", 189] };
async function cdp_tab(background) {
	const { targetId } = await cdp("Target.createTarget", { url: "about:blank", background });
	const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
	const call = (method, params = {}) => cdp(method, params, sessionId);
	await call("Runtime.enable");
	await call("Page.enable");
	return {
		id: targetId, session: sessionId, call,
		async evaluate(fn, ...args) {
			const expression = typeof fn === "function" ? `(${fn})(...${JSON.stringify(args)})` : fn;
			const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value;
		},
		navigate: (url) => call("Page.navigate", { url }),
		reload: () => call("Page.reload", {}),
		add_init_script: async (source) => (await call("Page.addScriptToEvaluateOnNewDocument", { source })).identifier,
		remove_init_script: (id) => call("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }),
		close: () => cdp("Target.closeTarget", { targetId }),
	};
}
// Windows sets __COMPAT_LAYER in some sessions (to DetectorsAppHealth, in the ones seen). Edge 158 then relaunches
// itself without it, detached from the process the harness spawned, which exits at once. The browser starts without
// the variable, so it is the spawned process in every session.
const BROWSER_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "__COMPAT_LAYER"));
async function launch_chromium() {
	// Hidden tabs keep waking once a second. Chrome would wake a tab hidden about a minute only once a minute, which
	// two-tabs.e2e.mjs stands in for with a clock it jumps, so its checks can run past that minute.
	child = started(spawn(EXECUTABLE, [...(HEADFUL ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1400,900", "--disable-features=IntensiveWakeUpThrottling", "about:blank"], { stdio: ["ignore", "ignore", "pipe"], env: BROWSER_ENV }));
	child.stderr.on("data", note_output);
	// The port Chromium writes to DevToolsActivePort in the profile. A browser that relaunched itself detached, as Edge
	// 158 does out of a compatibility layer, prints nothing on the stderr Chrome prints it to.
	const [port, at] = await wait_for("DevToolsActivePort", () => {
		const lines = read(path.join(profile, "DevToolsActivePort")).split(/\r?\n/);
		return lines[1]?.startsWith("/devtools/browser/") ? lines : null;
	});
	await connect(`ws://127.0.0.1:${port}${at}`);
	const { product } = await cdp("Browser.getVersion");
	const main = await cdp_tab(false);
	listeners.push((data) => {
		if (data.sessionId !== main.session || data.method !== "Runtime.exceptionThrown") return;
		note_page_error(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
	});
	listeners.push((data) => {
		if (data.method !== "Page.javascriptDialogOpening") return;
		if (data.sessionId === main.session) note_page_error(`a dialog opened (${data.params.type}): ${data.params.message}`);
		send({ method: "Page.handleJavaScriptDialog", params: { accept: data.params.type === "beforeunload" }, sessionId: data.sessionId }).catch(() => { });
	});
	await main.call("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
	await main.call("Emulation.setFocusEmulationEnabled", { enabled: true });
	return {
		product, main,
		mouse_move: (x, y) => main.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
		mouse_button: (type, at) => main.call("Input.dispatchMouseEvent", { type: type === "down" ? "mousePressed" : "mouseReleased", ...at, button: "left", buttons: type === "down" ? 1 : 0, clickCount: 1 }),
		key(type, key, modifiers) {
			const [code, vk] = KEYS[key];
			const flags = modifiers.reduce((sum, m) => sum + CDP_MODIFIERS[m], 0);
			const shown = modifiers.includes("Shift") && key.length === 1 ? key.toUpperCase() : key;
			const text = type === "down" && key.length === 1 && !modifiers.includes("Control") ? shown : undefined;
			return main.call("Input.dispatchKeyEvent", { type: type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown", key: shown, code, windowsVirtualKeyCode: vk, text, modifiers: flags });
		},
		new_tab: (background) => cdp_tab(background),
		grant_persistent_storage: (origin) => cdp("Browser.setPermission", { permission: { name: "persistent-storage" }, setting: "granted", origin }),
		close: () => cdp("Browser.close"),
	};
}

// --- Firefox, over WebDriver BiDi ---
// The profile's user.js: no default-browser check, welcome page, telemetry or update check. No storage prompt prefs:
// with dom.storageManager.prompt.testing set, persist() keeps that pref's answer even for an origin
// grant_persistent_storage() granted, and without them it waits on a prompt nobody answers, as a player's can.
const FIREFOX_PREFS = {
	"browser.shell.checkDefaultBrowser": false,
	"browser.aboutwelcome.enabled": false,
	"browser.startup.homepage_override.mstone": "ignore",
	"datareporting.policy.dataSubmissionEnabled": false,
	"toolkit.telemetry.reportingpolicy.firstRun": false,
	"app.update.disabledForTesting": true,
};
// What a test hands Firefox for one run: PAIN_T_FIREFOX_PREFS, a JSON object of prefs that go into user.js after the
// ones above, such as a quota small enough to fill ({"dom.quotaManager.temporaryStorage.fixedLimit": 51200}, in KiB),
// and PAIN_T_FIREFOX_ARGS, a JSON list of more arguments for its command line, which go before the page's address.
const from_env = (name, fallback) => {
	if (!process.env[name]) return fallback;
	// A value that can't be read fails the start, and a second start would read the same value.
	const refuse = (why) => { throw Object.assign(new Error(`${name} ${why}`), { asked_wrong: true }); };
	let value;
	try { value = JSON.parse(process.env[name]); } catch (error) { refuse(`isn't JSON: ${error.message}`); }
	if (Array.isArray(fallback) ? !Array.isArray(value) || !value.every((arg) => typeof arg === "string") : !value || typeof value !== "object" || Array.isArray(value)) refuse(`has to be a JSON ${Array.isArray(fallback) ? "list of strings" : "object"}`);
	return value;
};
const BIDI_KEYS = { Escape: "\uE00C" };
const BIDI_MODIFIERS = { Alt: "\uE00A", Control: "\uE009", Shift: "\uE008" };
// A script's result as a JavaScript value, from BiDi's remote value.
const from_remote = (value) => {
	switch (value.type) {
		case "undefined": return undefined;
		case "null": return null;
		case "string": case "boolean": return value.value;
		case "number": return typeof value.value === "number" ? value.value : Number(value.value); // NaN, -0, Infinity, -Infinity
		case "bigint": return BigInt(value.value);
		case "array": return value.value.map(from_remote);
		case "object": return Object.fromEntries(value.value.map(([key, item]) => [typeof key === "string" ? key : from_remote(key), from_remote(item)]));
		default: return {};
	}
};
function bidi_tab(context) {
	return {
		id: context,
		// A function's value comes back as JSON, as the DevTools Protocol's returnByValue gives it.
		async evaluate(fn, ...args) {
			const expression = typeof fn === "function" ? `(async () => { const value = await (${fn})(...${JSON.stringify(args)}); return value === undefined ? undefined : JSON.stringify(value); })()` : fn;
			const reply = await bidi("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: "none" });
			if (reply.type === "exception") throw new Error(reply.exceptionDetails.text);
			const value = from_remote(reply.result);
			return typeof fn === "function" && typeof value === "string" ? JSON.parse(value) : value;
		},
		navigate: (url) => bidi("browsingContext.navigate", { context, url, wait: "none" }),
		reload: () => bidi("browsingContext.reload", { context, wait: "none" }),
		// Run through an indirect eval, so the script's top-level var and function declarations become globals, as in the
		// classic script the DevTools Protocol runs; and in this tab only, as there.
		add_init_script: async (source) => (await bidi("script.addPreloadScript", { functionDeclaration: `() => { (0, eval)(${JSON.stringify(source)}); }`, contexts: [context] })).script,
		remove_init_script: (id) => bidi("script.removePreloadScript", { script: id }),
		close: () => bidi("browsingContext.close", { context }),
	};
}
async function launch_firefox() {
	const prefs = { ...FIREFOX_PREFS, ...from_env("PAIN_T_FIREFOX_PREFS", {}) }, more = from_env("PAIN_T_FIREFOX_ARGS", []);
	fs.writeFileSync(path.join(profile, "user.js"), Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join("\n") + "\n");
	// firefox.exe is a launcher: the browser runs as its child, and the browser's content processes as the browser's.
	child = started(spawn(EXECUTABLE, [...(HEADFUL ? [] : ["--headless"]), "--remote-debugging-port=0", "-no-remote", "-profile", profile, ...more, "about:blank"], { stdio: ["ignore", "pipe", "pipe"], env: { ...BROWSER_ENV, MOZ_CRASHREPORTER_DISABLE: "1" } }));
	child.stdout.on("data", note_output);
	child.stderr.on("data", note_output);
	// The port Firefox writes to WebDriverBiDiServer.json in the profile as its BiDi server starts.
	const server = await wait_for("WebDriverBiDiServer.json", () => { try { return JSON.parse(read(path.join(profile, "WebDriverBiDiServer.json"))); } catch { return null; } });
	await connect(`ws://${server.ws_host}:${server.ws_port}/session`);
	// Firefox answers session.new within a second or two. With four browsers going it has taken the connection and then
	// answered nothing in 120 s, in 2 starts of the fix round of session 7a. So this call waits 30 s, and the start is
	// made again.
	const { capabilities } = await send({ method: "session.new", params: { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } } }, Math.min(limits.call, 30000));
	await bidi("session.subscribe", { events: ["log.entryAdded", "browsingContext.userPromptOpened"] });
	// Firefox can still be replacing its first tab's browsing context as it starts: one that has gone by the time its
	// viewport is set is read again, up to 5 times.
	let main = null;
	for (let tries = 1; !main; tries++) {
		const { contexts } = await bidi("browsingContext.getTree", { maxDepth: 0 });
		try {
			await bidi("browsingContext.setViewport", { context: contexts[0].context, viewport: { width: 1400, height: 900 }, devicePixelRatio: 1 });
			main = bidi_tab(contexts[0].context);
		} catch (error) {
			if (tries === 5) throw error;
			await sleep(200);
		}
	}
	// The page's uncaught exceptions, as Runtime.exceptionThrown gives Chromium's. Firefox logs other errors of the page's as
	// "javascript" too, such as a fetch CORS refused, but with no stack and a text not named for an error.
	listeners.push((data) => {
		const entry = data.params, frames = entry?.stackTrace?.callFrames ?? [];
		if (data.method !== "log.entryAdded" || entry.type !== "javascript" || entry.level !== "error" || entry.source?.context !== main.id) return;
		if (!frames.length && !/^(uncaught exception: |[A-Za-z]*(Error|Exception)\b)/.test(entry.text)) return;
		note_page_error([entry.text, ...frames.map((f) => `    at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)].join("\n"));
	});
	listeners.push((data) => {
		if (data.method === "browsingContext.userPromptOpened" && data.params.context === main.id) note_page_error(`a dialog opened (${data.params.type}): ${data.params.message}`);
	});
	const act = (source) => bidi("input.performActions", { context: main.id, actions: [source] });
	return {
		product: `Firefox/${capabilities.browserVersion}`, main,
		// Firefox delivers whole-number points only, rounding the rest.
		mouse_move: (x, y) => act({ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: Math.round(x), y: Math.round(y) }] }),
		mouse_button: (type) => act({ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: type === "down" ? "pointerDown" : "pointerUp", button: 0 }] }),
		// Modifiers are keys held down in BiDi: pressed before the key and let go after it.
		key(type, key, modifiers) {
			const value = BIDI_KEYS[key] ?? (modifiers.includes("Shift") && key.length === 1 ? key.toUpperCase() : key);
			const held = modifiers.map((m) => BIDI_MODIFIERS[m]);
			const actions = type === "down"
				? [...held.map((v) => ({ type: "keyDown", value: v })), { type: "keyDown", value }]
				: [{ type: "keyUp", value }, ...held.reverse().map((v) => ({ type: "keyUp", value: v }))];
			return act({ type: "key", id: "keyboard", actions });
		},
		new_tab: async (background) => bidi_tab((await bidi("browsingContext.create", { type: "tab", background })).context),
		grant_persistent_storage: (origin) => bidi("permissions.setPermission", { descriptor: { name: "persistent-storage" }, state: "granted", origin }),
		close: () => bidi("browser.close", {}),
	};
}

// --- Closing ---
let closing = null, shut = false, removed = false;
// Closes the browser through its protocol and waits up to 30 s for the process the harness started to exit: Chrome
// itself, or Firefox's launcher, which exits after the browser. The processes they started go with them. When that
// process had already gone, as a browser that relaunched itself detached leaves it, when it doesn't exit, or when
// `look` asks, the browser's processes are looked up in Windows: 1 s a look, and up to 9 s on a loaded machine. Looks
// go on while one lists a process, until a look that began 5 s or more after the first one returned, and for a
// detached browser that was asked to close, which had no process to wait on, 30 s or more after it was asked. What
// that last look lists is left: it is killed, with its tree. A process Windows lists without a command line is on its
// way out, and isn't counted or killed. Returns how many were left, with their PIDs and kinds, in `unseen` why Windows
// couldn't be asked, when the last look failed, and in `kill_failed` why the kill couldn't run, when it couldn't.
// finish() calls it.
export function close_browser({ look = false } = {}) {
	return closing ??= (async () => {
		const exited = () => child.exitCode !== null || child.signalCode !== null;
		const detached = !child || exited();
		if (driver) await Promise.race([driver.close().catch(() => { }), sleep(5000)]);
		try { socket?.close(); } catch { }
		const asked = Date.now();
		// A browser that never took the harness's connection wasn't asked to close: nothing waits for it to exit.
		while (driver && !detached && !exited() && Date.now() - asked < 30000) await sleep(50);
		let left = [], unseen = null, kill_failed = null;
		if (detached || !exited() || look) {
			const running = () => {
				const listed = browser_processes();
				unseen = listed.failed ?? null;
				return listed.filter((p) => p.command_line);
			};
			left = running();
			const first = Date.now();
			for (let last = false; (left.length || unseen) && !last;) {
				await sleep(250);
				last = Date.now() - first >= 5000 && (!detached || !driver || Date.now() - asked >= 30000);
				left = running();
			}
			kill_failed = kill_trees(left);
		}
		shut = true;
		const kind = (p) => p.command_line.match(/--type=([\w-]+)/)?.[1] ?? (/-contentproc/.test(p.command_line) ? "content" : "browser");
		return { left: left.length, pids: left.map((p) => p.pid), kinds: left.map(kind), unseen, kill_failed };
	})();
}
// Starts the browser again on the same profile, once the one before has closed: what the profile keeps, such as
// IndexedDB, stays; the page's init scripts and tabs don't, and the page is about:blank. `main` is the new browser's tab
// once it has started.
async function start_again() {
	closing = null;
	shut = false;
	listeners.length = 0;
	output = "";
	spawn_error = null;
	for (const file of ["DevToolsActivePort", "WebDriverBiDiServer.json"]) fs.rmSync(path.join(profile, file), { force: true });
	driver = null; // a start that fails leaves no browser to ask to close
	driver = firefox ? await launch_firefox() : await launch_chromium();
	main = driver.main;
}
// A start that failed is made once more, on the same profile, once what it left running has been taken down. A value
// of the test's own that can't be read fails at once: a second start would read the same value.
async function start_once_more(error) {
	if (error.asked_wrong) throw error;
	console.log(`[harness] ${BROWSER} didn't start and take the harness's connection (${error.message}): it is started once more`);
	await close_browser();
	await start_again();
}
// Closes the browser and starts it again on the same profile, as a player's restart would. A start that fails is made
// once more, as the first start is. Returns how the close went.
export async function restart_browser() {
	const closed = await close_browser();
	await start_again().catch(start_once_more);
	return closed;
}

// A run that ends without finish(), as an uncaught error ends it, still takes its browser down.
process.on("exit", () => { if (!closing) kill_trees(browser_processes()); });
// And it removes its profile and its files, in up to 2.5 s of tries, and says which folder stays. A run that ends while
// its close is still going takes down what is left of the browser first. A run killed from outside gets to neither.
const left_in_place = (dir, error) => `LEFT IN PLACE  ${dir}  (${error.code}: something still holds a file in it)`;
process.on("exit", () => {
	if (removed) return;
	if (closing && !shut) kill_trees(browser_processes());
	for (const dir of [profile, TEST_FILES]) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch (error) { console.log(left_in_place(dir, error)); }
});
process.on("SIGINT", () => process.exit(130));

// Closes the browser, prints the tally, closes the servers, removes the profile and the run's files, and exits with 1 if
// anything failed. With check_close, as the smoke suite asks, the browser's closing counts as a check, looked up in
// Windows. In the other suites a browser that left processes to kill is a line in the output, and the exit code is
// their own checks'. A removal stops at the first file something still holds: after 5 s of tries the browser's
// processes still running, which the close should have left none of, are killed, and after 5 s more the folder stays
// and a line says which.
export async function finish({ check_close = false } = {}) {
	const closed = await close_browser({ look: check_close });
	const slow = closed.unseen ? `Windows couldn't be asked which processes are left: ${closed.unseen}` : closed.left ? `${closed.left} still running 5 s on, ${closed.kill_failed ? `and the kill couldn't run (${closed.kill_failed})` : "killed"}: ${closed.pids.map((pid, i) => `${pid} (${closed.kinds[i]})`).join(", ")}` : "";
	if (check_close) check("the browser closed with every process it started", !slow, slow);
	else if (slow) console.log(`[harness] the browser's close: ${slow}`);
	const failed = results.filter((r) => !r.ok).length;
	console.log(`\n${results.length - failed}/${results.length} passed`);
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
	for (const dir of [profile, TEST_FILES]) {
		let failure = null, killed = false;
		const began = Date.now();
		while (true) {
			try { fs.rmSync(dir, { recursive: true, force: true }); failure = null; break; } catch (error) { failure = error; }
			if (Date.now() - began >= 10000) break;
			if (Date.now() - began >= 5000 && !killed) { kill_trees(browser_processes()); killed = true; }
			await sleep(250);
		}
		if (failure) console.log(left_in_place(dir, failure));
	}
	removed = true;
	process.exit(failed ? 1 : 0);
}

// --- Starting ---
// A start that fails is made once more, on the same profile, once what the first one left running has been taken down.
// A second failure is the run's one check.
let driver = null, main = null;
try {
	driver = await (firefox ? launch_firefox() : launch_chromium()).catch(async (error) => {
		await start_once_more(error);
		return driver;
	});
} catch (error) {
	check(`${BROWSER} starts and takes the harness's connection`, false, error.message);
	await finish();
}
main = driver.main;
// The product and version of the browser running, as it gives them: "Chrome/158.0.8127.36", "Edg/158.0.4370.33" or
// "Firefox/160.0.1".
export const version = () => driver.product;
// DevTools Protocol calls to the page itself, in Chrome, Edge and Brave.
export const page = (method, params) => chromium ? main.call(method, params) : Promise.reject(new Error(`page(${method}): ${BROWSER} doesn't speak the DevTools Protocol`));

// Runs an expression in the page and returns its value. Functions get their arguments as JSON.
export const evaluate = (fn, ...args) => main.evaluate(fn, ...args);
export const mouse = {
	at: { x: 0, y: 0 },
	async move(x, y, steps = 1) {
		const { x: x0, y: y0 } = this.at;
		for (let i = 1; i <= steps; i++) await driver.mouse_move(x0 + (x - x0) * i / steps, y0 + (y - y0) * i / steps);
		this.at = { x, y };
	},
	async down() { await driver.mouse_button("down", this.at); },
	async up() { await driver.mouse_button("up", this.at); },
	async click(x, y) { await this.move(x, y); await this.down(); await this.up(); },
};
// Keys with Shift, Control and Alt: m, w, y, z, Escape, = and -.
export const keyboard = {
	async down(key, modifiers = []) { await driver.key("down", key, modifiers); },
	async up(key, modifiers = []) { await driver.key("up", key, modifiers); },
	async press(key, modifiers = []) { await this.down(key, modifiers); await this.up(key, modifiers); await sleep(100); },
};

// Scripts that run in the page before its own, from its next load on, until removed.
export const add_init_script = (source) => main.add_init_script(source);
export const remove_init_script = (id) => main.remove_init_script(id);
// Persistent storage for an origin, so navigator.storage.persist() answers true there: Browser.setPermission in
// Chromium, permissions.setPermission in Firefox. The origin's other permissions stay as they were, where
// Browser.grantPermissions would deny them all.
export const grant_persistent_storage = (origin = ORIGIN) => driver.grant_persistent_storage(origin);
// A quota in bytes for an origin's storage in Chrome, Edge and Brave, small enough for a test to fill:
// Storage.overrideQuotaForOrigin on the page's session. It has to come before the origin's first write: Chrome keeps
// what a bucket had left for about 30 s, and the writes of that time don't see a quota set after them. Without a size
// the override goes. Firefox takes a quota for a whole run instead, from PAIN_T_FIREFOX_PREFS.
export const override_quota = (bytes, origin = ORIGIN) => chromium ? main.call("Storage.overrideQuotaForOrigin", { origin, ...(bytes === undefined ? {} : { quotaSize: bytes }) }) : Promise.reject(new Error(`override_quota(): ${BROWSER} takes its quota from PAIN_T_FIREFOX_PREFS, as dom.quotaManager.temporaryStorage.fixedLimit in KiB`));

// Polls `holds` in a page every 100 ms, for up to `ms`. At the limit it prints one line and the test goes on, for its
// own checks to judge the page as it is.
async function wait_in_page(run, holds, ms, what) {
	for (const until = Date.now() + ms; Date.now() < until;) {
		if (await run(holds).catch(() => false)) return;
		await sleep(100);
	}
	console.log(`[harness] ${what} in ${ms / 1000} s: the test goes on`);
}
// Runs `go`, a navigation or a reload of `tab`, and waits for the document it leaves to go: up to limits.leave, 20 s.
// Then it throws, since a test that went on would read the page it meant to leave.
async function leave(tab, go) {
	await tab.evaluate(() => { window.__harness_leaving = true; }).catch(() => { });
	await go();
	const until = Date.now() + limits.leave;
	while (!(await tab.evaluate(() => !window.__harness_leaving).catch(() => false))) {
		if (Date.now() >= until) throw new Error(`the page didn't leave its document within ${limits.leave / 1000} s of the reload or navigation the harness asked for`);
		await sleep(50);
	}
}
// A tab of its own, in the background unless asked: `open(url)` loads Paint or another page in it, `evaluate` runs there
// as in the page, it takes init scripts of its own, and `close()` closes it. Its page errors aren't collected.
export async function new_tab({ background = true } = {}) {
	const tab = await driver.new_tab(background);
	return { ...tab, open: (url = `${ORIGIN}/`) => leave(tab, () => tab.navigate(url)) };
}
export const close_tab = (tab) => tab.close();

const hide_connection = () => evaluate(() => {
	for (const w of document.querySelectorAll(".window")) if (/Archipelago Connection Options/.test(w.textContent)) w.style.display = "none";
});

// Whether the session's restore has landed or failed (sessions.js). Until then the page holds its saves and leaves no
// copy of the canvas as it goes, so what a test painted before it would be lost at a reload.
const restore_settled = () => window.paint_hard_session?.ready === true;

// Opens Paint and waits until `ready` holds in the page, up to 20 s, and, unless `restored` is false, until the session's
// first restore has landed or failed, up to 10 s. Then it hides the connection window unless a test logs in with it.
// The page starts a new session, under a #local: id of its own, or opens the one `hash` names, such as "local:<id>",
// from a page of another document: about:blank after a restart, or any page but Paint at the same address. `search`
// puts switches for the server in the page's own request, such as "cache=600". Paint takes the query out of its address
// as it sets its #local: id, so a reload asks without them.
export async function open_paint(ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0, { hide_connection_window = true, hash = "", search = "", restored = true } = {}) {
	await leave(main, () => main.navigate(`${ORIGIN}/${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`));
	await wait_in_page(evaluate, ready, 20000, "Paint didn't hold the test's ready condition");
	if (restored) await wait_in_page(evaluate, restore_settled, 10000, "the session's first restore hadn't landed or failed");
	await sleep(500);
	await overclock_id(evaluate);
	if (hide_connection_window) await hide_connection();
	// point_on() aims between whole pixels in Chromium, which has to hand the page the point as it's given, and at whole
	// pixels in Firefox, which delivers no other.
	const [x, y] = chromium ? [3.25, 4.75] : [3, 5];
	await mouse.move(2, 2);
	await evaluate(() => { addEventListener("pointermove", (event) => { window.__harness_move = [event.clientX, event.clientY]; }, { capture: true, once: true }); });
	await mouse.move(x, y);
	const delivered = await evaluate(() => window.__harness_move ?? null);
	if (delivered?.[0] !== x || delivered?.[1] !== y) throw new Error(`${BROWSER} delivered the point (${x}, ${y}) as ${JSON.stringify(delivered)}`);
	console.log(`browser: ${version()}  canvas ${await evaluate(() => main_canvas.width + "x" + main_canvas.height)}`);
}

// Reloads Paint in place, keeping its #local: hash, so the page restores the session it had (task 7.5). It waits until
// the new page holds `ready`, up to 20 s, and, unless `restored` is false, until the restore has landed or failed, up
// to 10 s. A wait that runs out prints a line, and the test's own checks decide.
export async function reload_paint(ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0, { hide_connection_window = true, restored = true } = {}) {
	await leave(main, () => main.reload());
	await wait_in_page(evaluate, ready, 20000, "Paint didn't hold the test's ready condition");
	if (restored) await wait_in_page(evaluate, restore_settled, 10000, "the session's restore hadn't landed or failed");
	await overclock_id(evaluate);
	if (hide_connection_window) await hide_connection();
}

// The client point on pixel (x, y) of the canvas or the goal image, worked out from where the image is now: its center
// in Chromium, and in Firefox the whole-number point nearest the center that Paint maps to the pixel. It throws for a
// pixel off the image, and unless the point maps back to (x, y) through the rect Paint keeps for the image. Paint's hover
// position and Pick Color on the goal map a pointer with that rect; a press on the canvas updates it first, and M reads
// the live one. Paint maps a point with Math.floor((x - left) * pixels / width), which gives every pixel a whole-number
// point while the image shows one client pixel or more to each of its own, as at magnification 1, 2 and 4. Shown
// smaller, some pixels have none, and in Firefox this throws for those, where a check would land on the pixel next door.
// Paint updates its rect on scroll and resize events, which come with the next frame, so this waits for one first.
// Hiding the Tool Box moves the canvas without an update (upstream's own bug), so a test that hides it has to scroll,
// resize or press the canvas before aiming.
export const point_on = (which, x, y) => evaluate(async (which, x, y, whole) => {
	const el = which === "goal" ? goal_canvas : main_canvas;
	if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= el.width || y >= el.height) throw new Error(`point_on(${which}, ${x}, ${y}) is off the ${el.width}x${el.height} image`);
	await new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 100); }); // a hidden page has no frames
	const r = el.getBoundingClientRect();
	const kept = which === "goal" ? window.goal_canvas_bounding_client_rect : window.canvas_bounding_client_rect;
	const pixel_at = (point, start, size, pixels) => Math.floor((point - start) * pixels / size); // as Paint maps a pointer
	const center = { x: r.left + (x + 0.5) * r.width / el.width, y: r.top + (y + 0.5) * r.height / el.height };
	let point = center;
	if (whole) {
		const nearest = (c, i, start, size, pixels) => [Math.round(c), Math.floor(c), Math.ceil(c), Math.round(c) - 1, Math.round(c) + 1].find((p) => pixel_at(p, start, size, pixels) === i) ?? null;
		point = { x: nearest(center.x, x, kept.left, kept.width, el.width), y: nearest(center.y, y, kept.top, kept.height, el.height) };
		if (point.x === null || point.y === null) throw new Error(`point_on(${which}, ${x}, ${y}): no whole-number point maps to that pixel through Paint's rect for the image`);
	}
	const back = { x: pixel_at(point.x, kept.left, kept.width, el.width), y: pixel_at(point.y, kept.top, kept.height, el.height) };
	if (back.x !== x || back.y !== y) throw new Error(`point_on(${which}, ${x}, ${y}) maps back to ${back.x},${back.y} through Paint's rect for the image`);
	return point;
}, which, x, y, firefox);

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
