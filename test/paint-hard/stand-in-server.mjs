// A stand-in for MultiServer, for the suites that log in through Paint's own Connect button: real-client.e2e.mjs,
// sessions.e2e.mjs, history.e2e.mjs and storage.e2e.mjs. Before the page loads, window.WebSocket is replaced by one that
// answers RoomInfo, GetDataPackage (built from the APWorld's items.py), Connect and Get, records LocationChecks, and can
// drop the connection. Adapted from the Phase 3 review's harness. It reads items.py and test/client_contract.json from
// the APWorld checkout beside this one; set PAIN_T_ITEMS_PY and PAIN_T_CONTRACT to read them from elsewhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, sleep } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORLD = path.join(ROOT, "..", "paint-hard-apworld", "worlds", "paint_hard");
export const ITEMS_PY = process.env.PAIN_T_ITEMS_PY || path.join(WORLD, "items.py");
// What the world writes for the client beyond items.py: each tool ladder's copies, the accuracy copies, the margin copies
// at the default miss_margin_step, the slot data at the default options, and what logic's ceiling is checked against
// (its test_client_contract.py keeps the file true).
export const CONTRACT_JSON = process.env.PAIN_T_CONTRACT || path.join(WORLD, "test", "client_contract.json");
export const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_JSON, "utf8"));

// The item table, from items.py itself, so a name that differs between the two repos fails here.
export const ITEMS = {};
for (const m of fs.readFileSync(ITEMS_PY, "utf8").matchAll(/^\s*"([^"]+)":\s*PaintItemData\((\d+),/gm)) ITEMS[m[1]] = Number(m[2]);
export const id_of = (name) => { if (!(name in ITEMS)) throw new Error(`not in items.py: ${name}`); return ITEMS[name]; };

// Locations as a default 800x600 seed has them: 18 early checks, 25 Matched Pixels, a check every 0.01% up to 80%.
export const LOCATIONS = [];
for (let k = 1; k <= 18; k++) LOCATIONS.push(2198900 + k);
for (let n = 1; n <= 25; n++) LOCATIONS.push(2198950 + n);
for (let i = 1; i <= 8000; i++) LOCATIONS.push(2199000 + i);

// The stand-in server, as a script for the page to run before it loads. config holds the seed's name, the items it
// sends at Connect, the item push() sends, its locations, its slot data and its data package. It may name its team and
// its slot, 0 and 1 when it names none, and in `refuse` the errors every Connect is refused with, such as
// ["InvalidPassword"]. For each game, a seed with a team and a slot, it keeps what was checked and the items sent since
// Connect in sessionStorage, so a reload sees them, and a later Connect gets every item again, as MultiServer sends them.
export const fake_server = (config) => `(() => {
	let CONFIG = ${JSON.stringify(config)};
	const team = () => CONFIG.team ?? 0, slot = () => CONFIG.slot ?? 1;
	const game = () => CONFIG.seed + "-" + team() + "-" + slot();
	// The seconds the game's Overclock fillers have given, added up over every page's totals (auto-copy.js).
	window.spent_stored = () => Object.keys(localStorage).filter((key) => key.startsWith("pain-t-overclock-page:" + game() + ":")).reduce((sum, key) => sum + JSON.parse(localStorage.getItem(key)).spent, 0);
	const stored = () => ({ checked: [], sent: [], ...(() => { try { return JSON.parse(sessionStorage.getItem("fake-ap:" + game()) || "null"); } catch { return null; } })() });
	let store = stored();
	const save = () => { try { sessionStorage.setItem("fake-ap:" + game(), JSON.stringify(store)); } catch { } };
	// The room's players as MultiServer lists them: every slot up to the config's, in every team up to the config's. The
	// client library builds its teams from this list, and needs each one from team 0 up.
	const name_of = (s, name) => s === slot() ? name : "Player" + s;
	const players = (name) => Array.from({ length: (team() + 1) * slot() }, (_, i) => ({ team: Math.floor(i / slot()), slot: i % slot() + 1, alias: name_of(i % slot() + 1, name), name: name_of(i % slot() + 1, name), class: "NetworkPlayer" }));
	const slot_info = (name) => Object.fromEntries(Array.from({ length: slot() }, (_, i) => [i + 1, { name: name_of(i + 1, name), game: "Pain-T", type: 1, group_members: [], class: "NetworkSlot" }]));
	const ap = window.__ap = {
		log: [], sockets: [], received: 0,
		drop() { const s = ap.sockets.at(-1); if (s) s._drop(); },
		// Another seed for the connections made from now on, as the player's next game would be.
		use(config) { CONFIG = config; store = stored(); },
		// One more item for this slot, as another player's check would send it.
		push(item = CONFIG.late_item.item) { ap.give([{ ...CONFIG.late_item, item }]); },
		// Items as the server sends them, in one packet.
		give(items) { const s = ap.sockets.at(-1); if (!s) return; s._reply([{ cmd: "ReceivedItems", index: ap.received, items }]); ap.received += items.length; store.sent.push(...items); save(); },
	};
	class FakeWebSocket {
		constructor(url) {
			this.url = String(url); this.readyState = 0; ap.sockets.push(this);
			setTimeout(() => { this.readyState = 1; this.onopen?.({}); this._reply([{ cmd: "RoomInfo", version: { major: 0, minor: 6, build: 6, class: "Version" }, generator_version: { major: 0, minor: 6, build: 6, class: "Version" }, tags: ["AP"], password: (CONFIG.refuse ?? []).includes("InvalidPassword"), permissions: { release: 2, collect: 2, remaining: 2 }, hint_cost: 10, location_check_points: 1, games: ["Archipelago", "Pain-T"], datapackage_checksums: { "Pain-T": CONFIG.package.checksum }, seed_name: CONFIG.seed, time: Date.now() / 1000 }]); }, 10);
		}
		send(text) {
			for (const p of JSON.parse(text)) {
				ap.log.push({ t: performance.now(), cmd: p.cmd, locations: p.locations, status: p.status });
				if (p.cmd === "GetDataPackage") this._reply([{ cmd: "DataPackage", data: { games: { "Pain-T": CONFIG.package } } }]);
				else if (p.cmd === "Connect" && CONFIG.refuse) this._reply([{ cmd: "ConnectionRefused", errors: CONFIG.refuse }]);
				else if (p.cmd === "Connect") {
					const missing = CONFIG.locations.filter((id) => !store.checked.includes(id));
					// Connected, with the start inventory and every item sent since. Then, as a message of its own, the line the
					// server prints as a client joins: Paint has its message handler on by then.
					this._reply([{ cmd: "Connected", team: team(), slot: slot(), players: players(p.name), missing_locations: missing, checked_locations: [...store.checked], slot_data: CONFIG.slot_data, slot_info: slot_info(p.name), hint_points: store.checked.length }, { cmd: "ReceivedItems", index: 0, items: [...CONFIG.items, ...store.sent] }]);
					this._reply([{ cmd: "PrintJSON", data: [{ text: p.name + " (Team #" + (team() + 1) + ") playing Pain-T has joined. Client(0.6.6), []." }], type: "Join", team: team(), slot: slot(), tags: p.tags ?? [] }]);
					ap.received = CONFIG.items.length + store.sent.length;
				} else if (p.cmd === "LocationChecks") {
					const fresh = p.locations.filter((id) => CONFIG.locations.includes(id) && !store.checked.includes(id));
					store.checked.push(...fresh); save();
					if (fresh.length) this._reply([{ cmd: "RoomUpdate", hint_points: store.checked.length, checked_locations: fresh }]);
				// Retrieved carries the request's other fields back, as MultiServer's does: the client library matches an answer
				// to its request by one of them.
				} else if (p.cmd === "Get") this._reply([{ ...p, cmd: "Retrieved", keys: Object.fromEntries(p.keys.map((k) => [k, k.startsWith("_read_hints") ? [] : null])) }]);
			}
		}
		close() { this.readyState = 3; }
		_reply(packets) { setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(packets) }); }, 2); }
		_drop() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1006 }); }
	}
	Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	window.WebSocket = FakeWebSocket;
})();`;

// Whether the connection window shows, and a login through it, as a player makes one: the fields filled and Connect
// clicked. connect() waits up to 10 s for the window to go, and prints a line when it is still up then: the test goes on.
export const window_shown = () => evaluate(() => [...document.querySelectorAll(".window")].some((w) => /Archipelago Connection Options/.test(w.textContent) && w.offsetParent !== null));
export const click_connect = () => evaluate(() => { $("[name=aphost]").val("fake.test"); $("[name=apport]").val("38281"); $("[name=apslot]").val("Painter"); $("button").filter((i, b) => b.textContent === "Connect!").trigger("click"); });
export const connect = async () => {
	await click_connect();
	let shown = true;
	for (let i = 0; i < 100 && (shown = await window_shown()); i++) await sleep(100);
	if (shown) console.log("[harness] the connection window was still up 10 s after Connect was clicked: the test goes on");
	await sleep(500);
};
