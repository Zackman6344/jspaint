import { Client } from "../lib/archipelago.min.js";
import { calculate_similarity, clear, image_invert_colors, reset_canvas_and_history, resize_canvas_without_saving_dimensions, select_tool, set_magnification, undo } from "./functions.js";
import { show_help } from "./help.js";
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

client.package.importPackage(JSON.parse(localStorage.getItem("datapackage_cache") ?? "{}"));

// Set up an event listener for whenever a message arrives and print the plain-text content to the console.
client.messages.on("message", (content) => {
	console.log(content);
});

var $ap_options_window = $Window({ title: "Archipelago Connection Options", minimizeButton: false, maximizeButton: false, closeButton: false })
	.addClass("maximized").addClass("focused").css({ left: 0, top: 0, width: "100vw", height: "100vh" });
// os-gui closes any window on Escape. This one covers the page until a game connects, and comes back if it drops.
$ap_options_window.on("close", (e) => e.preventDefault());
// Until then the page counts as a ladder seed with no copies (D24). The sizes are page globals that app-state.js sets
// after this module runs, so this waits for the page.
$(() => set_tool_ladders(() => 0, tools));
$ap_options_window.$content.append('<p><label>Host: <input name="aphost" value="archipelago.gg"></label></p><p><label>Port: <input name="apport" placeholder="38281"></label></p><p><label>Slot name: <input name="apslot"></label></p><p><label>Password: <input name="appass"></label></p>');
$("<button>Connect!</button>").on("click", function () {
	client.login($("[name=aphost]").val() + ":" + $("[name=apport]").val(), $("[name=apslot]").val(), "Pain-T", { "password": $("[name=appass]").val() })
		.then(function (e) {
			console.log("Connected to the Archipelago server!", e);
			try {
				localStorage.setItem("datapackage_cache", JSON.stringify(client.package.exportPackage()));
			}
			catch (ex) {
				console.log("Unable to cache datapackage.");
				console.log(ex);
			}
			slotData = e;
			received_cache = null;
			sent_units = 0;
			matched_sent = 0;
			if (slotData.version) $("#appaint-version").text("APWorld Version " + slotData.version);
			if (slotData.final_width) final_width = slotData.final_width;
			if (slotData.final_height) final_height = slotData.final_height;
			goal_canvas.width = final_width;
			goal_canvas.height = final_height;
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
			$goal_image.attr("src", $goal_image.attr("src") ?? ("images/archipelago/" + final_width + "x" + final_height + ".png"));
			$G.triggerHandler("save-connection-info");
			$G.triggerHandler("restore-colors");
			update();
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
			alert(e);
		});
}).appendTo($ap_options_window.$content);

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

function count_matched(limit) {
	var w = Math.min(main_canvas.width, goal_canvas.width), h = Math.min(main_canvas.height, goal_canvas.height);
	var canvas = main_canvas.ctx.getImageData(0, 0, w, h).data;
	var goal = goal_canvas.ctx.getImageData(0, 0, w, h).data;
	var count = 0;
	for (var i = 0; i < canvas.length && count < limit; i += 4) {
		var matched = canvas[i + 3] === 255;
		for (var c = 0; c < 3 && matched; c++) {
			var target = goal[i + c];
			matched = Math.abs(canvas[i + c] - target) <= Math.abs(quantize(target, 2) - target) + 1;
		}
		if (matched) count++;
	}
	return count;
}

function send(similarity) {
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
// and the items to count as received, since a test can't join a real game. A test that plays two games names them.
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
	update();
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

// Every received item's name, and how many of each, kept until items arrive or the session changes. The palette rounds
// colors and M copies pixels through these, and reading 8,000 items out of the client each time stalls the page.
var received_cache = null;
function received_items() {
	if (!received_cache || received_cache.count !== client.items.count) {
		var names = [];
		for (var item of client.items.received) names.push(item.name);
		names.push(...fake_items);
		if (version_below("0.2.0")) {
			names.push("Magnifier");
			names.push("Brush");
		}
		var counts = new Map();
		for (var name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
		received_cache = { names, counts, count: client.items.count };
	}
	return received_cache;
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
	update();
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

function onReceive(items) {
	received_cache = null;
	for (var item of items) {
		if (item.name.endsWith("Trap")) {
			handleTrap(item.name, false, null);
		}
	}
	update();
}

function onMessage(message) {
	$("#text-log").append("<br>" + $("<p>").text(message).html());
}

function update() {
	var c = 2;
	var w = slotData.start_width ?? final_width / 2;
	var h = slotData.start_height ?? final_height / 2;
	for (var item of received()) {
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
			case "Progressive Canvas Width":
				w = Math.min(w + (slotData.canvas_width_increment ?? slotData.canvas_size_increment ?? 100), final_width);
				break;
			case "Progressive Canvas Height":
				h = Math.min(h + (slotData.canvas_height_increment ?? slotData.canvas_size_increment ?? 100), final_height);
				break;
		}
	}
	default_tool = get_tool_by_id("TOOL_" +
		["Brush", "Pencil", "Eraser/Color Eraser", "Airbrush", "Line", "Rectangle", "Ellipse", "Rounded Rectangle"]
			.filter((a) => received().includes(a))[0].split("/")[0].replace(" ", "_").toUpperCase());
	resize_canvas_without_saving_dimensions(w, h);
	$colorbox.rebuild_palette(palette);
	if (!mode_unlocked("Difference")) $diff.hide();
	if (!mode_unlocked("Similarity")) $sim.hide();
	set_tool_ladders(slotData.tool_ladders ? rungs : null, tools); // D24: each painting tool starts one pixel wide
	calculate_similarity();
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

export { death_received, deathlink, fake_session, final_height, final_width, game_changed, handleTrap, mode_unlocked, received, rungs, send, session_name, show_text_client, slotData, version_below };

