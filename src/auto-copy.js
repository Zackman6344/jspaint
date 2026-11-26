// Auto copy and the M keys: the Copy Goal bookmarklet, built into Pain-T (D5, D6, D9 and D10 of the fork's
// ROADMAP.md).
// Point at a pixel of the goal image or of your canvas and press M: the goal's color, rounded to your color depth the
// way Pick Color rounds it, goes into that pixel of your canvas. Hold M and move to paint the goal in as you go.
// Shift+M starts or pauses auto copy, which works through the canvas by itself, and Extras > Auto Copy opens its panel.
// Its top speed is 1 pixel a second, doubled by each Progressive Auto Copy Speed; the panel picks any speed up to it,
// and M draws from the same allowance. Banked Overclock doubles auto copy's speed while it runs. Ctrl+Z undoes each
// press of M in one step, and auto copy a minute at a time.
// Auto copy and M miss (D7): 90% of the pixels they paint at the start come out a shade off, within the miss margin, until
// Progressive Auto Copy Accuracy and Progressive Miss Margin items close the gap. One run of auto copy is one pass over
// the canvas; Auto Copy Loop starts each next one by itself.

import { calculate_similarity, deselect, goal_pixels, scoring_formula, show_similarity, shown_view, undoable, update_helper_layer } from "./functions.js";
import { $G, get_icon_for_tool, get_rgba_from_color } from "./helpers.js";
import { legalizeColor } from "./$ColorBox.js";
import { final_height, final_width, game_changed, rungs, send, session_name, slotData, watch_reads } from "./archipelago.js";
import { goal_ready } from "./goal.js";
import { draws, land_chance, margin_ranges, miss_margin, miss_percent, miss_value, rolls_miss, seeded } from "./misses.js";
import { pixel_score } from "./scoring.js";
import { quantize } from "./shades.js";

const KEY = "m";
const STEP_SECONDS = 60; // each minute of auto copy is one undo step, so an Undo Trap costs at most a minute
const HOLD_OFF_SECONDS = 3; // auto copy waits this long after an undo, a trap or your own stroke, so Ctrl+Z can walk back past it
const SEND_EVERY_MS = 1000; // checks go out at most once a second while auto copy runs (D9)
const RESYNC_EVERY_MS = 60000; // a full rescore now and then keeps the running total honest
const TOP = 99; // the speed you picked is the top one, so a new Progressive Auto Copy Speed raises it

let enabled = true;
let last_client = null; // last pointer position, in client coordinates
let sweep = null; // while M is held, and until its last pixels are painted
let auto = null; // auto copy's progress, while its panel is open
let panel = null;
let chosen_tier = load_tier();
let status_timer = 0;
let connection_window = null;

const pick_color_icon = () => get_icon_for_tool(get_tool_by_id("TOOL_PICK_COLOR"));
const in_bounds = (element, { x, y }) => x >= 0 && y >= 0 && x < element.width && y < element.height;
// Browsers that blur canvas reads against fingerprinting (Brave, Firefox's strict mode) can read a color back a step
// off. The page checks for that as it loads, and again whenever a pixel auto copy or M just wrote reads back different
// (D7). Only then may each channel be 1 off when a pixel is judged. Reads further off than that can't judge pixels, and
// count as blocked until a later probe reads clean (reads_are_blocked()). From the first block to the page's end the
// canvas counts as tainted (canvas_tainted()).
let read_noise = null; // where noise was found: "load" or "read-back", or null for none
let reads_blocked = false;
let blocked_once = false;
const BLOCKED = "Your browser blocks reading the canvas, which auto copy and M need. Allow canvas reads for this site.";
// Once reads come clean after a block, auto copy and M wait for a reload, as saves and sends do.
const RELOAD_TO_COPY = "Now that canvas reads are allowed, reload this tab to use auto copy and M.";
const tainted_message = () => (reads_blocked ? BLOCKED : RELOAD_TO_COPY);
// Reads found more than a step off: blocked for now, and the canvas tainted for the rest of the page.
function block_reads() {
	reads_blocked = true;
	blocked_once = true;
}
const takes_text = (element) => element instanceof HTMLElement && (element.isContentEditable || element.matches("textarea, select, input:not([type=range], [type=button], [type=checkbox], [type=radio])"));
const count_of = rungs;

function show_status(message) {
	$status_text.text(message);
	clearTimeout(status_timer);
	status_timer = setTimeout(() => {
		if ($status_text.text() === message) $status_text.default?.();
	}, 4000);
}

// --- Speed (D5), the shared allowance (D6) and Overclock (D10) ---

// Seeds from before the speed items (Phases 1 and 2) have none to find, so every tier is open there, as it was with the
// bookmarklet. Slot data names how many copies a seed has from Phase 3 on.
const before_speed_items = () => !!slotData.version && slotData.auto_copy_speed_items === undefined;

function top_tier() {
	if (before_speed_items()) return 10;
	return Math.min(count_of("Progressive Auto Copy Speed"), slotData.auto_copy_speed_items ?? 10);
}

function tier() {
	return Math.min(chosen_tier, top_tier());
}

// Pixels a second for M, and for auto copy before Overclock.
function speed() {
	return 2 ** tier();
}

function load_tier() {
	try {
		const saved = localStorage.getItem("pain-t-auto-copy-tier");
		if (saved !== null && Number.isInteger(Number(saved))) return Number(saved);
	} catch { }
	return TOP;
}

function change_tier(step) {
	const next = Math.max(0, Math.min(top_tier(), tier() + step));
	chosen_tier = next === top_tier() ? TOP : next;
	try { localStorage.setItem("pain-t-auto-copy-tier", String(chosen_tier)); } catch { }
	update_panel();
}

// --- Misses, the miss margin, passes and pass orders (D7, D23) ---

// Seeds from before Phase 4 have no accuracy, margin or Loop items to find, so auto copy never misses there and goes on
// pass after pass until the canvas is done, as it did. Slot data names miss_margin_step from Phase 4 on.
const before_misses = () => !!slotData.version && slotData.miss_margin_step === undefined;
const miss_chance = () => (before_misses() ? 0 : miss_percent(count_of("Progressive Auto Copy Accuracy")));
const margin = () => (before_misses() ? 0 : miss_margin(count_of("Progressive Miss Margin"), slotData.miss_margin_step ?? 1));
// The Loop switch, the pass order you picked and the orders auto copy has seen are kept for each game, so a new game
// starts with Loop on, and an order that arrived while the page was closed is picked as it opens. A write that storage
// refuses is kept for as long as the page is open.
const game_key = (what) => `pain-t-auto-copy-${what}:${session_name()}`;
const unsaved = new Map();
function load_text(key) {
	if (unsaved.has(key)) return unsaved.get(key);
	try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function save_text(key, text) {
	try {
		localStorage.setItem(key, text);
		unsaved.delete(key);
	} catch {
		unsaved.set(key, text);
	}
}

// Auto Copy Loop starts each next pass by itself, and starts a finished run again when the game reopens pixels. Its
// switch in the panel turns it off, so you can rest between passes and let the Overclock bank fill.
const has_loop = () => !before_misses() && count_of("Auto Copy Loop") >= 1;
const loop_switch = () => load_text(game_key("loop")) !== "off";
const loop_on = () => before_misses() || (has_loop() && loop_switch());

function set_loop(on) {
	save_text(game_key("loop"), on ? "on" : "off");
	update_panel();
}

// Draws for misses, auto copy's and M's apart, so a test can seed each and get the same misses again.
let auto_random = Math.random, m_random = Math.random;
const miss_stats = { auto: { rolled: 0, missed: 0 }, m: { rolled: 0, missed: 0 } };

// The pass orders of D23's second copies: the second Progressive Difference Mode paints the pixels furthest from the
// goal first, and the second Progressive Pick Color the pixels it can make exactly right at your shades first. Top to
// bottom stays on offer. An order that arrives is picked, worst first when both come at once. The orders seen in a game
// only ever grow, so a moment with no items, before they come in or after a reconnect, makes none arrive again.
const ORDER_NAMES = { top: "top to bottom", worst: "worst first", exact: "exact first" };
const order_unlocked = (order) => order === "top" || (!!slotData.ladders && count_of(order === "worst" ? "Progressive Difference Mode" : "Progressive Pick Color") >= 2);

function pass_order() {
	const unlocked = Object.keys(ORDER_NAMES).filter(order_unlocked);
	const seen = load_text(game_key("orders-seen")).split(",").filter(Boolean);
	const arrived = unlocked.filter((order) => order !== "top" && !seen.includes(order));
	if (arrived.length) {
		save_text(game_key("orders-seen"), [...seen, ...arrived].join());
		save_text(game_key("order"), arrived.includes("worst") ? "worst" : "exact");
	}
	const chosen = load_text(game_key("order"));
	if (unlocked.includes(chosen)) return chosen;
	return unlocked.includes("worst") ? "worst" : unlocked.includes("exact") ? "exact" : "top";
}

// The panel's order button picks one. A run that's going starts its pass again in the new order at its next tick, as it
// does when an order arrives.
function choose_order(order) {
	if (!order_unlocked(order)) return;
	save_text(game_key("order"), order);
	update_panel();
}

// One pixels-a-second allowance for M and auto copy. It only fills while one of them is copying, so neither saves up
// a burst while the other runs, and unspent time carries over for a second (a minute for a throttled background tab).
// With the second Progressive Similarity Mode (D23), M gets an allowance of its own and copies alongside auto copy.
const allowance = { tokens: 0, at: performance.now() };
const m_allowance = { tokens: 0, at: performance.now() };

function fill_allowance(bucket, rate, seconds, carry_seconds) {
	bucket.tokens = Math.min(bucket.tokens + rate * seconds, rate * Math.max(carry_seconds, 1));
	bucket.at = performance.now();
}

// The second Progressive Similarity Mode: M copies while auto copy runs instead of making it wait.
const together = () => !!slotData.ladders && count_of("Progressive Similarity Mode") >= 2;
// Whether M is copying alongside a running auto copy right now, into auto copy's own undo step.
const alongside = () => together() && !!auto?.running;

// Overclock (D10, D25): seconds of double speed, spent only while auto copy runs. Two kinds are banked. The bank fills by
// itself while you're connected and auto copy runs in no tab of the game, overclock_fill_speed_step seconds a minute for
// each Progressive Overclock Fill Speed, up to overclock_bank_size_step seconds for each Progressive Overclock Bank Size.
// A page holds a Web Lock while it runs auto copy, so a tab that rests doesn't fill the bank while another runs. Each
// Overclock filler adds overclock_seconds on top, past the bank's size if need be. The self-filled seconds are spent
// first, since they come back. Both stay with this browser; task 7.11 moves the seconds spent to the slot's data storage,
// and the bank stays here.
// Every tab of a game in this browser shares one record, kept in pieces that only one page writes. Each page writes its
// own running totals under its own key: the seconds it took from the fillers, and from the bank. At each merge, once a
// second or once a minute in a tab Chrome throttles, every tab adds up all the pages' totals, so seconds spent in one tab
// don't come back in another or after a reload, and no tab can write over another's spending. Two hidden tabs merging
// into one shared total in the same millisecond did that (D10). The bank's fill is one shared note of how many seconds
// have filled it in all, counted up to when. While auto copy runs in no tab, a connected tab moves that note on by the
// time since, so two tabs don't fill it twice, and a tab that stops running auto copy moves it on to then with nothing
// added. A run also leaves word in the note, for a tab that misses it between its merges. Every note is whole, so a tab
// that moves an older one on loses a second of fill at most, and adds none.
// A page's key is named for its id. A tab keeps its id through reloads, in sessionStorage, so a reload writes over its
// own key in place, and a new tab takes the id of a page that's closed, so the record keeps a key for each tab open at
// once. Every write, of a page's totals and of the fill note, goes to sessionStorage too, which has room of its own. So a
// reload in a tab whose keys full storage won't take keeps what it spent and what the bank had filled, and doesn't leave
// the bank under nothing by every second the tab ever took from it. The id is held with a Web Lock while the page is open,
// since a duplicated tab starts with a copy of the original's sessionStorage. Until the page holds it, a moment after
// loading or 2 s in a duplicated tab, nothing is banked.
const ID_KEY = "pain-t-overclock-id";
let PAGE = null;

// The id of every page that kept totals in this browser, for any game.
function stored_ids() {
	const ids = new Set();
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key?.startsWith("pain-t-overclock-page:")) ids.add(key.slice(key.lastIndexOf(":") + 1));
		}
	} catch { }
	return ids;
}

function settle_page() {
	const take = (id) => {
		PAGE = id;
		try { sessionStorage.setItem(ID_KEY, id); } catch { }
		update_panel();
	};
	const fresh = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	if (!navigator.locks) return take(fresh()); // nothing tells a duplicated tab apart, so an id of its own for each load
	// Whether this page got the id. It holds it until it closes.
	const hold = (id, options) => new Promise((resolve) => {
		try {
			navigator.locks.request(`${ID_KEY}:${id}`, options, (lock) => {
				resolve(!!lock);
				if (lock) return new Promise(() => { });
			}).catch(() => resolve(false));
		} catch {
			resolve(false);
		}
	});
	(async () => {
		let own = null;
		try { own = sessionStorage.getItem(ID_KEY); } catch { }
		// This tab's own id, once the page it reloaded lets go of it. A duplicated tab's original never does.
		if (own && await hold(own, AbortSignal.timeout ? { signal: AbortSignal.timeout(2000) } : { ifAvailable: true })) return take(own);
		// Else the id of a page that's closed, then a new one.
		let held = new Set();
		try { held = new Set((await navigator.locks.query()).held.map((lock) => lock.name)); } catch { }
		for (const id of stored_ids()) {
			if (!held.has(`${ID_KEY}:${id}`) && await hold(id, { ifAvailable: true })) return take(id);
		}
		const id = fresh();
		await hold(id, { ifAvailable: true });
		take(id);
	})();
}
const overclock = {
	session: null,
	mine: { spent: 0, used: 0 }, // this page's totals for the game: seconds taken from the fillers, and from the bank
	others: { spent: 0, used: 0, running: false }, // every other page's, at the last merge, and whether one ran auto copy
	// The newest note of the bank's fill: seconds filled in all, counted up to `at`, and `running` while a run may go on.
	fill: { filled: 0, at: 0 },
	fill_from: Date.now(),
	merged_at: null, // when this page last merged, by Date.now()
	ran: false, // whether this page ran auto copy in the game at its last merge
};

const overclock_key = (what) => `pain-t-overclock-${what}:${overclock.session}`;
const page_key = () => `${overclock_key("page")}:${PAGE}`;
const bank_size = () => count_of("Progressive Overclock Bank Size") * (slotData.overclock_bank_size_step ?? 0);
const fill_per_second = () => count_of("Progressive Overclock Fill Speed") * (slotData.overclock_fill_speed_step ?? 0) / 60;
const can_fill = () => fill_per_second() > 0 && bank_size() > 0 && !disconnected();

// What this page last wrote. It stands in where storage is turned off, or full and refusing the write, and a refused
// write is tried again at the next merge.
const kept = new Map(), refused = new Set();
const whole_totals = (totals) => Number.isFinite(totals?.spent) && Number.isFinite(totals?.used);
const whole_note = (note) => Number.isFinite(note?.filled) && Number.isFinite(note?.at);
// What localStorage holds under a key, or sessionStorage with `where` "session". The storage is named inside the try:
// with site data blocked, naming it throws.
function read(key, where = "local") {
	try {
		const value = (where === "session" ? sessionStorage : localStorage).getItem(key);
		if (value !== null) return JSON.parse(value);
	} catch { }
	return null;
}
function write(key, value) {
	kept.set(key, value);
	const text = JSON.stringify(value);
	try { sessionStorage.setItem(key, text); } catch { } // what a reload of this tab reads, if storage refused it
	try {
		localStorage.setItem(key, text);
		refused.delete(key);
	} catch {
		refused.add(key);
	}
}

// A page that runs auto copy in a game holds a Web Lock named for the game and its id, from the merge as auto copy
// starts, and lets go of it as auto copy stops, the page leaves the game, closes or goes into the back-forward cache. The
// browser lets go of it when the page crashes. Before each once-a-second merge, a page reads which of them are held, so
// a tab that rests sees another tab's run however its clock has moved, through a sleep or a clock change: no clock
// decides it. Without Web Locks, no page sees another's run.
const RUN_KEY = "pain-t-overclock-run";
let leaving = false; // the page is closing or going into the back-forward cache, so auto copy stops running here
const runs_here = () => !!auto?.running && !leaving;
const run_name = () => `${RUN_KEY}:${overclock.session}:${PAGE}`;
let run_lock = null; // the run lock this page holds or has asked for: { name, release }
let held_runs = []; // the names of the locks held at the latest query

function hold_run(name) {
	if (run_lock?.name === name) return;
	let_go_run();
	if (!navigator.locks) return;
	let release = () => { };
	const held = new Promise((resolve) => { release = resolve; });
	run_lock = { name, release };
	try {
		navigator.locks.request(name, () => held).catch(() => { });
	} catch { }
}

function let_go_run() {
	run_lock?.release();
	run_lock = null;
}

// Every other page's totals for the game, added up, and whether any of them runs auto copy there: holds its run lock,
// at the latest query.
function others_totals() {
	const prefix = `${overclock_key("page")}:`, own = page_key(), sum = { spent: 0, used: 0, running: false };
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(prefix) || key === own) continue;
			const totals = read(key);
			sum.spent += Number(totals?.spent) || 0;
			sum.used += Number(totals?.used) || 0;
		}
	} catch { }
	const runs = `${RUN_KEY}:${overclock.session}:`, own_run = run_name();
	sum.running = held_runs.some((name) => name.startsWith(runs) && name !== own_run);
	return sum;
}

// The fill note to count from: the one stored. This page's own last note, from this load or from sessionStorage after a
// reload, counts only while storage refuses its writes or holds no note, since after a clock set back the page's older
// note would outrank another tab's newer one. Then the later of the two goes first, and a note from after now, written
// before the clock was set back, goes last.
function fill_note(now) {
	const key = overclock_key("fill"), stored = read(key);
	const own = refused.has(key) || !whole_note(stored) ? kept.get(key) ?? read(key, "session") : null;
	const notes = [stored, own].filter(whole_note);
	const rank = (note) => [note.at <= now ? 1 : 0, note.at];
	notes.sort((x, y) => rank(y)[0] - rank(x)[0] || rank(y)[1] - rank(x)[1]);
	return notes[0] ?? { filled: 0, at: 0 };
}

// Loads what this browser kept for the game now connected, the first time anything asks about it, once this page holds
// its id.
function overclock_session() {
	if (PAGE === null) return;
	const session = session_name();
	if (session === overclock.session) return;
	// What was spent in the last game stays with it, and the page no longer runs auto copy there.
	if (overclock.session !== null) overclock_merge(false, false);
	overclock.session = session;
	// This page's own totals for the game, from this load or an earlier load of this tab, or from the closed page whose id
	// it took. Only this page writes them, and they only grow, so the largest is the latest.
	const totals = [kept.get(page_key()), read(page_key()), read(page_key(), "session")].filter(whole_totals);
	overclock.mine = { spent: Math.max(0, ...totals.map((t) => t.spent)), used: Math.max(0, ...totals.map((t) => t.used)) };
	overclock.fill_from = Date.now(); // the bank fills while a tab is open, not while none is
	overclock_merge(false);
}

// Adds up the other pages' totals, moves the fill note on when this tab fills the bank or has just stopped running auto
// copy, holds this page's run lock or lets go of it, and writes this page's totals if they changed. `running` says
// whether this page runs auto copy in this game.
function overclock_merge(filling, running = runs_here()) {
	const now = Date.now(), last_merge = overclock.merged_at ?? now, saw_run = overclock.others.running;
	overclock.others = others_totals();
	overclock.merged_at = now;
	// The bank fills only while auto copy runs in no tab of the game (D25). `stopped`: this page ran auto copy in the
	// game at its last merge and doesn't now, after a pause, a close, a trip into the back-forward cache, or a game left
	// while it ran. Then the fill counts from now, and the note moves on to now with nothing added, so no tab fills the
	// time since that merge.
	const stopped = !running && overclock.ran;
	overclock.ran = running;
	if (running) hold_run(run_name());
	else let_go_run();
	if (running || overclock.others.running) filling = false;
	if (stopped) overclock.fill_from = now;
	let note = fill_note(now);
	// Once another tab's run ends, the fill counts from the note its stop left. Nothing says when a run ended if this tab
	// saw it and finds no note since its last merge, or if the note says a run may go on, as a start leaves it and as a
	// stop beside another run does: that run ended with no note of its own, as when its tab crashes, so the fill counts
	// from now. Only in a tab that rests: while this page runs, or as it stops, the word may be its own.
	const resting = !running && !stopped;
	if (resting && !overclock.others.running && ((saw_run && !(note.at > last_merge)) || note.running)) overclock.fill_from = now;
	if (filling || stopped) {
		if (overclock.fill_from > now) overclock.fill_from = now; // the clock was set back
		// Never counted from later than now, and at most a minute and a half back, so a clock set forward or a computer
		// waking from sleep fills that much at most.
		const from = Math.min(now, Math.max(note.at, overclock.fill_from, now - 90000));
		const full = overclock.others.used + overclock.mine.used + bank_size();
		const filled = Math.max(note.filled, Math.min(full, note.filled + fill_per_second() * (now - from) / 1000));
		note = { filled, at: now, running: overclock.others.running };
		write(overclock_key("fill"), note);
	} else if (running && !note.running && navigator.locks?.query) {
		// A run leaves word in the note, so a tab that misses it between merges, as one Chrome wakes once a minute,
		// doesn't fill the bank for it if it ends with no note. A run whose word another tab's write took away puts it
		// back here. Without Web Locks no page sees another's run, and none leaves word.
		note = { ...note, running: true };
		write(overclock_key("fill"), note);
	}
	overclock.fill = note;
	const mine = overclock.mine, last = kept.get(page_key());
	const changed = last ? last.spent !== mine.spent || last.used !== mine.used : mine.spent || mine.used;
	if (changed || refused.has(page_key())) write(page_key(), { ...mine });
}

// Seconds left over from adding and taking away fractions, too few to show or spend.
const dust = (seconds) => (seconds > 1e-6 ? seconds : 0);

// The Overclock fillers' seconds not spent yet.
function filler_banked() {
	overclock_session();
	if (overclock.session === null) return 0;
	return dust(count_of("Overclock") * (slotData.overclock_seconds ?? 5) - overclock.others.spent - overclock.mine.spent);
}

// The bank's level. Under nothing while two tabs spent the same seconds, until its fill makes them up.
function bank_level() {
	overclock_session();
	if (overclock.session === null) return 0;
	return overclock.fill.filled - overclock.others.used - overclock.mine.used;
}

// The bank's own seconds that can be spent.
function bank_banked() {
	return Math.min(dust(bank_level()), bank_size());
}

function overclock_banked() {
	return filler_banked() + bank_banked();
}

// Once a second: reads which pages hold run locks, then merges. The merge fills the bank by real time since it was last
// counted, so a throttled background tab fills as fast as a shown one, and time spent disconnected, or running auto
// copy in any tab, doesn't count. It's the one merge that fills the bank right after it reads the locks; the merge as
// a page closes fills only while the note says no run may go on.
function fill_bank() {
	overclock_session();
	if (!can_fill()) overclock.fill_from = Date.now();
	if (!navigator.locks?.query) return overclock_save();
	navigator.locks.query().then((state) => { held_runs = state.held.map((lock) => lock.name); }, () => { }).then(overclock_save);
}

// Spends seconds of double speed: the self-filled ones first, then the fillers'. Returns the fillers' share.
function overclock_spend(seconds) {
	const from_bank = Math.min(seconds, bank_banked());
	overclock.mine.used += from_bank;
	overclock.mine.spent += seconds - from_bank;
	return seconds - from_bank;
}

function overclock_save() {
	if (overclock.session !== null) overclock_merge(can_fill());
}

// --- The running similarity total (D9) ---
// Auto copy works out each pixel's score before and after it paints it and keeps the sum, so it can send checks once a
// second without scoring the whole canvas. Any change it didn't make, a new canvas size, and once a minute, it scores
// the whole canvas again with calculate_similarity().

const scores = { sum: 0, valid: false, width: -1, height: -1, synced_at: 0 };

// Paint's history events that auto copy didn't fire itself. Some change the canvas and leave current_history_node where
// it was: Esc or the other button mid-stroke rolls back to the step the stroke started on, and so does a click on the
// current History entry.
let history_changes = 0;
let own_history_change = false;
function own_history(callback) {
	own_history_change = true;
	try { return callback(); } finally { own_history_change = false; }
}

function resync(now) {
	const similarity = calculate_similarity();
	scores.sum = similarity * final_width * final_height / 100;
	scores.valid = true;
	scores.width = main_canvas.width;
	scores.height = main_canvas.height;
	scores.synced_at = now;
	return similarity;
}

function running_similarity() {
	return scores.sum * 100 / (final_width * final_height);
}

// Similarity and Difference Mode draw from the full score, so while either view shows, auto copy scores the whole
// canvas now and then, keeping that to about 2% of the time as M does.
let view_every = 1000;
const views_shown = () => shown_view !== null;

// --- Where the pointer is ---

// The pixel of the canvas or goal image at a client point. Not clamped, so points past the edges stay outside.
function position_on(element, clientX, clientY) {
	const rect = element.getBoundingClientRect();
	if (!rect.width || !rect.height) return null;
	return {
		x: Math.floor((clientX - rect.left) * element.width / rect.width),
		y: Math.floor((clientY - rect.top) * element.height / rect.height),
	};
}

// Whether the canvas or goal image is what shows at a client point, rather than a dialog, a menu or,
// in Side-by-Side Mode, the other half. A floating selection counts as the canvas.
function shows(element, clientX, clientY) {
	const hit = document.elementFromPoint(clientX, clientY);
	return hit === element || (element === main_canvas && !!hit?.closest(".on-canvas-object"));
}

function pixel_under_cursor() {
	if (!last_client) return null;
	const { clientX, clientY } = last_client;
	for (const element of [main_canvas, goal_canvas]) {
		const pixel = position_on(element, clientX, clientY);
		if (pixel && in_bounds(element, pixel) && shows(element, clientX, clientY)) return pixel;
	}
	return null;
}

// Every pixel on the line from a to b, not counting a, so fast mouse moves don't leave gaps.
function each_pixel_on_line(a, b, callback) {
	const dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y);
	const step_x = a.x < b.x ? 1 : -1, step_y = a.y < b.y ? 1 : -1;
	let { x, y } = a;
	let error = dx + dy;
	while (x !== b.x || y !== b.y) {
		const doubled = 2 * error;
		if (doubled >= dy) { error += dy; x += step_x; }
		if (doubled <= dx) { error += dx; y += step_y; }
		callback(x, y);
	}
}

// Puts the goal's color at (x, y) into the same pixel of the canvas, rounded the way Pick Color rounds it, if the
// allowance has a pixel left, and keeps the running total up to date. M misses as auto copy does (D6). Returns "same"
// when the pixel is already as good as your best shade, "wait" when the allowance is empty, "painted" or "missed".
function copy_pixel({ x, y }, bucket, tables) {
	const goal = goal_pixels(), at = (y * goal.width + x) * 4;
	const gr = goal.data[at], gg = goal.data[at + 1], gb = goal.data[at + 2];
	const pixel = main_ctx.getImageData(x, y, 1, 1);
	if (settled(pixel.data, 0, gr, gg, gb, tables)) return "same";
	if (bucket.tokens < 1) return "wait";
	bucket.tokens -= 1;
	const [r, g, b] = attempt(gr, gg, gb, tables, m_random, miss_stats.m);
	const [cr, cg, cb] = pixel.data;
	const formula = scoring_formula();
	scores.sum += pixel_score(formula, r - gr, g - gg, b - gb) - pixel_score(formula, cr - gr, cg - gg, cb - gb);
	pixel.data.set([r, g, b, 255]);
	main_ctx.putImageData(pixel, x, y);
	last_write = { x, y, r, g, b };
	return lands(r, g, b, gr, gg, gb, tables) ? "painted" : "missed";
}

// Changing the canvas mid-gesture is unsafe: if Paint cancels the gesture, it rolls back to where it started.
function busy() {
	return pointer_active || pointers.length > 0 || !!selection?.dragging;
}

// Gets the canvas ready for a change. A middle-click leaves a stale cancel point that Esc or Invert Colors would
// roll back to, so drop it. A floating selection or text box gets put down, like switching tools does.
function settle() {
	history_node_to_cancel_to = null;
	if (selection || textbox) deselect();
}

// The game shows its connection window again when the connection drops. Checks can't be sent until it's gone.
function disconnected() {
	connection_window ??= [...document.querySelectorAll(".window")].find((element) => /Archipelago Connection Options/.test(element.querySelector(".window-title")?.textContent ?? "")) ?? null;
	return !!connection_window && $(connection_window).is(":visible");
}

// --- Undo steps, autosave and checks ---
// Paint keeps a full copy of the canvas in every undo step, saves the canvas as a PNG at the pace sessions.js sets, 5 s
// apart or more (task 7.4), and scores checks over the whole area the canvas and the goal share. That's too heavy to do
// for every pixel, so painting marks them as due and catch_up() does them on a timer, and right away when copying stops.

// Makes a new undo step for what's on the canvas now. Paint autosaves and sends checks for a new step itself.
function new_step(state, name) {
	try {
		own_history(() => undoable({ name, icon: pick_color_icon() }, () => { }));
		state.unscored = false;
	} catch (error) {
		// Sending checks throws while disconnected, after the step is made but before Paint updates the
		// History window and autosaves. Do those two here, and send the checks again later.
		console.warn("Auto copy: couldn't send checks", error);
		own_history(() => $G.triggerHandler("history-update"));
		$G.triggerHandler("session-update");
		state.unscored = true;
	}
	state.node = current_history_node;
	state.name = name;
	state.stale = state.unsaved = false;
	state.snapshot_at = state.saved_at = state.scored_at = performance.now();
	update_helper_layer();
}

// Records what was just painted: in state's undo step while it's still the current one, otherwise in a new step.
function commit(state, name) {
	if (!state.node || current_history_node !== state.node || current_history_node.futures.length) return new_step(state, name);
	state.name = name;
	state.stale = state.unsaved = state.unscored = true;
	update_helper_layer();
	catch_up(state);
}

// Paint's own update of a step (make_or_update_undoable), minus rebuilding the History window, which every 50 ms
// would make it impossible to scroll or click. It only needs rebuilding when the name changes. It reads the whole
// canvas, so the next waits 50 times what this one took, or the state's own interval if that's longer, keeping these
// reads to about 2% of the time as view_every and M's scoring do (task 7.3). Pausing, letting go of M and a press on
// the canvas still save one at once.
function save_snapshot(state) {
	if (!state.stale || current_history_node !== state.node) return;
	const started = performance.now();
	state.node.image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
	state.stale = false;
	state.snapshot_at = performance.now();
	state.snapshot_every = Math.max(state.min_snapshot_every, (state.snapshot_at - started) * 50);
	note_read(read_log.snapshots, state === auto ? "auto copy" : "M");
	if (state.node.name !== state.name) {
		state.node.name = state.name;
		own_history(() => $G.triggerHandler("history-update"));
	}
}

// Brings the undo step, autosave and checks up to date where they're due, or all of them with force.
function catch_up(state, force) {
	const now = performance.now();
	// Not mid-gesture: some tools draw on the canvas before their own step exists.
	if (state.stale && !busy() && (force || now - state.snapshot_at >= state.snapshot_every)) save_snapshot(state);
	if (state.unsaved && (force || now - state.saved_at >= 5000)) {
		state.unsaved = false;
		state.saved_at = now;
		$G.triggerHandler("session-update"); // asks for an autosave, which sessions.js paces (task 7.4)
	}
	if (state.unscored && (force || now - state.scored_at >= state.score_every)) send_checks(state, force);
	if (force && state === auto) overclock_save();
}

// Auto copy sends from the running total, once a second. M, and auto copy when it stops, scores the whole canvas,
// and the gap until the next full score grows with how long this one took, keeping it to about 2% of the time.
function send_checks(state, full) {
	const started = performance.now();
	try {
		let similarity;
		const view_due = state === auto && views_shown() && started - scores.synced_at >= view_every;
		if (state === auto && scores.valid && !full && !view_due) {
			similarity = running_similarity();
			show_similarity(similarity);
		} else {
			similarity = resync(started);
			if (state === auto) view_every = Math.max(SEND_EVERY_MS, (performance.now() - started) * 50);
		}
		send(similarity);
		state.unscored = false;
	} catch (error) {
		console.warn("Auto copy: couldn't send checks", error); // stays due, so they're sent once the connection is back
	}
	state.scored_at = performance.now();
	state.score_every = state === auto ? SEND_EVERY_MS : Math.max(state.min_score_every, (state.scored_at - started) * 50);
}

const new_progress = (snapshot_every, min_score_every) => ({ node: null, name: "", stale: false, unsaved: false, unscored: false, snapshot_at: 0, saved_at: 0, scored_at: 0, snapshot_every, min_snapshot_every: snapshot_every, score_every: min_score_every, min_score_every });

// For tests: when the last counts of the pixels left and the last snapshots of a step ran, by performance.now().
const read_log = { counts: [], snapshots: [] };
function note_read(list, by = null) {
	list.push(by ? { at: performance.now(), by } : performance.now());
	if (list.length > 40) list.shift();
}

// --- Hold M ---
// M paints from the same allowance as auto copy (D6): at most one second of it waits in line, and pixels passed over
// faster than that are skipped. Letting go of M finishes the ones in line.

function queue(pixel) {
	sweep.seen = true;
	if (!in_bounds(main_canvas, pixel) || !in_bounds(goal_canvas, pixel)) {
		sweep.outside = true; // a goal pixel past the canvas size you've unlocked
		return;
	}
	if (sweep.pending.length >= Math.max(1, Math.ceil(speed()))) sweep.skipped++;
	else sweep.pending.push(pixel);
}

function start_sweep(code) {
	if (!goal_ready()) return show_status("M can't copy until the goal image has loaded."); // task 7.8
	if (busy()) return show_status("Let go of the mouse first.");
	if (canvas_tainted()) return show_status(tainted_message()); // probes, for reads blocked or allowed since the last ask
	if (sweep) end_sweep(true);
	// filled_at starts where the allowance last filled, so time nothing was copying still counts, up to a second.
	sweep = { ...new_progress(250, 500), code, last: null, pending: [], count: 0, missed: 0, first: null, seen: false, outside: false, skipped: 0, frame: 0, timer: 0, released: false, filled_at: (alongside() ? m_allowance : allowance).at };
	const pixel = pixel_under_cursor();
	if (pixel) queue(pixel);
	if (last_client) sweep.last = { canvas: position_on(main_canvas, last_client.clientX, last_client.clientY), goal: position_on(goal_canvas, last_client.clientX, last_client.clientY) };
	flush_sweep(); // a tap copies right away when the allowance has a pixel
}

// Queues every pixel between the last pointer position and this one, on whichever of the canvas and goal image
// shows there. Positions past the edges still count as line ends, so a fast move onto the canvas misses nothing.
function follow_cursor() {
	const { clientX, clientY } = last_client;
	const next = { canvas: position_on(main_canvas, clientX, clientY), goal: position_on(goal_canvas, clientX, clientY) };
	for (const [side, element] of [["canvas", main_canvas], ["goal", goal_canvas]]) {
		const from = sweep.last?.[side], to = next[side];
		if (!from || !to) continue;
		const rect = element.getBoundingClientRect();
		each_pixel_on_line(from, to, (x, y) => {
			if (!in_bounds(element, { x, y })) return;
			if (shows(element, rect.left + (x + 0.5) * rect.width / element.width, rect.top + (y + 0.5) * rect.height / element.height)) queue({ x, y });
		});
	}
	sweep.last = next;
	if (sweep.pending.length && !sweep.frame && !sweep.timer) sweep.frame = requestAnimationFrame(flush_sweep);
}

function flush_sweep() {
	if (!sweep) return;
	sweep.frame = 0;
	clearTimeout(sweep.timer);
	sweep.timer = 0;
	let out_of_time = false;
	try {
		if (sweep.pending.length && !busy()) out_of_time = copy_pending();
	} catch (error) {
		// Let go of M, so nothing is left waiting on it: auto copy would hold off for a sweep that never ends.
		console.error("M stopped", error);
		sweep.pending = [];
		sweep.released = true;
		finish_sweep();
		return show_status(`M stopped: ${error.message}`);
	}
	if (sweep.pending.length && out_of_time) sweep.frame = requestAnimationFrame(flush_sweep);
	else if (sweep.pending.length) sweep.timer = setTimeout(flush_sweep, 50); // the allowance fills, then the rest go in
	else if (sweep.released) finish_sweep();
}

// Copies the pixels in line while the allowance has them and this frame has time. Returns whether time ran out first.
function copy_pending() {
	if (blocked_once) throw new Error(tainted_message()); // a save or a send since the last flush found the reads blocked
	const now = performance.now();
	// Alongside a running auto copy, M copies from its own allowance into auto copy's undo step: a step of its own would
	// make the two take turns making a new step every few milliseconds.
	const with_auto = alongside();
	const bucket = with_auto ? m_allowance : allowance;
	fill_allowance(bucket, speed(), Math.min((now - sweep.filled_at) / 1000, 1), 1);
	sweep.filled_at = now;
	settle();
	const tables = rounding_tables();
	const deadline = now + 8; // a long line of pixels goes in over a few frames, so the page keeps drawing
	let changed = 0, out_of_time = false;
	last_write = null;
	while (sweep.pending.length) {
		if (performance.now() >= deadline) {
			out_of_time = true;
			break;
		}
		const result = copy_pixel(sweep.pending[0], bucket, tables);
		if (result === "wait") break;
		const pixel = sweep.pending.shift();
		if (result === "painted" || result === "missed") {
			changed++;
			if (result === "missed") sweep.missed++;
			sweep.first ??= pixel;
		}
	}
	check_read_back(); // the last pixel M wrote should read back as written
	if (changed) {
		sweep.count += changed;
		if (with_auto) {
			// M's pixels are auto copy's own change, not one to wait for. A trap, an undo or a selection put down since
			// auto copy last looked still is: leave it for auto_tick() to see, and rescore before anything is sent.
			const nothing_new = current_history_node === auto.seen_node && history_changes === auto.seen_changes;
			if (!nothing_new) scores.valid = false;
			commit(auto, "Auto Copy Goal");
			if (nothing_new) auto.seen_node = current_history_node;
		} else {
			commit(sweep, sweep.count === 1 ? "Copy Goal Pixel" : "Copy Goal Pixels"); // one undo step per press
		}
	}
	if (reads_blocked) throw new Error(BLOCKED); // M lets go and says why, its pixels so far in their undo step
	return out_of_time;
}

// Letting go of M finishes the pixels in line, at most a second of them. A click, losing focus or turning the keys
// off drops them.
function end_sweep(drop) {
	if (!sweep) return;
	cancelAnimationFrame(sweep.frame);
	sweep.frame = 0;
	sweep.released = true;
	if (drop) {
		clearTimeout(sweep.timer);
		sweep.skipped += sweep.pending.length;
		sweep.pending = [];
	}
	flush_sweep();
}

function finish_sweep() {
	catch_up(sweep, true);
	const { count, missed, first, seen, outside, skipped } = sweep;
	sweep = null;
	const limit = skipped ? ` M copies ${speed().toLocaleString()} ${speed() === 1 ? "pixel" : "pixels"} a second at your speed, so ${skipped.toLocaleString()} passed over were left.` : "";
	if (count === 1) show_status(`Copied ${first.x},${first.y} from the goal${missed ? ", but missed" : ""}.${limit}`);
	else if (count > 1) show_status(`Copied ${count.toLocaleString()} pixels from the goal${missed ? `, ${missed.toLocaleString()} of them missed` : ""}.${limit}`);
	else if (skipped) show_status(`Nothing copied yet.${limit}`);
	else if (outside) show_status(`That's past the edge of your canvas (${main_canvas.width}x${main_canvas.height}).`);
	else show_status(seen ? "Already matches the goal." : "Point at the goal image or your canvas, then press M.");
}

// --- Auto copy (Shift+M) ---
// Works through the canvas row by row and copies pixels that don't match yet, at the speed you pick.
// Pixels that already match cost nothing, so a nearly finished canvas goes quicker, but never faster than the speed.

let tables = null, tables_key = "", tables_for = null, tables_changed_at = 0;
const one_pixel = new ImageData(1, 1);
const STRIP = 16; // the canvas is read 16 rows at a time, from each multiple of 16

// How many shades each channel has, from your Progressive Color Depth items.
function shade_counts() {
	const table = slotData.shade_counts ?? [2];
	return ["Red", "Green", "Blue"].map((channel) => table[Math.min(count_of(`Progressive Color Depth (${channel})`), table.length - 1)]);
}

// Pick Color's rounding as one lookup table per channel: legalizeColor()'s quantize() at each channel's shade count,
// rebuilt only when a Progressive Color Depth or a Progressive Miss Margin arrives. Four colors through legalizeColor()
// itself check that it still rounds that way. legalizeColor() rounds what a 1x1 canvas reads back, which Brave's
// farbling can put a step off the color written, so each is looked up at that read. Beside each table: `best`, how far
// each value is from its shade, squared, and `ranges`, the shades a miss can paint around each one (D7).
function rounding_tables() {
	const table = slotData.shade_counts ?? [2];
	const shades = shade_counts();
	const spread = margin(), key = `${shades.join()}/${spread}`;
	if (key === tables_key && table === tables_for) return tables;
	const built = shades.map((count) => Uint8Array.from({ length: 256 }, (_, value) => quantize(value, count)));
	for (const rgb of [[12, 200, 77], [255, 128, 0], [90, 90, 250], [131, 7, 190]]) {
		const color = `rgb(${rgb})`, read = get_rgba_from_color(color);
		if (legalizeColor(color).match(/\d+/g).map(Number).some((value, channel) => value !== built[channel][read[channel]])) throw new Error("Pick Color's rounding has changed in this version of the game");
	}
	built.best = built.map((rounded) => Int32Array.from(rounded, (shade, value) => (shade - value) ** 2));
	built.ranges = built.map((rounded) => margin_ranges(rounded, spread));
	tables = built;
	tables_key = key;
	tables_for = table;
	tables_changed_at = performance.now(); // a new shade can reopen pixels that were done, so count them again soon
	return tables;
}

// Whether a canvas pixel already scores at least as well as the best shade you can paint for its goal pixel, compared
// exactly (D7). Shade sets aren't nested, so a pixel painted at an older depth may beat every shade you have now, and
// then it's left alone. Where reads are noisy, each channel may be 1 off first. Alpha has to be exact.
function settled(data, i, gr, gg, gb, { best }) {
	if (data[i + 3] !== 255) return false;
	let dr = Math.abs(data[i] - gr), dg = Math.abs(data[i + 1] - gg), db = Math.abs(data[i + 2] - gb);
	if (read_noise) {
		dr = Math.max(0, dr - 1);
		dg = Math.max(0, dg - 1);
		db = Math.max(0, db - 1);
	}
	return dr * dr + dg * dg + db * db <= best[0][gr] + best[1][gg] + best[2][gb];
}

// Whether a color just painted is as good as the best shade: a hit, though it may have been a miss that drew right.
function lands(r, g, b, gr, gg, gb, { best }) {
	return (r - gr) ** 2 + (g - gg) ** 2 + (b - gb) ** 2 <= best[0][gr] + best[1][gg] + best[2][gb];
}

// What auto copy or M paints for a goal pixel: the right shades, or on a miss one draw per channel within the margin.
function attempt(gr, gg, gb, tables, random, stats) {
	const r = tables[0][gr], g = tables[1][gg], b = tables[2][gb];
	stats.rolled++;
	if (!rolls_miss(miss_chance(), random)) return [r, g, b];
	stats.missed++;
	const [red, green, blue] = tables.ranges;
	return [miss_value(red, r, random), miss_value(green, g, random), miss_value(blue, b, random)];
}

// The goal is the page's one read of it (goal_pixels(), task 7.3), whole, so every pixel is judged against the same
// read: in a browser whose reads are noisy, a read of another size or place can come back different. A new goal is read
// again at its save-goal; a count of the pixels left, M and a new pass don't read it.

// The last pixel auto copy or M wrote, read back in the same task: nothing else can have changed it, so a difference is
// read noise. A step off turns on the 1-level tolerance until the page reloads; further off, reads can't judge pixels.
let last_write = null;
function check_read_back() {
	if (!last_write || read_noise || reads_blocked) return;
	const { x, y, r, g, b } = last_write;
	const back = main_ctx.getImageData(x, y, 1, 1).data;
	const off = Math.max(Math.abs(back[0] - r), Math.abs(back[1] - g), Math.abs(back[2] - b));
	if (off > 1) block_reads();
	else if (off === 1) read_noise = "read-back";
	last_write = null;
}

// Three patterns written to a small canvas and read back. How far off the reads come: 0 means reads are clean, 1 means
// noise, and more means reads are blocked.
function probe_off() {
	const probe = document.createElement("canvas");
	probe.width = probe.height = 16;
	const context = probe.getContext("2d", { willReadFrequently: true });
	let off = 0;
	try {
		for (let round = 0; round < 3; round++) {
			const image = context.createImageData(16, 16);
			for (let i = 0; i < image.data.length; i += 4) image.data.set([(i * 7 + round * 61) % 256, (i * 13 + 40 + round * 17) % 256, (i * 29 + 90 + round * 101) % 256, 255], i);
			context.putImageData(image, 0, 0);
			const back = context.getImageData(0, 0, 16, 16).data;
			for (let i = 0; i < back.length; i++) off = Math.max(off, Math.abs(back[i] - image.data[i]));
		}
	} catch {
		off = 256;
	}
	return off;
}
// The probe as the page loads, once a page.
let probed = false;
function probe_reads() {
	if (probed) return;
	probed = true;
	const off = probe_off();
	if (off > 1) block_reads();
	else if (off === 1) read_noise = "load";
}

// How many pixels of the unlocked canvas aren't yet as good as your best shade, at your color depth. The canvas is read
// in the strips the scan reads: in a browser whose reads are noisy, a read of another size or place can come back
// different, and a pixel the count calls off that the scan calls done would keep a Loop run going with nothing to paint.
// Beside the count, how many tries those pixels should take at your miss chance, for the time left. A count's cost sets
// how long the next waits (count_every()).
let tries_per_pixel = 1, count_cost = 0;
function count_left() {
	const started = performance.now();
	const tables = rounding_tables(), goal = goal_pixels(), chance = miss_chance();
	const width = Math.min(main_canvas.width, goal.width), height = Math.min(main_canvas.height, goal.height);
	const [red, green, blue] = tables.ranges;
	let left = 0, tries = 0;
	for (let top = 0; top < height; top += STRIP) {
		const rows = Math.min(STRIP, height - top), canvas = main_ctx.getImageData(0, top, width, rows).data;
		for (let y = top; y < top + rows; y++) {
			for (let x = 0, i = (y - top) * width * 4, at = y * goal.width * 4; x < width; x++, i += 4, at += 4) {
				const gr = goal.data[at], gg = goal.data[at + 1], gb = goal.data[at + 2];
				if (settled(canvas, i, gr, gg, gb, tables)) continue;
				left++;
				tries += 1 / land_chance(chance, draws(red, tables[0][gr]) * draws(green, tables[1][gg]) * draws(blue, tables[2][gb]));
			}
		}
	}
	tries_per_pixel = left ? tries / left : 1;
	count_cost = performance.now() - started;
	note_read(read_log.counts);
	return left;
}

// While auto copy runs, and from the panel while it's stopped, the pixels left are counted every 2 s, or 50 times what
// the last count took if that's longer, keeping counts to about 2% of the time (task 7.3): 27 ms at 800x600 and 0.41 s at
// 4000x3000 in Chrome 158. A pass's end counts, and so do new rounding tables, at once.
const COUNT_EVERY_MS = 2000;
const count_every = () => Math.max(COUNT_EVERY_MS, count_cost * 50);

// A pass's sweeps, each over the whole canvas from the top, painting the pixels its test picks (D23). Top to bottom is
// one sweep. Exact first sweeps first for the pixels whose goal color is one of your shades in all three channels.
// Worst first sweeps 8 times, from the pixels furthest from the goal, each a band of 32 levels of distance.
const exactable = (gr, gg, gb, [red, green, blue]) => red[gr] === gr && green[gg] === gg && blue[gb] === gb;
const band = (data, i, gr, gg, gb) => Math.min(7, Math.floor(Math.sqrt(((data[i] - gr) ** 2 + (data[i + 1] - gg) ** 2 + (data[i + 2] - gb) ** 2) / 3) / 32));
const SWEEPS = {
	top: [() => true],
	exact: [(data, i, gr, gg, gb, tables) => exactable(gr, gg, gb, tables), (data, i, gr, gg, gb, tables) => !exactable(gr, gg, gb, tables)],
	worst: [7, 6, 5, 4, 3, 2, 1, 0].map((level) => (data, i, gr, gg, gb) => band(data, i, gr, gg, gb) === level),
};

// Why auto copy should hold off right now, or "" to carry on.
function waiting_reason(now) {
	if (!goal_ready()) return "Waiting for the goal image."; // task 7.8: the seed's goal isn't drawn yet
	if (disconnected()) return "Waiting for the connection.";
	if (busy() || selection || textbox) return "Waiting while you draw or select.";
	if (sweep && !together()) return "Waiting while you hold M.";
	if (now - auto.moved_at < HOLD_OFF_SECONDS * 1000) return "Waiting a moment after your change.";
	return "";
}

function auto_tick() {
	try {
		const now = performance.now();
		const elapsed = Math.min((now - auto.last_tick) / 1000, 60); // a background tab may only tick once a minute
		auto.last_tick = now;
		if (current_history_node !== auto.seen_node || history_changes !== auto.seen_changes) {
			// An undo, a redo, a trap or your own stroke: give Ctrl+Z room to walk back past auto copy.
			auto.seen_node = current_history_node;
			auto.seen_changes = history_changes;
			auto.moved_at = now;
			scores.valid = false;
		}
		if (main_canvas.width !== scores.width || main_canvas.height !== scores.height) scores.valid = false;
		if (!busy()) catch_up(auto);
		// A save or a send found the reads blocked since the last tick: stop before painting or spending Overclock.
		if (blocked_once) throw new Error(tainted_message());
		auto.waiting = waiting_reason(now);
		if (auto.waiting) return update_panel();
		history_node_to_cancel_to = null; // see settle()
		if (!scores.valid || now - scores.synced_at >= RESYNC_EVERY_MS) resync(now);
		// A late tick, in a tab Chrome wakes once a minute, takes in what other tabs spent before it spends its minute, and
		// writes what it spent at once. Two tabs woken together then spend the same seconds for one wake at most, not two.
		const late = elapsed > 2;
		if (late) overclock_save();
		const banked = overclock_banked();
		const boosted = Math.min(elapsed, banked); // a long tick gets double speed only for the seconds still banked
		if (boosted > 0) {
			const from_fillers = overclock_spend(boosted);
			// The fillers just ran out, and they don't come back: keep that, even if the tab closes now. The bank's seconds
			// reach the record at the next merge, a second at most.
			if (late || (elapsed >= banked && from_fillers > 0)) overclock_save();
		}
		fill_allowance(allowance, speed() * (elapsed > 0 ? 1 + boosted / elapsed : 1), elapsed, elapsed);
		const tables = rounding_tables(), goal = goal_pixels(), formula = scoring_formula();
		const width = Math.min(main_canvas.width, goal.width), height = Math.min(main_canvas.height, goal.height);
		// An order you picked, or one that arrived, starts the pass again in that order. In exact first so do new shades,
		// which change the pixels it can make exactly right; shade sets aren't nested.
		const order = pass_order(), shades = shade_counts().join();
		if (order !== auto.order || (order === "exact" && shades !== auto.shades)) Object.assign(auto, { order, sweep: 0, x: 0, y: 0 });
		auto.shades = shades;
		// Counted from here, after any rescore above, so a late tick in a throttled tab still gets its time to paint.
		const deadline = performance.now() + (elapsed > 1 ? 100 : 8);
		let budget = Math.floor(allowance.tokens), painted = 0, hits = 0, finished = false, pass_over = false;
		let sweeps = SWEEPS[auto.order] ?? SWEEPS.top;
		last_write = null;
		while (budget > 0 && performance.now() < deadline) {
			if (auto.y >= height) {
				auto.y = auto.x = 0;
				if (++auto.sweep < sweeps.length) continue; // the pass's next sweep
				// End of a pass. The next one paints the pixels missed, and pixels changed behind the scan by traps, undo or
				// your own strokes.
				auto.sweep = 0;
				auto.left = count_left();
				auto.counted_at = now;
				hits = 0; // counted in already
				if (auto.left === 0) {
					finished = true;
					break;
				}
				if (!loop_on()) {
					pass_over = true;
					break;
				}
				auto.pass++;
				auto.order = pass_order();
				sweeps = SWEEPS[auto.order];
				continue;
			}
			const top = auto.y - auto.y % STRIP, rows = Math.min(STRIP, height - top); // the strip count_left() reads
			const canvas = main_ctx.getImageData(0, top, width, rows).data;
			const picks = sweeps[auto.sweep];
			while (budget > 0 && auto.y < top + rows) {
				const row = (auto.y - top) * width, goal_row = auto.y * goal.width;
				for (; auto.x < width && budget > 0; auto.x++) {
					const i = (row + auto.x) * 4, at = (goal_row + auto.x) * 4;
					const gr = goal.data[at], gg = goal.data[at + 1], gb = goal.data[at + 2];
					if (settled(canvas, i, gr, gg, gb, tables) || !picks(canvas, i, gr, gg, gb, tables)) continue;
					const [r, g, b] = attempt(gr, gg, gb, tables, auto_random, miss_stats.auto);
					scores.sum += pixel_score(formula, r - gr, g - gg, b - gb) - pixel_score(formula, canvas[i] - gr, canvas[i + 1] - gg, canvas[i + 2] - gb);
					one_pixel.data.set([r, g, b, 255]);
					main_ctx.putImageData(one_pixel, auto.x, auto.y);
					last_write = { x: auto.x, y: auto.y, r, g, b };
					if (lands(r, g, b, gr, gg, gb, tables)) hits++;
					painted++;
					budget--;
				}
				if (auto.x >= width) {
					auto.x = 0;
					auto.y++;
				}
			}
		}
		check_read_back(); // the last pixel this tick wrote should read back as written
		if (reads_blocked) throw new Error(BLOCKED);
		allowance.tokens -= painted;
		if (painted) {
			if (auto.node && now - auto.node_started > STEP_SECONDS * 1000) {
				save_snapshot(auto); // finish the old step before starting the next
				auto.node = null;
			}
			const node = auto.node;
			commit(auto, "Auto Copy Goal");
			// A new step's minute starts where its first tick's time did, so a long gap (a throttled tab) can't stretch it to two.
			if (auto.node !== node) auto.node_started = now - elapsed * 1000;
			auto.seen_node = current_history_node; // our own step isn't a change to wait for
			auto.left = Math.max(0, auto.left - hits);
		}
		if (finished) return finish_auto();
		if (pass_over) return end_pass();
		if (now - auto.counted_at >= count_every() || auto.counted_at < tables_changed_at) {
			auto.left = count_left();
			auto.counted_at = now;
		}
		update_panel();
	} catch (error) {
		console.error("Auto copy stopped", error);
		pause_auto(`Stopped: ${error.message}`);
	}
}

// Starts a run, resumes a paused one, or after a pass that ended without Loop starts the next pass at the top. A run
// Loop starts again waits 3 s first, as auto copy does after any change it didn't make, so Ctrl+Z can still walk back
// past the trap that reopened pixels.
function start_auto(by_loop = false) {
	if (auto?.running) return;
	if (canvas_tainted()) return update_panel(tainted_message()); // probes, for reads blocked or allowed since the last ask
	let left;
	try {
		left = count_left();
	} catch (error) {
		return update_panel(`Can't start: ${error.message}`);
	}
	const pass_start = { x: 0, y: 0, sweep: 0, order: pass_order(), shades: shade_counts().join(), pass_ended: false };
	if (!auto || auto.done) auto = { ...new_progress(1000, SEND_EVERY_MS), ...pass_start, pass: 1, node_started: 0, done: false, waiting: "" };
	else if (auto.pass_ended) Object.assign(auto, pass_start, { pass: auto.pass + 1 });
	auto.left = left;
	auto.counted_at = performance.now();
	auto.seen_node = current_history_node;
	auto.seen_changes = history_changes;
	auto.moved_at = by_loop ? performance.now() : -Infinity;
	scores.valid = false; // the canvas may have changed while auto copy was stopped
	panel.message = "";
	if (left === 0) return finish_auto();
	auto.running = true;
	auto.last_tick = performance.now();
	auto.timer = setInterval(auto_tick, 50);
	overclock_save(); // takes this page's run lock, so other tabs stop filling the bank from their next merge
	update_panel();
}

function pause_auto(message) {
	if (!auto) return;
	clearInterval(auto.timer);
	auto.running = false;
	auto.waiting = "";
	catch_up(auto, true); // its merge lets go of the run lock and moves the fill note on to now, so the bank fills from now
	update_panel(message);
}

function finish_auto() {
	pause_auto();
	auto.done = true;
	auto.left = 0;
	auto.game_state = game_state(); // with Loop on, the game reopening pixels after this starts a new run
	auto.left_at_count = 0;
	update_panel();
}

// What the game changes that can reopen pixels: your shades, the canvas's size, and how many traps and DeathLink resets
// have changed the canvas.
const game_state = () => `${shade_counts().join()}/${main_canvas.width}x${main_canvas.height}/${game_changed()}`;

// A pass ended with pixels still off, and Loop isn't on: the run stops there, and Start begins the next pass.
function end_pass() {
	pause_auto();
	auto.pass_ended = true;
	update_panel();
}

function toggle_auto() {
	if (!panel) open_panel();
	if (auto?.running) pause_auto();
	else start_auto();
}

function minutes_text(seconds) {
	const minutes = Math.round(seconds / 60);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `about ${minutes} min`;
	return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function seconds_text(seconds) {
	if (seconds > 0 && seconds < 1) return "under 1 s";
	return seconds < 120 ? `${Math.floor(seconds)} s` : minutes_text(seconds).replace("about ", "");
}

// Seconds auto copy needs for `tries` at `pixels` a second: with misses, a pixel takes more than one. Banked Overclock
// doubles the first stretch, and the bank doesn't fill while auto copy runs (D25). The same whether auto copy runs, waits
// or is paused, but for what the bank fills while it's paused.
function time_left(tries, pixels, banked) {
	if (tries <= 2 * pixels * banked) return tries / (2 * pixels);
	return banked + (tries - 2 * pixels * banked) / pixels;
}

function open_panel() {
	const $w = $Window({ title: "Auto Copy", toolWindow: true, resizable: false, maximizeButton: false, minimizeButton: false });
	$w.addClass("auto-copy-panel");
	const make = (tag, properties = {}, style = {}) => {
		const element = Object.assign(document.createElement(tag), properties);
		Object.assign(element.style, style);
		return element;
	};
	const state = make("div", {}, { fontWeight: "bold", whiteSpace: "normal" });
	const progress = make("div", {}, { margin: "2px 0 10px", whiteSpace: "normal" });
	// Buttons rather than a slider: os-gui hands focus back to a window's last control after every click in it,
	// and Paint ignores its shortcuts (Ctrl+Z included) while an input has focus. A focused button blocks nothing.
	// They come before the speed text, so a longer number can't push them out from under the mouse.
	const speed_row = make("div", {}, { display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" });
	const slower = make("button", { textContent: "−", title: "Slower" }, { minWidth: "26px" });
	const faster = make("button", { textContent: "+", title: "Faster" }, { minWidth: "26px" });
	const speed_text = make("span", {}, { marginLeft: "4px", whiteSpace: "nowrap" });
	const tier_text = make("div", {}, { margin: "0 0 4px", whiteSpace: "normal" });
	const misses_text = make("div", {}, { margin: "0 0 4px", whiteSpace: "normal" });
	const overclock_text = make("div", {}, { margin: "0 0 10px", whiteSpace: "normal" });
	// Switches as buttons too, for the same reason: Loop, and the pass order once a second copy of D23 gives one.
	const switch_row = make("div", {}, { display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "8px" });
	const loop_button = make("button", { title: "Auto Copy Loop starts each next pass by itself" });
	const order_button = make("button", { title: "The order auto copy paints a pass in" });
	const button = make("button", {}, { minWidth: "90px" });
	speed_row.append(slower, faster, speed_text);
	switch_row.append(loop_button, order_button);
	$w.$content.css({ padding: "8px 10px 10px", width: 250 }).append(state, progress, speed_row, tier_text, misses_text, overclock_text, switch_row, button);
	slower.addEventListener("click", () => change_tier(-1));
	faster.addEventListener("click", () => change_tier(1));
	loop_button.addEventListener("click", () => set_loop(!loop_switch()));
	order_button.addEventListener("click", () => {
		const unlocked = Object.keys(ORDER_NAMES).filter(order_unlocked);
		choose_order(unlocked[(unlocked.indexOf(pass_order()) + 1) % unlocked.length]);
	});
	button.addEventListener("click", toggle_auto);
	// While stopped, keep the count honest: a trap, a canvas size item or a new goal changes it after "Done". With Loop
	// on, a run that finished starts again when the game reopens pixels: the count rose since the last one, and a color
	// or canvas item, a trap or a DeathLink reset came in between. Your own changes don't, so a canvas you clear or paint
	// by hand stays as you left it until then, and a run you paused stays paused. A count that costs more than this
	// timer's 2 s allows waits its turn, as auto copy's own do (count_every()), unless new rounding tables came in.
	const recount = setInterval(() => {
		const finished_with_loop = !!auto?.done && has_loop() && loop_switch();
		if (!auto || auto.running || (document.hidden && !finished_with_loop)) return update_panel();
		try {
			rounding_tables();
			if (count_every() > COUNT_EVERY_MS && performance.now() - auto.counted_at < count_every() && auto.counted_at >= tables_changed_at) return update_panel();
			const left = count_left();
			auto.counted_at = performance.now();
			if (left !== auto.left) auto.left = left;
		} catch { } // rounding_tables() can throw; Start shows why
		if (auto.done) {
			const state = game_state();
			if (finished_with_loop && state !== auto.game_state && auto.left > auto.left_at_count) return start_auto(true);
			auto.game_state = state;
			auto.left_at_count = auto.left;
		}
		update_panel();
	}, 2000);
	$w.onClosed(() => {
		clearInterval(recount);
		pause_auto();
		auto = null;
		panel = null;
		// Closing a window makes os-gui focus the next one. If that's the Text Client's chat box, M would type into it.
		setTimeout(() => {
			const focused = document.activeElement;
			if (takes_text(focused) && focused.closest(".window")) focused.blur();
		});
	});
	panel = { $w, state, progress, speed_text, tier_text, misses_text, overclock_text, switch_row, loop_button, order_button, slower, faster, button, message: "" };
	const area = $canvas_area[0].getBoundingClientRect();
	$w.css({ left: Math.max(0, area.right - $w.outerWidth() - 24), top: area.top + 12 });
	update_panel();
}

function update_panel(message) {
	if (!panel) return;
	if (message !== undefined) panel.message = message;
	const { state, progress, speed_text, tier_text, misses_text, overclock_text, switch_row, loop_button, order_button, slower, faster, button } = panel;
	const pixels = speed(), top = top_tier(), banked = overclock_banked();
	const copying = !!auto?.running && !auto.waiting;
	// Overclocked while auto copy copies with seconds banked. The bank doesn't fill while it runs, so once they run out the
	// line stays at the plain speed.
	const doubled = copying && banked > 0, shown = pixels * (doubled ? 2 : 1);
	speed_text.textContent = `${shown.toLocaleString()} ${shown === 1 ? "pixel" : "pixels"} a second${doubled ? ", Overclocked" : ""}`;
	tier_text.textContent = tier() < top ? `Your top speed is ${(2 ** top).toLocaleString()} a second.`
		: top < (slotData.auto_copy_speed_items ?? 10) ? "Your top speed. Each Progressive Auto Copy Speed doubles it."
		: "The top speed.";
	const size = bank_size(), per_minute = fill_per_second() * 60;
	overclock_text.textContent = [
		banked > 0 ? `Overclock: ${seconds_text(banked)} of double speed banked.` : "",
		size > 0 ? `The bank holds ${seconds_text(bank_banked())} of ${seconds_text(size)}${per_minute > 0 ? ` and fills ${seconds_text(per_minute)} a minute while auto copy isn't running` : ""}.` : "",
		together() ? "M copies alongside auto copy, from its own pixels a second." : "",
	].filter(Boolean).join(" ");
	slower.disabled = tier() === 0;
	faster.disabled = tier() >= top;
	const miss = miss_chance(), spread = margin();
	misses_text.textContent = before_misses() ? "" : [
		miss === 0 ? "Never misses."
			: spread === 0 ? `Misses ${miss}% of pixels, but at margin 0 a miss paints the right shade anyway.`
			: `Misses ${miss}% of pixels: a miss paints a shade within ${spread} of the right one.`,
		read_noise ? "Your browser reads colors back a step off, so a pixel within 1 of your best shade counts as done." : "",
	].filter(Boolean).join(" ");
	const order = pass_order(), orders = Object.keys(ORDER_NAMES).filter(order_unlocked);
	// Shown or hidden through display, since a stylesheet's display for buttons would win over the hidden attribute.
	loop_button.style.display = has_loop() ? "" : "none";
	loop_button.textContent = `Loop: ${loop_switch() ? "on" : "off"}`;
	order_button.style.display = orders.length > 1 ? "" : "none";
	order_button.textContent = `Order: ${ORDER_NAMES[order]}`;
	switch_row.style.display = has_loop() || orders.length > 1 ? "flex" : "none";
	const left_text = `${(auto?.left ?? 0).toLocaleString()} ${auto?.left === 1 ? "pixel" : "pixels"}`;
	state.textContent = panel.message
		|| (reads_blocked ? BLOCKED
			: !auto ? "Ready."
			: auto.running ? auto.waiting || (auto.pass > 1 ? `Copying, pass ${auto.pass}.` : "Copying.")
			: auto.done && auto.left === 0 ? "Done: your canvas matches the goal."
			: auto.done ? "Ready."
			: auto.pass_ended ? `Pass ${auto.pass} done: ${left_text} still off.`
			: "Paused.");
	progress.textContent = !auto ? "Copies the goal into your canvas, a row at a time."
		: auto.left === 0 ? "Nothing left to copy on the canvas you've unlocked."
		: `${left_text} left, ${minutes_text(time_left(auto.left * tries_per_pixel, pixels, banked))}.`;
	button.textContent = auto?.running ? "Pause" : !auto || auto.done ? "Start" : auto.pass_ended ? `Start pass ${auto.pass + 1}` : "Resume";
}

// Extras > Auto Copy: opens the panel, or brings it to the front.
function show_auto_copy_panel() {
	if (!panel) open_panel();
	else panel.$w.bringToFront?.();
}

// --- Keys and pointer ---

// Russian, Greek and other non-Latin layouts type a different letter on the M key, so go by key position there.
function key_name(event) {
	const key = event.key || "";
	if (/^\p{L}$/u.test(key) && !/\p{Script=Latin}/u.test(key)) return event.code === `Key${KEY.toUpperCase()}` ? KEY : "";
	return key.toLowerCase();
}

// Leave M alone while typing, in dialogs (M picks "Cm" in Attributes), with a menu open and in View Bitmap.
// Buttons, checkboxes and sliders don't take letters, so they don't block it.
function ignore_key(event) {
	if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return true;
	const target = event.target;
	if (takes_text(target)) return true;
	if (target instanceof Element && target.closest(".dialog-window, .menu-popup")) return true;
	return !!document.querySelector(".menu-button.active, .bitmap-view");
}

function on_key_down(event) {
	if (!enabled || key_name(event) !== KEY || ignore_key(event)) return;
	event.preventDefault(); // Paint's own shortcut handler skips prevented keys
	if (event.repeat) return;
	if (event.shiftKey) toggle_auto();
	else start_sweep(event.code || KEY);
}

function on_key_up(event) {
	if (sweep && !sweep.released && (event.code || key_name(event)) === sweep.code) end_sweep(false);
}

function on_pointer_move(event) {
	last_client = { clientX: event.clientX, clientY: event.clientY };
	if (sweep && !sweep.released) follow_cursor();
}

function on_pointer_down(event) {
	last_client = { clientX: event.clientX, clientY: event.clientY };
	end_sweep(true); // a click starts a Paint gesture; stop copying so the two don't fight
	// Paint takes the stroke's cancel point next, so put auto copy's latest pixels into its step first: Esc mid-stroke
	// then rolls back only the stroke. Not while a gesture is already on, where a second finger would save the tool's
	// unfinished pixels into auto copy's step.
	if (auto?.running && !busy()) save_snapshot(auto);
}

function on_pointer_out(event) {
	if (event.relatedTarget) return;
	last_client = null; // left the window
	if (sweep) sweep.last = null;
}

// The old Copy Goal bookmarklet looks for window.jspaintCopyGoal and toggles it rather than loading a second copy.
function set_enabled(on) {
	if (!on) {
		end_sweep(true);
		panel?.$w.close();
	}
	enabled = on;
	show_status(on ? "M copies a pixel from the goal, Shift+M starts auto copy." : "M and auto copy off. Run the bookmark again to turn them back on.");
}

function init() {
	addEventListener("pointermove", on_pointer_move, true);
	addEventListener("pointerdown", on_pointer_down, true);
	addEventListener("pointerout", on_pointer_out, true);
	addEventListener("keydown", on_key_down, true);
	addEventListener("keyup", on_key_up, true);
	addEventListener("blur", () => end_sweep(true));
	// As the page closes or goes into the back-forward cache, auto copy stops running here: the merge lets go of the run
	// lock and moves the fill note on, so the game's other tabs fill the bank from now. It fills the bank only while the
	// note says no run may go on: the locks it last read may be a minute old, in a tab Chrome wakes once a minute, and a
	// run started since has left word in the note. Back from the cache, the next merge takes the lock again while auto
	// copy runs.
	addEventListener("pagehide", () => {
		leaving = true;
		if (overclock.session !== null) overclock_merge(can_fill() && !fill_note(Date.now()).running);
	});
	addEventListener("pageshow", () => { leaving = false; });
	setInterval(fill_bank, 1000); // the bank fills while auto copy runs in no tab of the game (D25)
	$canvas_area[0].addEventListener("scroll", () => { if (sweep && !sweep.released && last_client) follow_cursor(); }); // the canvas can slide under a still cursor
	$G.on("resize magnification-changed", () => { if (sweep) sweep.last = null; }); // pixel positions jump; don't draw a line across
	// A history event auto copy didn't cause makes the running total stale at once, so nothing sends it before auto_tick()
	// sees the count and holds off.
	$G.on("history-update", () => {
		if (own_history_change) return;
		history_changes++;
		scores.valid = false;
	});
	$G.on("save-goal", () => { scores.valid = false; }); // archipelago.js's handler has dropped the goal as read
	probe_reads();
	window.jspaintCopyGoal = {
		get enabled() { return enabled; },
		toggle() { set_enabled(!enabled); },
	};
	// For tests and the console: the running total and the speed as auto copy sees them.
	window.paint_hard_auto_copy = {
		similarity: () => (scores.valid && auto?.running ? running_similarity() : null),
		speed,
		tier,
		top_tier,
		overclock_banked,
		overclock_bank: () => {
			const filler = filler_banked(); // first, as it loads a new session's record
			return { level: bank_banked(), size: bank_size(), per_second: fill_per_second(), filler };
		},
		// This page's own totals, the other pages' as last added up, the fill note it works from, and when it last merged.
		overclock_record: () => {
			filler_banked();
			return { page: PAGE, mine: { ...overclock.mine }, others: { ...overclock.others }, fill: { ...overclock.fill }, merged_at: overclock.merged_at };
		},
		rounding_tables,
		running: () => !!auto?.running,
		// Misses and passes (D7, D23). seed_random gives auto copy and M seeded draws, so a run's misses repeat.
		seed_random: (seed) => {
			auto_random = seeded(seed);
			m_random = seeded(seed + 1);
			for (const stats of Object.values(miss_stats)) Object.assign(stats, { rolled: 0, missed: 0 });
		},
		miss_chance,
		miss_margin: margin,
		miss_stats: () => ({ auto: { ...miss_stats.auto }, m: { ...miss_stats.m } }),
		loop: loop_on,
		set_loop,
		order: pass_order,
		choose_order,
		pass: () => ({ number: auto?.pass ?? 0, running: !!auto?.running, ended: !!auto?.pass_ended, done: !!auto?.done, sweep: auto?.sweep ?? 0 }),
		pixels_left: count_left,
		// When the last counts of the pixels left and snapshots of a step ran, and how long the next of each waits (task 7.3).
		read_log: () => ({ counts: [...read_log.counts], snapshots: read_log.snapshots.map((entry) => ({ ...entry })), count_every: count_every(), snapshot_every: { auto: auto?.snapshot_every ?? null, m: sweep?.snapshot_every ?? null } }),
		read_noise: () => (reads_blocked ? "blocked" : read_noise),
	};
}

settle_page();
// This module loads before app-state.js and app.js have made the canvas and windows, so wait for the page.
if (document.readyState === "complete") init();
else addEventListener("load", init);

// Whether this browser blocks canvas reads now, as the load's probe, a later one (canvas_tainted()) or a read back
// found. Asked before the page has loaded, it probes then. The player can allow canvas reads while the page is open, as
// Firefox's canvas permission does without a reload, so while reads count as blocked each ask probes again, and a probe
// that reads clean or a step off ends the block and fires canvas-reads-allowed: the goal as read while reads were
// blocked goes (archipelago.js), and the page says once that a reload sends checks and saves again (sessions.js).
function reads_are_blocked() {
	probe_reads();
	if (reads_blocked) {
		const off = probe_off();
		if (off <= 1) {
			reads_blocked = false;
			if (off === 1 && !read_noise) read_noise = "load";
			$G.triggerHandler("canvas-reads-allowed");
		}
	}
	return reads_blocked;
}

// Whether canvas reads count as blocked now, or did at any point since the page loaded. While the page counts as clean,
// each ask probes too, so reads blocked with the page open, as a canvas permission taken back or a blocking extension
// switched on blocks them, count from the next ask; while it counts as tainted, it probes as reads_are_blocked() does.
// A blocked read gives the browser's own answer, random bytes under Firefox's resistFingerprinting, and wherever the
// page reads the canvas and draws the read back, as an undo and an Undo Trap do, that answer goes onto the canvas and
// stays there once reads are allowed. So archipelago.js asks this before a send, sessions.js before a save or an Export
// Session, and auto copy and M before they start, and each waits for a reload, which restores the session's last save.
function canvas_tainted() {
	if (!blocked_once && probe_off() > 1) block_reads();
	return reads_are_blocked() || blocked_once;
}
watch_reads(canvas_tainted);

// Whether auto copy or M has painted pixels since it last asked Paint to save, which catch_up() does at most every 5 s.
// A session counts them as a change when it saves as the page goes, as it ends, as the tab leaves it for another game,
// and before an import holds its saves (sessions.js).
function copies_unsaved() {
	return !!(auto?.unsaved || sweep?.unsaved);
}

export { canvas_tainted, copies_unsaved, reads_are_blocked, show_auto_copy_panel };
