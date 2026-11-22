// Auto copy and the M keys: the Copy Goal bookmarklet, built into Pain-T (D5, D6, D9 and D10 of the fork's
// ROADMAP.md).
// Point at a pixel of the goal image or of your canvas and press M: the goal's color, rounded to your color depth the
// way Pick Color rounds it, goes into that pixel of your canvas. Hold M and move to paint the goal in as you go.
// Shift+M starts or pauses auto copy, which works through the canvas by itself, and Extras > Auto Copy opens its panel.
// Its top speed is 1 pixel a second, doubled by each Progressive Auto Copy Speed; the panel picks any speed up to it,
// and M draws from the same allowance. Banked Overclock doubles auto copy's speed while it runs. Ctrl+Z undoes each
// press of M in one step, and auto copy a minute at a time.

import { calculate_logic_similarity, calculate_similarity, deselect, undoable, update_helper_layer } from "./functions.js";
import { $G, get_icon_for_tool, get_rgba_from_color } from "./helpers.js";
import { legalizeColor } from "./$ColorBox.js";
import { final_height, final_width, rungs, send, session_name, slotData } from "./archipelago.js";
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
// Browsers that blur canvas reads against fingerprinting (Brave, Firefox's strict mode) can read a color back a step off,
// so a channel within 1 of the target counts as matching. Alpha has to be exact.
const close = (value, target) => value - target <= 1 && target - value <= 1;
const matches = (data, i, red, green, blue) => close(data[i], red) && close(data[i + 1], green) && close(data[i + 2], blue) && data[i + 3] === 255;
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
// itself while you're connected, overclock_fill_speed_step seconds a minute for each Progressive Overclock Fill Speed, up
// to overclock_bank_size_step seconds for each Progressive Overclock Bank Size. Each Overclock filler adds
// overclock_seconds on top, past the bank's size if need be. The self-filled seconds are spent first, since they come
// back. Both stay with this browser; task 7.11 moves the seconds spent to the slot's data storage, and the bank stays
// here.
// Every tab of a game in this browser shares one record, kept in pieces that only one page writes. Each page writes its
// own running totals under its own key: the seconds it took from the fillers, and from the bank. At each merge, once a
// second or once a minute in a tab Chrome throttles, every tab adds up all the pages' totals, so seconds spent in one tab
// don't come back in another or after a reload, and no tab can write over another's spending. Two hidden tabs merging
// into one shared total in the same millisecond did that (D10). The bank's fill is one shared note of how many seconds
// have filled it in all, counted up to when. A connected tab moves that note on by the time since, so two tabs don't fill
// it twice. Every note is whole, so a tab that moves an older one on loses a second of fill at most, and adds none.
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
	others: { spent: 0, used: 0 }, // every other page's, added up at the last merge
	fill: { filled: 0, at: 0 }, // the newest note of the bank's fill: seconds filled in all, counted up to `at`
	fill_from: Date.now(),
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
function read(key, storage = localStorage) {
	try {
		const value = storage.getItem(key);
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

// Every other page's totals for the game, added up.
function others_totals() {
	const prefix = `${overclock_key("page")}:`, own = page_key(), sum = { spent: 0, used: 0 };
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(prefix) || key === own) continue;
			const totals = read(key);
			sum.spent += Number(totals?.spent) || 0;
			sum.used += Number(totals?.used) || 0;
		}
	} catch { }
	return sum;
}

// The fill note to count from: the one stored. This page's own last note, from this load or from sessionStorage after a
// reload, counts only while storage refuses its writes or holds no note, since after a clock set back the page's older
// note would outrank another tab's newer one. Then the later of the two goes first, and a note from after now, written
// before the clock was set back, goes last.
function fill_note(now) {
	const key = overclock_key("fill"), stored = read(key);
	const own = refused.has(key) || !whole_note(stored) ? kept.get(key) ?? read(key, sessionStorage) : null;
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
	if (overclock.session !== null) overclock_merge(false); // what was spent in the last game stays with it
	overclock.session = session;
	if (auto) auto.trickle = []; // the other pages' spending is another game's now
	// This page's own totals for the game, from this load or an earlier load of this tab, or from the closed page whose id
	// it took. Only this page writes them, and they only grow, so the largest is the latest.
	const totals = [kept.get(page_key()), read(page_key()), read(page_key(), sessionStorage)].filter(whole_totals);
	overclock.mine = { spent: Math.max(0, ...totals.map((t) => t.spent)), used: Math.max(0, ...totals.map((t) => t.used)) };
	overclock.fill_from = Date.now(); // the bank fills while a tab is open, not while none is
	overclock_merge(false);
}

// Adds up the other pages' totals, moves the fill note on when this tab fills the bank, and writes this page's totals
// if they changed.
function overclock_merge(filling) {
	const now = Date.now();
	overclock.others = others_totals();
	let note = fill_note(now);
	if (filling) {
		if (overclock.fill_from > now) overclock.fill_from = now; // the clock was set back
		// Never counted from later than now, and at most a minute and a half back, so a clock set forward or a computer
		// waking from sleep fills that much at most.
		const from = Math.min(now, Math.max(note.at, overclock.fill_from, now - 90000));
		const full = overclock.others.used + overclock.mine.used + bank_size();
		note = { filled: Math.max(note.filled, Math.min(full, note.filled + fill_per_second() * (now - from) / 1000)), at: now };
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

// Once a second: the merge fills the bank by real time since it was last counted, so a throttled background tab fills
// as fast as a shown one, and time spent disconnected doesn't count.
function fill_bank() {
	overclock_session();
	if (!can_fill()) overclock.fill_from = Date.now();
	overclock_save();
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

// With the fillers spent, whether auto copy runs on what the bank fills: it ran the bank dry in the last 5 s, so it
// doubles only a share of each second. A fill that lands each second, or one that keeps ahead of auto copy for a moment,
// doesn't flip it.
const DRY_MS = 5000, TRICKLE_MS = 15000;
const trickling = (now = performance.now()) => !!auto && now - auto.dry_at < DRY_MS && filler_banked() === 0 && can_fill();
// The share of each second the bank's fill doubles for this tab. Alone, a tab gets the whole fill, up to every second.
const whole_share = () => Math.min(fill_per_second(), 1);
// While another page spends from the bank too, the share is this tab's own over the last 15 s, once it has run on the
// fill for 4.5 s of them. Null while no other page's bank seconds moved in that time.
function measured_share() {
	const ticks = auto?.trickle ?? [];
	if (ticks.length < 2 || Math.abs(ticks.at(-1).others - ticks[0].others) <= 1e-6) return null;
	const seconds = ticks.reduce((sum, tick) => sum + tick.elapsed, 0);
	return seconds < 4.5 ? null : Math.min(1, ticks.reduce((sum, tick) => sum + tick.boosted, 0) / seconds);
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

// A pixel's score on the client's 0.5.0+ scale, exactly as calculate_similarity() works it out.
function pixel_score(dr, dg, db) {
	return 2 * (1 - Math.sqrt((dr ** 2 + dg ** 2 + db ** 2) / 3) / 255) - 1;
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
const views_shown = () => $sim.is(":visible") || $diff.is(":visible");

function show_similarity(similarity) {
	$status_similarity.text(similarity.toFixed(4) + "%/" + calculate_logic_similarity().toFixed(4) + "%");
}

// --- Where the pointer is ---

// The pixel of the canvas or goal image at a client point. Not clamped, so points past the edges stay outside.
function position_on(element, clientX, clientY) {
	const rect = element.getBoundingClientRect();
	if (!rect.width || !rect.height) return null;
	return {
		x: Math.floor((clientX - rect.left) / rect.width * element.width),
		y: Math.floor((clientY - rect.top) / rect.height * element.height),
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
// allowance has a pixel left, and keeps the running total up to date. Returns "same" when it already matches, "wait"
// when the allowance is empty, or "painted".
function copy_pixel({ x, y }, bucket, [red_of, green_of, blue_of]) {
	const [r, g, b] = goal_ctx.getImageData(x, y, 1, 1).data;
	const red = red_of[r], green = green_of[g], blue = blue_of[b];
	const pixel = main_ctx.getImageData(x, y, 1, 1);
	if (matches(pixel.data, 0, red, green, blue)) return "same";
	if (bucket.tokens < 1) return "wait";
	bucket.tokens -= 1;
	const [cr, cg, cb] = pixel.data;
	scores.sum += pixel_score(red - r, green - g, blue - b) - pixel_score(cr - r, cg - g, cb - b);
	pixel.data.set([red, green, blue, 255]);
	main_ctx.putImageData(pixel, x, y);
	return "painted";
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
// Paint keeps a full copy of the canvas in every undo step, autosaves 100 ms after the last change it hears about,
// and scores checks by comparing the whole goal with the canvas. That's too heavy to do for every pixel, so painting
// marks them as due and catch_up() does them on a timer, and right away when copying stops.

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
// would make it impossible to scroll or click. It only needs rebuilding when the name changes.
function save_snapshot(state) {
	if (!state.stale || current_history_node !== state.node) return;
	state.node.image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
	state.stale = false;
	state.snapshot_at = performance.now();
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
		$G.triggerHandler("session-update"); // Paint autosaves 100 ms after the last of these, so they can't come every tick
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

const new_progress = (snapshot_every, min_score_every) => ({ node: null, name: "", stale: false, unsaved: false, unscored: false, snapshot_at: 0, saved_at: 0, scored_at: 0, snapshot_every, score_every: min_score_every, min_score_every });

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
	if (busy()) return show_status("Let go of the mouse first.");
	if (sweep) end_sweep(true);
	// filled_at starts where the allowance last filled, so time nothing was copying still counts, up to a second.
	sweep = { ...new_progress(250, 500), code, last: null, pending: [], count: 0, first: null, seen: false, outside: false, skipped: 0, frame: 0, timer: 0, released: false, filled_at: (alongside() ? m_allowance : allowance).at };
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
	while (sweep.pending.length) {
		if (performance.now() >= deadline) {
			out_of_time = true;
			break;
		}
		const result = copy_pixel(sweep.pending[0], bucket, tables);
		if (result === "wait") break;
		const pixel = sweep.pending.shift();
		if (result === "painted") {
			changed++;
			sweep.first ??= pixel;
		}
	}
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
	const { count, first, seen, outside, skipped } = sweep;
	sweep = null;
	const limit = skipped ? ` M copies ${speed().toLocaleString()} ${speed() === 1 ? "pixel" : "pixels"} a second at your speed, so ${skipped.toLocaleString()} passed over were left.` : "";
	if (count === 1) show_status(`Copied ${first.x},${first.y} from the goal.${limit}`);
	else if (count > 1) show_status(`Copied ${count.toLocaleString()} pixels from the goal.${limit}`);
	else if (skipped) show_status(`Nothing copied yet.${limit}`);
	else if (outside) show_status(`That's past the edge of your canvas (${main_canvas.width}x${main_canvas.height}).`);
	else show_status(seen ? "Already matches the goal." : "Point at the goal image or your canvas, then press M.");
}

// --- Auto copy (Shift+M) ---
// Works through the canvas row by row and copies pixels that don't match yet, at the speed you pick.
// Pixels that already match cost nothing, so a nearly finished canvas goes quicker, but never faster than the speed.

let tables = null, tables_key = "", tables_for = null;
const one_pixel = new ImageData(1, 1);

// Pick Color's rounding as one lookup table per channel: legalizeColor()'s quantize() at each channel's shade count,
// rebuilt only when a Progressive Color Depth arrives. Four colors through legalizeColor() itself check that it still
// rounds that way. legalizeColor() rounds what a 1x1 canvas reads back, which Brave's farbling can put a step off the
// color written, so each is looked up at that read.
function rounding_tables() {
	const table = slotData.shade_counts ?? [2];
	const shades = ["Red", "Green", "Blue"].map((channel) => table[Math.min(count_of(`Progressive Color Depth (${channel})`), table.length - 1)]);
	const key = shades.join();
	if (key === tables_key && table === tables_for) return tables;
	const built = shades.map((count) => Uint8Array.from({ length: 256 }, (_, value) => quantize(value, count)));
	for (const rgb of [[12, 200, 77], [255, 128, 0], [90, 90, 250], [131, 7, 190]]) {
		const color = `rgb(${rgb})`, read = get_rgba_from_color(color);
		if (legalizeColor(color).match(/\d+/g).map(Number).some((value, channel) => value !== built[channel][read[channel]])) throw new Error("Pick Color's rounding has changed in this version of the game");
	}
	tables = built;
	tables_key = key;
	tables_for = table;
	return tables;
}

// How many pixels of the unlocked canvas don't match the goal yet, at your color depth.
function count_left() {
	const [red, green, blue] = rounding_tables();
	const width = Math.min(main_canvas.width, goal_canvas.width), height = Math.min(main_canvas.height, goal_canvas.height);
	const goal = goal_ctx.getImageData(0, 0, width, height).data, canvas = main_ctx.getImageData(0, 0, width, height).data;
	let left = 0;
	for (let i = 0; i < goal.length; i += 4) {
		if (!matches(canvas, i, red[goal[i]], green[goal[i + 1]], blue[goal[i + 2]])) left++;
	}
	return left;
}

// Why auto copy should hold off right now, or "" to carry on.
function waiting_reason(now) {
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
		auto.overclocked = boosted > 0;
		if (boosted > 0) {
			const from_fillers = overclock_spend(boosted);
			// The fillers just ran out, and they don't come back: keep that, even if the tab closes now. Not when only the
			// bank runs out, which happens every tick while it fills slower than auto copy spends it.
			if (late || (elapsed >= banked && from_fillers > 0)) overclock_save();
		}
		// For the panel's speed line: when this tab last ran out of banked seconds, and what it doubled of each tick since,
		// while it runs on the bank's fill. The ticks start with the one that ran the bank dry, so what it held before isn't
		// taken for the fill.
		if (boosted < elapsed) auto.dry_at = now;
		if (!trickling(now)) auto.trickle = [];
		else {
			auto.trickle.push({ at: now, elapsed, boosted, others: overclock.others.used });
			while (auto.trickle[0].at <= now - TRICKLE_MS) auto.trickle.shift();
		}
		fill_allowance(allowance, speed() * (elapsed > 0 ? 1 + boosted / elapsed : 1), elapsed, elapsed);
		const [red, green, blue] = rounding_tables();
		const width = Math.min(main_canvas.width, goal_canvas.width), height = Math.min(main_canvas.height, goal_canvas.height);
		// Counted from here, after any rescore above, so a late tick in a throttled tab still gets its time to paint.
		const deadline = performance.now() + (elapsed > 1 ? 100 : 8);
		let budget = Math.floor(allowance.tokens), painted = 0, finished = false;
		while (budget > 0 && performance.now() < deadline) {
			if (auto.y >= height) {
				// End of a pass. Another pass catches pixels changed behind the scan by traps, undo or your own strokes.
				auto.y = auto.x = 0;
				if (auto.pass_painted === 0 && count_left() === 0) {
					finished = true;
					break;
				}
				auto.pass_painted = 0;
				continue;
			}
			const top = auto.y, rows = Math.min(16, height - top);
			const goal = goal_ctx.getImageData(0, top, width, rows).data;
			const canvas = main_ctx.getImageData(0, top, width, rows).data;
			while (budget > 0 && auto.y < top + rows) {
				const row = (auto.y - top) * width;
				for (; auto.x < width && budget > 0; auto.x++) {
					const i = (row + auto.x) * 4;
					const gr = goal[i], gg = goal[i + 1], gb = goal[i + 2];
					const r = red[gr], g = green[gg], b = blue[gb];
					if (matches(canvas, i, r, g, b)) continue;
					scores.sum += pixel_score(r - gr, g - gg, b - gb) - pixel_score(canvas[i] - gr, canvas[i + 1] - gg, canvas[i + 2] - gb);
					one_pixel.data.set([r, g, b, 255]);
					main_ctx.putImageData(one_pixel, auto.x, auto.y);
					painted++;
					auto.pass_painted++;
					budget--;
				}
				if (auto.x >= width) {
					auto.x = 0;
					auto.y++;
				}
			}
		}
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
			auto.left = Math.max(0, auto.left - painted);
		}
		if (finished) return finish_auto();
		if (now - auto.counted_at > 2000) {
			auto.left = count_left();
			auto.counted_at = now;
		}
		update_panel();
	} catch (error) {
		console.error("Auto copy stopped", error);
		pause_auto(`Stopped: ${error.message}`);
	}
}

function start_auto() {
	if (auto?.running) return;
	let left;
	try {
		left = count_left();
	} catch (error) {
		return update_panel(`Can't start: ${error.message}`);
	}
	if (!auto || auto.done) auto = { ...new_progress(1000, SEND_EVERY_MS), x: 0, y: 0, pass_painted: 0, node_started: 0, done: false, waiting: "", overclocked: false, trickle: [], dry_at: -Infinity };
	auto.left = left;
	auto.counted_at = performance.now();
	auto.seen_node = current_history_node;
	auto.seen_changes = history_changes;
	auto.moved_at = -Infinity;
	scores.valid = false; // the canvas may have changed while auto copy was stopped
	panel.message = "";
	if (left === 0) return finish_auto();
	auto.running = true;
	auto.last_tick = performance.now();
	auto.timer = setInterval(auto_tick, 50);
	update_panel();
}

function pause_auto(message) {
	if (!auto) return;
	clearInterval(auto.timer);
	auto.running = false;
	auto.waiting = "";
	auto.overclocked = false;
	catch_up(auto, true);
	update_panel(message);
}

function finish_auto() {
	pause_auto();
	auto.done = true;
	auto.left = 0;
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

// Seconds auto copy needs for `left` pixels at `pixels` a second, where the bank's fill doubles `share` of each second.
// Banked Overclock doubles the first stretch, which lasts banked / (1 - share) seconds, since the bank keeps filling
// while it's spent; after that the fill still doubles its share of each second (D25). A share of every second never runs
// out. The same whether auto copy runs, waits or is paused, so the estimate doesn't jump.
function time_left(left, pixels, banked, share) {
	if (share >= 1) return left / (2 * pixels);
	const doubled = banked / (1 - share);
	if (left <= 2 * pixels * doubled) return left / (2 * pixels);
	return doubled + (left - 2 * pixels * doubled) / (pixels * (1 + share));
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
	const overclock_text = make("div", {}, { margin: "0 0 10px", whiteSpace: "normal" });
	const button = make("button", {}, { minWidth: "90px" });
	speed_row.append(slower, faster, speed_text);
	$w.$content.css({ padding: "8px 10px 10px", width: 250 }).append(state, progress, speed_row, tier_text, overclock_text, button);
	slower.addEventListener("click", () => change_tier(-1));
	faster.addEventListener("click", () => change_tier(1));
	button.addEventListener("click", toggle_auto);
	// While stopped, keep the count honest: a trap, a canvas size item or a new goal changes it after "Done".
	const recount = setInterval(() => {
		if (!auto || auto.running || document.hidden) return update_panel();
		try {
			const left = count_left();
			if (left !== auto.left) auto.left = left;
		} catch { } // rounding_tables() can throw; Start shows why
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
	panel = { $w, state, progress, speed_text, tier_text, overclock_text, slower, faster, button, message: "" };
	const area = $canvas_area[0].getBoundingClientRect();
	$w.css({ left: Math.max(0, area.right - $w.outerWidth() - 24), top: area.top + 12 });
	update_panel();
}

function update_panel(message) {
	if (!panel) return;
	if (message !== undefined) panel.message = message;
	const { state, progress, speed_text, tier_text, overclock_text, slower, faster, button } = panel;
	const pixels = speed(), top = top_tier(), banked = overclock_banked();
	const copying = !!auto?.running && !auto.waiting;
	// With the fillers spent, a tab that runs on what the bank fills doubles a share of each second. That shows as one
	// line with the share, which would otherwise read Overclocked for a moment each second as the fill lands.
	const trickle = copying && trickling(), measured = measured_share();
	const share = trickle ? measured ?? whole_share() : 0;
	const doubled = copying && (trickle ? share >= 0.99 : banked > 0);
	const value = pixels * (doubled ? 2 : 1 + share);
	const label = doubled ? ", Overclocked" : share > 0 ? ", partly Overclocked" : "";
	// A share measured beside another tab moves with each second's fill, by up to a fifteenth of the fill as one lands in
	// the 15 s or leaves them, so that line keeps its number until it's 5% off. Any other line shows at once.
	const last = panel.speed_shown;
	if (!last || last.label !== label || !trickle || measured === null || Math.abs(value - last.value) > 0.05 * last.value) panel.speed_shown = { value, label };
	const shown = panel.speed_shown.value;
	const number = Number.isInteger(shown) ? shown.toLocaleString() : shown < 9.95 ? shown.toFixed(1) : Math.round(shown).toLocaleString();
	speed_text.textContent = `${number} ${shown === 1 ? "pixel" : "pixels"} a second${panel.speed_shown.label}`;
	tier_text.textContent = tier() < top ? `Your top speed is ${(2 ** top).toLocaleString()} a second.`
		: top < (slotData.auto_copy_speed_items ?? 10) ? "Your top speed. Each Progressive Auto Copy Speed doubles it."
		: "The top speed.";
	const size = bank_size(), per_minute = fill_per_second() * 60;
	overclock_text.textContent = [
		banked > 0 ? `Overclock: ${seconds_text(banked)} of double speed banked.` : "",
		size > 0 ? `The bank holds ${seconds_text(bank_banked())} of ${seconds_text(size)}${per_minute > 0 ? ` and fills ${seconds_text(per_minute)} a minute` : ""}.` : "",
		together() ? "M copies alongside auto copy, from its own pixels a second." : "",
	].filter(Boolean).join(" ");
	slower.disabled = tier() === 0;
	faster.disabled = tier() >= top;
	state.textContent = panel.message
		|| (!auto ? "Ready."
			: auto.running ? auto.waiting || "Copying."
			: auto.done && auto.left === 0 ? "Done: your canvas matches the goal."
			: auto.done ? "Ready."
			: "Paused.");
	progress.textContent = !auto ? "Copies the goal into your canvas, a row at a time."
		: auto.left === 0 ? "Nothing left to copy on the canvas you've unlocked."
		: `${auto.left.toLocaleString()} ${auto.left === 1 ? "pixel" : "pixels"} left, ${minutes_text(time_left(auto.left, pixels, banked, size > 0 ? measured ?? whole_share() : 0))}.`;
	button.textContent = auto?.running ? "Pause" : !auto || auto.done ? "Start" : "Resume";
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
	addEventListener("pagehide", () => overclock_save());
	setInterval(fill_bank, 1000); // the bank fills whether auto copy runs or not (D25)
	$canvas_area[0].addEventListener("scroll", () => { if (sweep && !sweep.released && last_client) follow_cursor(); }); // the canvas can slide under a still cursor
	$G.on("resize magnification-changed", () => { if (sweep) sweep.last = null; }); // pixel positions jump; don't draw a line across
	// A history event auto copy didn't cause makes the running total stale at once, so nothing sends it before auto_tick()
	// sees the count and holds off.
	$G.on("history-update", () => {
		if (own_history_change) return;
		history_changes++;
		scores.valid = false;
	});
	$G.on("save-goal", () => { scores.valid = false; });
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
		// This page's own totals, the other pages' as last added up, and the fill note it works from.
		overclock_record: () => {
			filler_banked();
			return { page: PAGE, mine: { ...overclock.mine }, others: { ...overclock.others }, fill: { ...overclock.fill } };
		},
		rounding_tables,
		running: () => !!auto?.running,
	};
}

settle_page();
// This module loads before app-state.js and app.js have made the canvas and windows, so wait for the page.
if (document.readyState === "complete") init();
else addEventListener("load", init);

export { show_auto_copy_panel };
