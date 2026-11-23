// End-to-end test of the client's logic ceiling (D8, Phase 5), the figure after the slash in the status bar: the
// world's percent_available(), against hard-fork/plan_math.py's values at the states the world's own test uses
// (test_auto_copy_logic.py), with auto copy at 0 h (out of logic), 1, 2, 6 and 24 h, at the 400x300 start, and past
// auto copy's top tier at 1 h; and against the world's own values at states with each channel's own count, at the
// defaults and on seeds apart from them in the height step, logic_percent and the goal's size. It stands in for a game
// with fake_session(). The states, their ceilings and each seed's slot data come from the APWorld's
// test/client_contract.json, which its test_client_contract.py writes.
// Usage: node test/paint-hard/logic.e2e.mjs [--headful]. It reads the contract from the APWorld checkout beside this one;
// set PAIN_T_CONTRACT to read it from elsewhere. Set BROWSER_PATH if Chrome isn't in its default folder.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, evaluate, finish, open_paint, page_errors, same } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACT_JSON = process.env.PAIN_T_CONTRACT || path.join(ROOT, "..", "paint-hard-apworld", "worlds", "paint_hard", "test", "client_contract.json");
const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_JSON, "utf8")), LOGIC = CONTRACT.logic;
// The world's slot data at the defaults, with the version the world leaves out of the contract, 1.1.0 from Phase 5 on,
// and a seed's, with its changes from them.
const SLOT = { ...CONTRACT.slot_data, version: "1.1.0" };
const seed = (name) => ({ ...SLOT, ...LOGIC.slot_data_changes[name] });
// (color items in each channel, width and height items, speed and accuracy copies, Pick Color)
const STATES = LOGIC.states;
// The hours the contract has ceilings at, at each of its 10 states
const HOURS = ["0", "1", "2", "6", "24"];
// The seeds the contract has ceilings on at its states with unequal channels, (red, green and blue items, width and
// height items, speed and accuracy copies, Pick Color): each with the input it sets apart, and what shows it.
const CHANNEL_SEEDS = {
	6: ["each channel's own count, at the defaults", () => LOGIC.channel_states.every(([r, g, b]) => r !== g && g !== b && r !== b)],
	width_20_height_5: ["the height step, at canvas_width_increment 20 and canvas_height_increment 5", (slot) => slot.canvas_width_increment === 20 && slot.canvas_height_increment === 5],
	logic_90_goal_70: ["logic_percent, at logic_percent 90 and goal_percent 70", (slot) => slot.logic_percent === 90 && slot.goal_percent === 70],
	widescreen_vertical: ["the goal's size, at 450x800", (slot) => slot.final_width === 450 && slot.final_height === 800],
};
// The world's ceiling at a state of test_auto_copy_logic.py at these hours, or at one of the contract's more states of
// the defaults.
const world_ceiling = (state, hours = 6) => {
	const k = STATES.findIndex((s) => JSON.stringify(s) === JSON.stringify(state));
	if (k >= 0) return LOGIC.ceilings[hours][k];
	const more = LOGIC.more_states.findIndex((s) => JSON.stringify(s) === JSON.stringify(state));
	if (more < 0 || Number(hours) !== SLOT.auto_copy_logic_hours) throw new Error(`the contract has no ceiling at ${JSON.stringify(state)} at ${hours} h`);
	return LOGIC.more_ceilings[more];
};
const copies = (name, n) => Array(n).fill(name);
// A state's items, from (color items in each channel, ...) or (red, green and blue items, ...)
const items_for = (state) => {
	const [r, g, b, w, h, speed, accuracy, pick] = state.length === 6 ? [state[0], state[0], ...state] : state;
	return [
		...copies("Progressive Color Depth (Red)", r), ...copies("Progressive Color Depth (Green)", g), ...copies("Progressive Color Depth (Blue)", b),
		...copies("Progressive Canvas Width", w), ...copies("Progressive Canvas Height", h),
		...copies("Progressive Auto Copy Speed", speed), ...copies("Progressive Auto Copy Accuracy", accuracy),
		...(pick ? ["Progressive Pick Color"] : []),
	];
};
// The client's logic ceiling for a slot and items.
const ceiling = (slot, items) => evaluate(async (slot, items) => {
	const { fake_session } = await import("/src/archipelago.js");
	fake_session(slot, ["Magnifier", "Brush", ...items]);
	return (await import("/src/functions.js")).calculate_logic_similarity();
}, slot, items);
const close = (a, b) => Math.abs(a - b) < 5e-7; // the world rounds to 6 decimals
// The client's ceilings for a slot at states, against the world's: the states it reads wrong, and what it read.
const play = async (slot, states, want) => {
	const got = [];
	for (const state of states) got.push(await ceiling(slot, items_for(state)));
	const wrong = got.map((value, k) => [states[k], value, want[k]]).filter(([, value, world]) => !close(value, world));
	return { wrong, detail: wrong.length ? JSON.stringify(wrong.slice(0, 3)) : got.map((value) => value.toFixed(6)).join(", ") };
};

try {
	await open_paint(() => typeof goal_canvas !== "undefined" && main_canvas.width > 0);
	const held = { hours: Object.keys(LOGIC.ceilings), states: STATES.length, at_each_hours: Object.values(LOGIC.ceilings).map((ceilings) => ceilings.length), half_start: LOGIC.half_start_ceilings.length, past_the_top: [LOGIC.past_the_top_states?.length, LOGIC.past_the_top_ceilings?.length], channel_states: LOGIC.channel_states?.length, channel_seeds: Object.keys(LOGIC.channel_ceilings ?? {}) };
	check(`the contract has the world's ceilings at ${HOURS.slice(0, -1).join(", ")} and ${HOURS.at(-1)} h at 10 states each and at the 400x300 start, at 3 states past the top tier at 1 h, and at 5 states with unequal channels on ${Object.keys(CHANNEL_SEEDS).length} seeds`, same(held.hours, HOURS) && held.states === 10 && held.at_each_hours.every((n) => n === 10) && held.half_start === 10 && same(held.past_the_top, [3, 3]) && held.channel_states === 5 && same(held.channel_seeds, Object.keys(CHANNEL_SEEDS)), JSON.stringify(held));

	for (const hours of Object.keys(LOGIC.ceilings)) {
		const slot = seed(hours), { wrong, detail } = await play(slot, STATES, LOGIC.ceilings[hours]);
		check(`the client's logic ceiling is the world's at ${hours} h, at ${STATES.length} states`, slot.auto_copy_logic_hours === Number(hours) && wrong.length === 0, detail);
	}

	// The 400x300 start's own slot data, which has no Matched Pixels: logic counts its 120,000 pixels by hand.
	const half = seed("half_start"), from_half = await play(half, STATES, LOGIC.half_start_ceilings);
	check(`at the 400x300 start, with the world's slot data for it and 0 Matched Pixels, the client's logic ceiling is the world's at ${STATES.length} states`, half.start_width === 400 && half.start_height === 300 && half.matched_pixels === 0 && from_half.wrong.length === 0, from_half.detail);

	// A YAML's start inventory can give a seed more speed copies than auto copy's top tier, slot data's
	// auto_copy_speed_items. At 1 h the top tier at 90% misses gets 368,640 of the goal's 480,000 pixels right.
	const one = seed(1), past = await play(one, LOGIC.past_the_top_states, LOGIC.past_the_top_ceilings);
	check(`speed copies past auto copy's top tier, ${one.auto_copy_speed_items} copies, count as the top tier: the client's logic ceiling is the world's at 1 h with 11 and 12 copies`, one.auto_copy_logic_hours === 1 && LOGIC.past_the_top_states.every((state) => state[3] > one.auto_copy_speed_items) && past.wrong.length === 0, past.detail);

	for (const [name, [input, shows]] of Object.entries(CHANNEL_SEEDS)) {
		const slot = seed(name), { wrong, detail } = await play(slot, LOGIC.channel_states, LOGIC.channel_ceilings[name]);
		check(`the client's logic ceiling reads ${input}: the world's at ${LOGIC.channel_states.length} states with unequal channels`, shows(slot) && wrong.length === 0, detail);
	}

	// A seed from before Phase 5, at version 1.0.0 with no auto_copy_logic_hours in its slot data, counts the whole
	// canvas by hand.
	const { auto_copy_logic_hours, ...phase_4 } = SLOT;
	const before_phase_5 = { ...phase_4, version: "1.0.0" }, older = await play(before_phase_5, STATES, LOGIC.ceilings[0]);
	check("a seed from before Phase 5 counts the whole unlocked canvas by hand", older.wrong.length === 0, older.detail);
	// The versions the client tests a seed's version against, 0.2.0 and 0.5.0, read Phase 5's 1.1.0 as they read 1.0.0.
	const versions = await evaluate(async (slots) => {
		const ap = await import("/src/archipelago.js");
		return slots.map((slot) => {
			ap.fake_session(slot, ["Magnifier", "Brush"]);
			return `${slot.version} below 0.2.0 ${ap.version_below("0.2.0")}, below 0.5.0 ${ap.version_below("0.5.0")}`;
		});
	}, [SLOT, before_phase_5]);
	check("the client reads a seed at 1.1.0 as one at 1.0.0: from 0.5.0 on", same(versions, ["1.1.0 below 0.2.0 false, below 0.5.0 false", "1.0.0 below 0.2.0 false, below 0.5.0 false"]), versions.join("; "));

	// Logic counts only the copies that arrive as progression: a speed copy that arrives as useful doesn't raise the
	// ceiling, and one that arrives as progression doubles what auto copy gets right in the hours.
	const SIX = seed(6);
	const canvas = items_for([254, 8, 6, 0, 0, true]);
	const speed = { base: await ceiling(SIX, canvas), useful: await ceiling(SIX, [...canvas, { name: "Progressive Auto Copy Speed", progression: false }]), progression: await ceiling(SIX, [...canvas, "Progressive Auto Copy Speed"]) };
	check("a speed copy that arrives as useful doesn't count, and one that arrives as progression does", close(speed.base, world_ceiling([254, 8, 6, 0, 0, true])) && close(speed.useful, speed.base) && close(speed.progression, world_ceiling([254, 8, 6, 1, 0, true])), JSON.stringify(speed));
	// The second Progressive Pick Color is useful, so arriving first it doesn't lift the cap on hand-painted color.
	const no_pick = items_for([254, 8, 6, 0, 0, false]);
	const pick = { none: await ceiling(SIX, no_pick), useful: await ceiling(SIX, [...no_pick, { name: "Progressive Pick Color", progression: false }]), progression: await ceiling(SIX, [...no_pick, "Progressive Pick Color"]) };
	check("a Pick Color copy that arrives as useful doesn't lift the hand-painted cap", close(pick.useful, pick.none) && pick.progression > pick.none, JSON.stringify(pick));

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
