import { Client } from "../lib/archipelago.min.js";
import { calculate_similarity, clear, drop_goal_pixels, goal_pixels, image_invert_colors, reset_canvas_and_history, resize_canvas_without_saving_dimensions, scored_at_size, select_tool, set_magnification, show_similarity, show_view, shown_view, undo } from "./functions.js";
import { goal_ready, release_seed_goal, seed_goal_of, take_seed_goal } from "./goal.js";
import { show_help } from "./help.js";
import { $G } from "./helpers.js";
import { request_of, transact } from "./idb.js";
import { flip_horizontal, flip_vertical } from "./image-manipulation.js";
import { tools } from "./tools.js";
import { quantize } from "./shades.js";
import { set_tool_ladders } from "./tool-sizes.js";

// Create a new instance of the Client class.
const client = new Client();
var slotData = {};
var final_width = 800;
var final_height = 600;
var recent_traps = {};
// The game this page has loaded, { seed, team, slot }, as its last login that went through named it, or null before
// one. A dropped connection keeps it, as the page keeps that game's slot data and items. A login the server refused
// leaves it too, where the client by then holds the other room's seed. A test's fake_session() loads none.
var loaded = null;
function loaded_game() {
	return loaded && { ...loaded };
}
// The game the goal canvas was last cleared for, as "seed-team-slot".
var goal_game = null;

// Data packages are cached in Paint's IndexedDB (idb.js, decision 6), one record a game and checksum, where they take
// none of localStorage's room. The bundled library (lib/archipelago.min.js) asks this cache for each of a room's games
// before it asks the server, and the login waits for the answer, so a read that hasn't answered in 2 s counts as a miss.
// The library asks for a room's games one after another, so once a read has had no answer in 2 s, the reads after it
// don't wait, until one answers: a login loses 2 s to a database that doesn't answer, whatever the room's size.
// A package cached in localStorage before task 7.4 is read from there until a login moves it over. Where IndexedDB
// isn't available, localStorage stays the cache. It is read only once asked: with site data blocked, naming
// localStorage throws, and as this module loaded that stopped every module that imports it.
const PACKAGE_KEY = "datapackage_cache";
const PACKAGE_WAIT_MS = 2000;
let package_reads_stuck = false;
let local_packages = null;
function local_package(game, checksum) {
	if (!local_packages) {
		try {
			local_packages = JSON.parse(localStorage.getItem(PACKAGE_KEY) ?? "{}").games ?? {};
		} catch (_error) {
			local_packages = {};
		}
	}
	const data = local_packages[game];
	return data?.checksum === checksum ? data : null;
}
client.package.setCache({
	async getPackage(game, checksum) {
		let answered = false;
		const stored = transact(["packages"], "readonly", ({ packages }) => request_of(packages.get([game, checksum]))).catch(() => null).then((record) => {
			answered = true;
			package_reads_stuck = false;
			return record;
		});
		if (package_reads_stuck) return local_package(game, checksum);
		const record = await Promise.race([stored, new Promise((resolve) => setTimeout(() => {
			// The limit marks the reads as stuck only when its own read is still waiting.
			if (!answered) package_reads_stuck = true;
			resolve(null);
		}, PACKAGE_WAIT_MS))]);
		return record?.package ?? local_package(game, checksum);
	},
});
// Caches the packages this page holds after a login: each game's under its checksum, in place of that game's older
// ones. What localStorage's cache holds for games this room doesn't have moves over with them, each only where the store
// holds no package for its game, so a newer one isn't replaced. localStorage's copy goes once they're all in.
function cache_packages() {
	const games = client.package.exportPackage().games;
	local_package("", ""); // reads localStorage's cache, if this page hasn't yet
	const others = Object.entries(local_packages ?? {}).filter(([game, data]) => !(game in games) && typeof data?.checksum === "string");
	transact(["packages"], "readwrite", async ({ packages }) => {
		for (const [game, data] of Object.entries(games)) {
			if (typeof data.checksum !== "string" || await request_of(packages.count([game, data.checksum]))) continue;
			for (const key of await request_of(packages.index("game").getAllKeys(game))) packages.delete(key);
			packages.put({ game, checksum: data.checksum, package: data, cached_at: Date.now() });
		}
		for (const [game, data] of others) {
			if (await request_of(packages.index("game").count(game))) continue;
			packages.put({ game, checksum: data.checksum, package: data, cached_at: Date.now() });
		}
	}).then(() => {
		local_packages = {};
		try { localStorage.removeItem(PACKAGE_KEY); } catch (_error) { /* site data blocked */ }
	}, () => {
		try {
			localStorage.setItem(PACKAGE_KEY, JSON.stringify({ games: { ...local_packages, ...games } }));
		} catch (ex) {
			console.log("Unable to cache datapackage.");
			console.log(ex);
		}
	});
}

// Set up an event listener for whenever a message arrives and print the plain-text content to the console.
client.messages.on("message", (content) => {
	console.log(content);
});

var $ap_options_window = $Window({ title: "Archipelago Connection Options", minimizeButton: false, maximizeButton: false, closeButton: false })
	.addClass("maximized").addClass("focused").addClass("ap-options-window").css({ left: 0, top: 0, width: "100vw", height: "100vh" });
// os-gui closes any window on Escape. This one covers the page until a game connects, and comes back if it drops.
$ap_options_window.on("close", (e) => e.preventDefault());
// os-gui brings a window to the front at any press in it, and this one covers the page: a click in its form would put it
// over a message that had opened above it, with no way to bring the message back. So it stays behind every window that
// opens after it. A message that opens while the player types in its form leaves the focus there (msgbox.js).
$ap_options_window.bringToFront = () => { };
// Until then the page counts as a ladder seed with no copies (D24). The sizes are page globals that app-state.js sets
// after this module runs, so this waits for the page.
$(() => set_tool_ladders(() => 0, tools));
$ap_options_window.$content.append('<p><label>Host: <input name="aphost" value="archipelago.gg"></label></p><p><label>Port: <input name="apport" placeholder="38281"></label></p><p><label>Slot name: <input name="apslot"></label></p><p><label>Password: <input name="appass"></label></p>');
// One login at a time: a click while a login is under way, or while one waits for the session restore, does nothing.
// Each login that went through opened a socket of its own and bound the item, message and disconnect handlers again, so
// three clicks during one wait made a trap undo three steps. The test is a flag, since a click that script triggers
// runs the handler on a disabled button too. The line under the button says what the login waits for.
var logging_in = false, login_turn = 0, login_sent = false;
var $ap_status = $('<p class="ap-status" aria-live="polite"></p>');
// Gives Connect back once the login of that turn has gone through or failed.
function login_ended(turn) {
	if (turn !== login_turn) return;
	logging_in = false;
	login_sent = false;
	clearTimeout(quiet_timer);
	$ap_connect.prop("disabled", false);
	$ap_status.text("");
}
// A connection that drops while its login waits for the server, as while a room's data packages come, leaves that login
// waiting for good: the library has no time limit there. Connect comes back at the drop, and the line says so. Only a
// drop after the library took the login counts. As it takes one, the library closes a socket an earlier login left
// open, as a login the server refused leaves one, and that close fires the same event.
client.socket.on("disconnected", function () {
	if (!login_sent) return;
	login_ended(login_turn);
	$ap_status.text("The connection dropped before the login went through. Connect to try again.");
});
// A server that opens the socket and then sends nothing leaves the login waiting for good too, with the connection up.
// After 20 s with no packet from the server the line says so. Connect stays disabled: a second login while the library
// holds this one sends two Connect commands.
const LOGIN_QUIET_MS = 20000;
var quiet_timer = 0;
function watch_quiet(turn) {
	clearTimeout(quiet_timer);
	quiet_timer = setTimeout(() => {
		if (turn === login_turn && logging_in) $ap_status.text("The server hasn't answered in 20 s. Reload this tab to try again.");
	}, LOGIN_QUIET_MS);
}
client.socket.on("receivedPacket", function () {
	if (!login_sent) return;
	$ap_status.text("Connecting...");
	watch_quiet(login_turn);
});
var $ap_connect = $("<button>Connect!</button>").on("click", function () {
	if (logging_in) return;
	logging_in = true;
	const turn = ++login_turn;
	$ap_connect.prop("disabled", true);
	$ap_status.text(window.paint_hard_session?.ready === false ? "Restoring this tab's canvas from storage..." : "Connecting...");
	// The click asks the browser to keep Paint's storage (sessions.js, task 7.4), and nothing waits on its answer.
	$G.triggerHandler("connect-click");
	// While a session restore draws the stored canvas, the login waits until it lands or fails (task 7.5): the canvas
	// takes its stored size first, and the login's items grow it from there. The address the login goes to is kept.
	let sent = null;
	(window.paint_hard_session?.restored ?? Promise.resolve())
		.then(() => {
			$ap_status.text("Connecting...");
			sent = { aphost: $("[name=aphost]").val(), apport: $("[name=apport]").val(), apslot: $("[name=apslot]").val() };
			const login = client.login(sent.aphost + ":" + sent.apport, sent.apslot, "Pain-T", { "password": $("[name=appass]").val() });
			login_sent = true;
			watch_quiet(turn);
			return login;
		})
		.then(function (e) {
			// A login the player clicked past after its connection dropped still waits in the library, and the server's
			// answer to the next login answers it too. The page takes the answer to the latest click alone, so the item,
			// message and disconnect handlers are bound once.
			if (turn !== login_turn) return;
			// The form holds the address this login went to: a session restored since the click fills it from its record.
			for (const name in sent) $(`[name=${name}]`).val(sent[name]);
			console.log("Connected to the Archipelago server!", e);
			cache_packages();
			slotData = e;
			received_cache = null;
			sent_units = 0;
			matched_sent = 0;
			if (slotData.version) $("#appaint-version").text("APWorld Version " + slotData.version);
			if (slotData.final_width) final_width = slotData.final_width;
			if (slotData.final_height) final_height = slotData.final_height;
			// The tab's session belongs to the game it first logs into, and a login into another game goes on in a new
			// session (sessions.js, decision 7), before the goal and the canvas take this game's sizes.
			loaded = { seed: client.room.seedName, team: client.players.self.team, slot: client.players.self.slot };
			$G.triggerHandler("game-login", [{ ...loaded }]);
			// A login into the game the goal canvas was last cleared for, at the same goal size, as a reconnect is, leaves
			// the goal and the read of it alone: the goal image draws over it again at its load. Cleared here, the goal was
			// blank until then, and a tick of auto copy in between copied from the blank read and could send every check.
			const game = `${loaded.seed}-${loaded.team}-${loaded.slot}`;
			const cleared = game !== goal_game || goal_canvas.width !== final_width || goal_canvas.height !== final_height;
			if (cleared) {
				goal_canvas.width = final_width;
				goal_canvas.height = final_height;
				// Blank until the goal image draws, at any size: a read of the last game's goal would score this game's
				// canvas against it and send checks it hasn't earned.
				drop_goal_pixels();
			}
			goal_game = game;
			$goal.width(final_width)
			$goal.height(final_height)
			diff_canvas.width = final_width;
			diff_canvas.height = final_height;
			$diff.width(final_width)
			$diff.height(final_height)
			sim_canvas.width = final_width;
			sim_canvas.height = final_height;
			$sim.width(final_width)
			$sim.height(final_height)
			// Task 7.8: from version 1.2.0 a seed names its goal, the bundled image or the player's own, and goal.js loads it
			// once for each seed, team, slot, reference, hash and size, and holds the checks until it is drawn. Older seeds
			// draw the bundled image of their size, or the goal a restored session brought.
			const seed_goal = seed_goal_of(slotData.goal_image, slotData.goal_image_sha256, loaded, final_width, final_height, version_below("1.2.0"));
			if (seed_goal) {
				take_seed_goal(seed_goal, cleared);
			} else {
				release_seed_goal();
				$goal_image.attr("src", $goal_image.attr("src") ?? ("images/archipelago/" + final_width + "x" + final_height + ".png"));
			}
			$G.triggerHandler("save-connection-info");
			$G.triggerHandler("restore-colors");
			// Every tool starts locked, as on a fresh page, so a tool the last game unlocked shows only if this one has it.
			for (const tool of tools) tool.$button?.addClass("disabled");
			update(true);
			select_tool(default_tool);
			if (slotData.death_link) {
				client.deathLink.enableDeathLink();
				client.deathLink.on("deathReceived", death_received);
			}
			if (slotData.trap_link) {
				client.updateTags(client.arguments.tags.concat(["TrapLink"]));
				client.socket.on("bounced", function (packet, data) {
					if (packet.tags.includes("TrapLink") && data.source != client.name) {
						handleTrap(data.trap_name, true, data);
					}
				});
			}
			client.messages.on("message", onMessage);
			items_taken = client.items.received.length;
			client.items.on("itemsReceived", onReceive);
			client.socket.on("disconnected", function () {
				client.messages.off("message", onMessage);
				client.items.off("itemsReceived", onReceive);
				$ap_options_window.show();
			});
			$ap_options_window.hide();
		})
		.catch(function (e) {
			console.error(e);
			// A login the player clicked past fails without an alert of its own: the latest click's login says it.
			if (turn === login_turn) alert(e);
		})
		.finally(function () {
			login_ended(turn);
		});
}).appendTo($ap_options_window.$content);
$ap_status.appendTo($ap_options_window.$content);

// Pain-T check IDs: the 18 checks below 0.01% are 2198900 + k, then 2199000 + i is the check at i * 0.01%.
// The server drops IDs the options didn't create, so every step up to the similarity goes out once.
const EARLY_UNITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90]; // in 0.0001% steps
var sent_units = 0; // similarity already sent, in 0.0001% steps

// "Matched Pixels: n" is 2198950 + n, for the 5x5 start only. A pixel is matched when each channel is at least as
// close to the goal as black or white would be, with one step of leeway for browsers that blur canvas reads. Every
// shade table has black and white, so the bar never rises as color items arrive, which keeps these checks as
// reachable as logic says they are.
const MATCHED_BASE = 2198950;
var matched_sent = 0;

// The goal comes from the read every score shares (task 7.3), as wide as the goal canvas.
function count_matched(limit) {
	var goal = goal_pixels();
	var w = Math.min(main_canvas.width, goal.width), h = Math.min(main_canvas.height, goal.height);
	var canvas = main_canvas.ctx.getImageData(0, 0, w, h).data;
	var count = 0;
	for (var y = 0; y < h && count < limit; y++) {
		for (var x = 0, i = y * w * 4, j = y * goal.width * 4; x < w && count < limit; x++, i += 4, j += 4) {
			var matched = canvas[i + 3] === 255;
			for (var c = 0; c < 3 && matched; c++) {
				var target = goal.data[j + c];
				matched = Math.abs(canvas[i + c] - target) <= Math.abs(quantize(target, 2) - target) + 1;
			}
			if (matched) count++;
		}
	}
	return count;
}

// Task 7.8 (D18): while the seed's goal isn't drawn, send() sends nothing, and returns without throwing, since undoable()
// calls it with no guard. The goal's draw scores the canvas, and that score goes out then, once, if a send was held.
var send_held = false;
// So it does once the browser has blocked canvas reads, at the load or with the page open, for the rest of the page: a
// blocked read gives the browser's own answer, random bytes under Firefox's resistFingerprinting, which an undo or an
// Undo Trap draws onto the canvas, where it stays once reads are allowed, and a score of that sends checks the canvas
// hasn't earned. A reload restores the session's last save, and checks go out from there. auto-copy.js, which probes
// the reads at each send, hands its test to this module as it loads (watch_reads(), canvas_tainted()): it imports this
// module, which can't import it.
var canvas_tainted;
function watch_reads(test) {
	canvas_tainted = test;
}
function send(similarity) {
	if (!goal_ready()) {
		send_held = true;
		return;
	}
	if (canvas_tainted?.()) {
		send_held = true;
		return;
	}
	send_held = false;
	var units = Math.floor(similarity * 10000 + 1e-7);
	if (units > sent_units) {
		var locations = [];
		EARLY_UNITS.forEach(function (u, k) {
			if (u > sent_units && u <= units) locations.push(2198900 + k + 1);
		});
		for (var i = Math.floor(sent_units / 100) + 1; i <= Math.floor(units / 100); i++) {
			locations.push(2199000 + i);
		}
		client.check(...locations); // throws while disconnected, so sent_units only moves once they're out
		sent_units = units;
	}
	if (matched_sent < (slotData.matched_pixels ?? 0)) {
		var matched = count_matched(slotData.matched_pixels);
		if (matched > matched_sent) {
			var ids = [];
			for (var n = matched_sent + 1; n <= matched; n++) ids.push(MATCHED_BASE + n);
			client.check(...ids);
			matched_sent = matched;
		}
	}
	if (similarity >= slotData.goal_percent) client.goal();
}

// A stand-in for a server, for tests: test/paint-hard/auto-copy.e2e.mjs calls fake_session() from the page with slot data
// and the items to count as received, since a test can't join a real game. A test that plays two games names them. An
// item is its name, which arrives as progression, or { name, progression: false } for one that arrives as useful.
var fake_items = [], fake_name = "test";
function fake_session(slot_data, items, name = "test") {
	slotData = slot_data;
	fake_items = items;
	fake_name = name;
	received_cache = null;
	// Every tool starts locked, as on a fresh page, so a tool shows only this session's items.
	for (const tool of tools) tool.$button?.addClass("disabled");
	if (slotData.final_width) final_width = slotData.final_width;
	if (slotData.final_height) final_height = slotData.final_height;
	update(true);
}

// Item packets for tests, beside fake_session(): the items arrive as a server's ReceivedItems would bring them, and the
// page runs what it runs for a packet. fake_session() rescores as a login does; a packet rescores only for a new canvas
// size (task 7.2).
function fake_packet(items) {
	fake_items = fake_items.concat(items);
	onReceive(items.map((item) => ({ name: item.name ?? item })));
}

// Names this game for what the browser keeps per game, such as spent Overclock: seed, team and slot. The client keeps the
// room's seed and your slot through a dropped connection, and so does this name, so the received items it still holds
// aren't counted against a fresh key.
function session_name() {
	try {
		const seed = client.room.seedName, self = client.players.self;
		if (seed && self?.slot) return `${seed}-${self.team}-${self.slot}`;
	} catch (e) { }
	return fake_items.length ? fake_name : "offline";
}

// Every received item's name, how many of each, and how many of each logic counts, kept until items arrive or the
// session changes. The palette rounds colors and M copies pixels through these, and reading 8,000 items out of the
// client each time stalls the page.
var received_cache = null;
function received_items() {
	if (!received_cache || received_cache.count !== client.items.count) {
		var names = [], progression = new Map();
		var add = (name, is_progression) => {
			names.push(name);
			if (is_progression) progression.set(name, (progression.get(name) ?? 0) + 1);
		};
		// A server sends start inventory at location -2 and cheat items (!getitem, /send) at -1, all with flags 0.
		for (var item of client.items.received) add(item.name, item.progression || item.locationId < 0);
		for (var fake of fake_items) add(fake.name ?? fake, fake.progression ?? true);
		if (version_below("0.2.0")) {
			names.push("Magnifier");
			names.push("Brush");
		}
		var counts = new Map();
		for (var name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
		received_cache = { names, counts, progression, count: client.items.count };
	}
	return received_cache;
}

// How many copies of an item logic counts (D8): each copy the server marks progression, and each at a location below 0.
// The world makes the speed and accuracy copies that can't raise its cap useful, and the second Progressive Pick Color.
// Its state holds every start copy, and its create_item makes each one the ceiling reads progression. A cheat item
// counts as the copy it stands in for.
function progression_rungs(name) {
	return received_items().progression.get(name) ?? 0;
}

function received() {
	return received_items().names.slice();
}

// Changes the game makes to the canvas, not the player: traps that change it, and DeathLink resets. With Auto Copy Loop on,
// auto copy starts a finished run again when one of these, a color item or a canvas item reopens pixels (D7). Each is
// counted before it runs, since the change can throw as it sends checks while disconnected.
var game_changes = 0;
function game_changed() {
	return game_changes;
}

function death_received() {
	game_changes++;
	reset_canvas_and_history();
	// The reset is a change to save, as a stroke is. It is asked for before update(), which can throw as it sends.
	$G.triggerHandler("session-update");
	update(true);
}

function handleTrap(name, isLinked, packet) {
	if (isLinked) {
		if (recent_traps[packet.source] && recent_traps[packet.source].trap_name == name && packet.time - recent_traps[packet.source].time < 1000) {
			return;
		}
		recent_traps[packet.source] = packet;
	}
	switch (name) {
		case "Undo Trap":
		case "Damage Trap":
		case "Fear Trap":
		case "Reversal Trap":
		case "Reverse Trap":
		case "Whoops! Trap":
			if (!slotData.death_link && (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Undo Trap"))) {
				game_changes++;
				undo();
			}
			break;
		case "Clear Image Trap":
		case "Blue Balls Curse":
		case "Home Trap":
		case "Instant Death Trap":
		case "One Hit KO":
			if (!slotData.death_link && (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Clear Image Trap"))) {
				game_changes++;
				clear();
			}
			break;
		case "Invert Colors Trap":
		case "Chaos Trap":
		case "Spooky Time":
			if (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Invert Colors Trap")) {
				game_changes++;
				image_invert_colors();
			}
			break;
		case "Flip Horizontal Trap":
		case "Flip Trap":
		case "Mirror Trap":
			if (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Flip Horizontal Trap")) {
				game_changes++;
				flip_horizontal();
			}
			break;
		case "Flip Vertical Trap":
		case "Camera Rotate Trap":
		case "Screen Flip Trap":
			if (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Flip Vertical Trap")) {
				game_changes++;
				flip_vertical();
			}
			break;
		case "Help Trap":
		case "Cutscene Trap":
		case "Exposition Trap":
		case "Hey! Trap":
		case "Literature Trap":
		case "Phone Trap":
		case "Spam Trap":
		case "Text Trap":
		case "Tip Trap":
		case "Tutorial Trap":
			if (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Help Trap")) {
				show_help();
			}
			break;
		case "Zoom In Trap":
		case "Pixelate Trap":
		case "Pixellation Trap":
		case "Spotlight Trap":
		case "Zoom Trap":
			if (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Zoom In Trap")) {
				set_magnification(8);
			}
			break;
		case "Zoom Out Trap":
		case "144p Trap":
		case "Deisometric Trap":
		case "Tiny Trap":
			if (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Zoom Out Trap")) {
				set_magnification(0.25);
			}
			break;
		case "Tool Swap Trap":
		case "Animal Trap":
		case "Eject Ability":
		case "Gadget Shuffle Trap":
		case "Swap Trap":
			if (!slotData.trap_blacklist || !slotData.trap_blacklist.includes("Tool Swap Trap")) {
				var t = tools.filter((a) => a != selected_tool && !a.$button.hasClass("disabled"));
				select_tool(t[Math.floor(Math.random() * t.length)]);
			}
			break;
	}
	if (!isLinked && slotData.trap_link) {
		client.bounce({ tags: ["TrapLink"] }, { time: new Date().getTime(), source: client.name, trap_name: name });
	}
}

// How many of the slot's items the page has taken: the login sets it to the items its answer brought. A server answers
// each Connect with every item from index 0, and a login left waiting in the library sends its Connect on the next
// login's socket, so a packet can bring again items whose traps have run. Only an item at or past this count runs its
// trap. The library passes a packet's index beside its items.
var items_taken = 0;
function onReceive(items, index = items_taken) {
	received_cache = null;
	const taken = Math.max(0, items_taken - index);
	items_taken = Math.max(items_taken, index + items.length);
	for (var item of items.slice(taken)) {
		if (item.name.endsWith("Trap")) {
			handleTrap(item.name, false, null);
		}
	}
	update();
}

function onMessage(message) {
	$("#text-log").append("<br>" + $("<p>").text(message).html());
}

// The palette the Colors box was last built from, its length then, and the three channels' shade counts its buttons
// were last rounded to.
var built_palette = null, built_length = 0, built_shades = "";

// Brings the page up to the items received: tools, palette, canvas size, views, ladders, and the similarity. A login, a
// test's fake_session() and a DeathLink force a rescore. An item packet rescores only when the canvas has a size the last
// rescore didn't score, and otherwise moves only the logic figure (task 7.2).
function update(force = false) {
	var c = 2;
	var items = received();
	var [w, h] = unlocked_size(items);
	for (var item of items) {
		switch (item) {
			case "Additional Palette Color":
				c++;
				if (c > palette.length) palette.push("#FFFFFF");
				break;
			case "Free-Form Select":
			case "Select":
			case "Eraser/Color Eraser":
			case "Fill With Color":
			case "Pick Color":
			case "Magnifier":
			case "Pencil":
			case "Brush":
			case "Airbrush":
			case "Text":
			case "Line":
			case "Curve":
			case "Rectangle":
			case "Polygon":
			case "Ellipse":
			case "Rounded Rectangle":
				$("#TOOL_" + item.split("/")[0].split(" With")[0].replace(" ", "_").replace("-", "_").toUpperCase() + "").removeClass("disabled");
				break;
			case "Progressive Pick Color": // its first copy is the tool, its second an auto copy mode (D23)
				$("#TOOL_PICK_COLOR").removeClass("disabled");
				break;
		}
	}
	default_tool = get_tool_by_id("TOOL_" +
		["Brush", "Pencil", "Eraser/Color Eraser", "Airbrush", "Line", "Rectangle", "Ellipse", "Rounded Rectangle"]
			.filter((a) => items.includes(a))[0].split("/")[0].replace(" ", "_").toUpperCase());
	resize_canvas_without_saving_dimensions(w, h);
	// Building the Colors box lays the page out again, so it waits for a new color or a palette put in from elsewhere. A
	// Progressive Color Depth item changes a channel's shades, and then the box rounds each stored color again and
	// redraws only the buttons whose color moved.
	var table = slotData.shade_counts ?? [2];
	var shades = ["Red", "Green", "Blue"].map((channel) => table[Math.min(rungs(`Progressive Color Depth (${channel})`), table.length - 1)]).join();
	if (palette !== built_palette || palette.length !== built_length) {
		$colorbox.rebuild_palette(palette);
		built_palette = palette;
		built_length = palette.length;
	} else if (shades !== built_shades) {
		$colorbox.round_palette(palette);
	}
	built_shades = shades;
	if (!mode_unlocked("Difference") && shown_view === "difference") show_view(null);
	if (!mode_unlocked("Similarity") && shown_view === "similarity") show_view(null);
	set_tool_ladders(slotData.tool_ladders ? rungs : null, tools); // D24: each painting tool starts one pixel wide
	if (force || !scored_at_size()) calculate_similarity();
	else show_similarity(); // speed, accuracy, color and canvas items move logic's figure
}

// A new goal changes every pixel's score (task 7.2). The seed's loads after the login's rescore, and File > Open Goal
// Image can bring one in any time. Before a game is loaded, the login rescores. This handler is bound before any other
// for save-goal, so the goal as last read is dropped here, before anything judges against it (task 7.3).
$G.on("save-goal", () => {
	drop_goal_pixels();
	if (session_name() === "offline") return;
	const similarity = calculate_similarity();
	// The seed's goal is drawn, and a send held while it loaded goes out now, from this score (task 7.8). One that throws
	// while disconnected leaves its checks for the next send.
	if (send_held && goal_ready()) {
		send_held = false;
		try {
			send(similarity);
		} catch (error) {
			console.warn("The checks held for the goal couldn't go out yet", error);
		}
	}
});

// The browser's canvas reads came clean after it blocked them (auto-copy.js, as its probe finds it): the goal as read
// meanwhile was the browser's answer, and goes, so auto copy, M and the next score read it again. Once the probe that
// found the reads clean has returned, the canvas is scored, and the status bar shows that score. Sends stay held until
// a reload (send()).
$G.on("canvas-reads-allowed", () => {
	drop_goal_pixels();
	setTimeout(() => {
		if (session_name() !== "offline") calculate_similarity();
	}, 0);
});

// The canvas size the items give, [width, height]: the start, and each canvas item's step, up to the goal's size. update()
// gives the canvas this size, and so does Image > Attributes > Default while a game is loaded.
function unlocked_size(items = received()) {
	var w = slotData.start_width ?? final_width / 2;
	var h = slotData.start_height ?? final_height / 2;
	for (var item of items) {
		if (item === "Progressive Canvas Width") w = Math.min(w + (slotData.canvas_width_increment ?? slotData.canvas_size_increment ?? 100), final_width);
		else if (item === "Progressive Canvas Height") h = Math.min(h + (slotData.canvas_height_increment ?? slotData.canvas_size_increment ?? 100), final_height);
	}
	return [w, h];
}

// How many copies of an item have arrived: the rungs of a ladder (D23), the speed tiers, the shades of a channel.
function rungs(name) {
	return received_items().counts.get(name) ?? 0;
}

// Difference and Similarity Mode wait for their first copy in seeds that have the ladders (D23). Older seeds, and the
// page before a game connects, keep both views from the start, as upstream does.
function mode_unlocked(mode) {
	return !slotData.ladders || rungs(`Progressive ${mode} Mode`) >= 1;
}

function deathlink(method) {
	if (slotData.death_link) {
		switch (method) {
			case "undo":
				client.deathLink.sendDeathLink(client.name, client.name + " made a minor mistake.");
				break;
			case "clear":
				client.deathLink.sendDeathLink(client.name, client.name + " decided to start over.");
				break;
			default:
				client.deathLink.sendDeathLink(client.name);
				break;
		}
	}
}

/** @type {OSGUI$Window} */
let $text_client_window;

function show_text_client() {
	if ($text_client_window) {
		$text_client_window.close();
		$("#ap-command").off("keyup");
	}
	$text_client_window = $Window({ title: localize("Archipelago Text Client"), resizable: true, innerHeight: 300, innerWidth: 600 });
	$text_client_window.onClosed(function () { $("body").append($("#text-client").css("display", "none")); });
	$text_client_window.$content.append($("#text-client").css("display", "flex"));
	$text_client_window.center();
	$("#ap-command").on("keyup", function (e) {
		if (e.key == "Enter" && $("#ap-command").val().trim()) {
			client.messages.say($("#ap-command").val());
			$("#ap-command").val("");
		}
	});
}

function version_below(version) {
	if (!slotData.version) return true;
	var t = version.split(".");
	var v = slotData.version.split(".");
	if (parseInt(v[0]) > parseInt(t[0])) return false;
	if (parseInt(v[0]) < parseInt(t[0])) return true;
	if (parseInt(v[1]) > parseInt(t[1])) return false;
	if (parseInt(v[1]) < parseInt(t[1])) return true;
	if (parseInt(v[2]) > parseInt(t[2])) return false;
	if (parseInt(v[2]) < parseInt(t[2])) return true;
	return false;
}

export { death_received, deathlink, fake_packet, fake_session, final_height, final_width, game_changed, handleTrap, loaded_game, mode_unlocked, progression_rungs, received, rungs, send, session_name, show_text_client, slotData, unlocked_size, update, version_below, watch_reads };

