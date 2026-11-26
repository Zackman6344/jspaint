// End-to-end test for Overclock across tabs (D10, D25): two tabs of one game in this browser, both hidden and both
// running auto copy, as when a player opens the client twice and switches away. Chrome wakes hidden tabs' timers
// together once a second, so both tabs merge their spending in the same millisecond. Every second either tab copied at
// double speed has to show in the record. With no bank in play, each of those seconds costs a filler second, and the
// pixels each tab painted tell how many it had. Then the two share a bank that fills only while neither runs auto copy,
// as the computer wakes from sleep too, and they wake once a minute. One of them loses its connection and then leaves
// the game while it runs auto copy, and then pauses while it waits for its connection. Then a third tab closes while it
// runs auto copy, a fourth opens as a duplicate of the first, a fifth in place of the second, and a sixth crashes while
// it runs auto copy. Last, a resting tab closes while another runs, and another as its game's last tab; two more tabs
// crash, one in a run the resting tab never saw and one after another run's stop; and two tabs without Web Locks fill
// the bank beside each other's runs.
// Usage: node test/paint-hard/two-tabs.e2e.mjs [--headful]. Set BROWSER_PATH if Chrome isn't in its default folder. It
// runs in Chromium only: its tabs are DevTools Protocol targets, and its checks lean on Chrome's wakes for hidden tabs.
import { BROWSER, cdp, check, chromium, finish, ORIGIN, overclock_id, sleep } from "./harness.mjs";

if (!chromium) {
	check(`two-tabs.e2e.mjs runs in Chrome, Edge or Brave, not ${BROWSER}`, false);
	await finish();
}

const FULL_COLOR = [];
for (const channel of ["Red", "Green", "Blue"]) for (let k = 0; k < 254; k++) FULL_COLOR.push(`Progressive Color Depth (${channel})`);
const SLOT = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 5, miss_margin_step: 1, version: "1.0.0", trap_blacklist: [] };
// Every Phase 4 accuracy copy (D7), so auto copy paints every pixel right, as before misses.
const ITEMS = ["Magnifier", "Brush", ...FULL_COLOR, ...Array(10).fill("Progressive Auto Copy Speed"), ...Array(9).fill("Progressive Auto Copy Accuracy"), ...Array(100).fill("Overclock")];
// D25's default bank: 5 copies of each, 600 s that fill 10 s a minute.
const BANK_SLOT = { ...SLOT, overclock_bank_size_step: 120, overclock_fill_speed_step: 2 };
const BANK_ITEMS = [...ITEMS, ...Array(5).fill("Progressive Overclock Bank Size"), ...Array(5).fill("Progressive Overclock Fill Speed")];
const TIER = 8, TIER_SPEED = 256; // 512 Overclocked: far under what a hidden tab's once-a-second tick can paint
const SECONDS = 12;
const json = (value) => JSON.stringify(value);

// Each tab notes its own page errors from the start, and gets its own evaluate.
const NOTE_ERRORS = `localStorage.setItem("pain-t-auto-copy-tier", "${TIER}");
window.tab_errors = [];
const note = (text) => { if (!/not connected/i.test(text)) window.tab_errors.push(text); };
addEventListener("error", (event) => note(String(event.message)));
addEventListener("unhandledrejection", (event) => note(String(event.reason?.message ?? event.reason)));
// A check can hold auto copy's once-a-second merge, to see what a late tick, a pause, a sleep, a leave, a close or a
// crash leaves by itself, and each tab notes when auto copy's tick came late, more than 2 s after the last. Each tab
// notes when each merge it runs starts, by its own clock: an idle tab joins a game at its first merge after set_up.
const set_interval = window.setInterval;
window.late_ticks = [];
window.fill_calls = [];
window.setInterval = function (callback, ...rest) {
	if (typeof callback === "function" && callback.name === "fill_bank") {
		window.merge_found = true;
		return set_interval.call(this, () => {
			if (window.hold_merges) return;
			window.fill_calls.push(Date.now());
			callback();
		}, ...rest);
	}
	if (typeof callback === "function" && callback.name === "auto_tick") {
		let last = performance.now();
		return set_interval.call(this, () => {
			const now = performance.now();
			if (now - last > 2000) window.late_ticks.push(Date.now());
			last = now;
			callback();
		}, ...rest);
	}
	return set_interval.call(this, callback, ...rest);
};`;
// `first` runs at the start of the tab's page, before Paint's own scripts.
async function open_hidden_tab(first = "") {
	const { targetId } = await cdp("Target.createTarget", { url: "about:blank", background: true });
	const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
	const evaluate = async (fn, ...args) => {
		const { result, exceptionDetails } = await cdp("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, sessionId);
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
		return result.value;
	};
	evaluate.target = targetId;
	await cdp("Runtime.enable", {}, sessionId);
	await cdp("Page.enable", {}, sessionId);
	await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `${NOTE_ERRORS}\n${first}` }, sessionId);
	await cdp("Page.navigate", { url: `${ORIGIN}/` }, sessionId);
	const ready = () => typeof goal_canvas !== "undefined" && main_canvas.width > 0 && !!window.paint_hard_auto_copy;
	for (let i = 0; i < 200 && !(await evaluate(ready).catch(() => false)); i++) await sleep(100);
	await sleep(500);
	await overclock_id(evaluate);
	return evaluate;
}
// The game's slot data and items, and a goal with lots of different colors, none of them white. Returns when the game
// changed, by the tab's clock.
const set_up = (evaluate, slot, items, name = "test") => evaluate(async (slot, items, name) => {
	for (const w of document.querySelectorAll(".window")) if (/Archipelago Connection Options/.test(w.textContent)) w.style.display = "none";
	const { fake_session } = await import("/src/archipelago.js");
	fake_session(slot, items, name);
	const at = Date.now();
	const { width, height } = goal_canvas;
	const image = goal_ctx.createImageData(width, height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * width + x) * 4);
	goal_ctx.putImageData(image, 0, 0);
	$G.triggerHandler("save-goal"); // as a goal the page draws does, so the page reads it again (task 7.3)
	(await import("/src/functions.js")).set_magnification(1);
	return at;
}, slot, items, name);
// Waits up to 5 s for a tab's first merge after its set_up at `since`, by the tab's clock, which in an idle hidden tab
// joins the game. Returns how many ms after the set_up it came, or null.
const first_merge = async (tab, since) => {
	for (let i = 0; i < 100; i++) {
		const at = await tab((since) => window.fill_calls.find((t) => t > since) ?? null, since);
		if (at !== null) return at - since;
		await sleep(50);
	}
	return null;
};
// Holds a tab's merges, and returns how many it ran since its set_up at `since`.
const hold_merges_since = (tab, since) => tab((since) => {
	window.hold_merges = true;
	return window.fill_calls.filter((t) => t > since).length;
}, since);
// Shift+M, as auto copy's own key handler hears it, which starts or pauses auto copy.
const shift_m = () => { for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true })); };
const painted = () => {
	const data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
	let n = 0;
	for (let i = 0; i < data.length; i += 4) if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) n++;
	return n;
};
const state = () => ({ hidden: document.hidden, running: window.paint_hard_auto_copy.running(), speed: window.paint_hard_auto_copy.speed(), margin: window.paint_hard_auto_copy.miss_margin(), bank: window.paint_hard_auto_copy.overclock_bank(), record: window.paint_hard_auto_copy.overclock_record?.() ?? null });

try {
	const a = await open_hidden_tab();
	await a(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("pain-t-overclock-")) localStorage.removeItem(key); });
	const b = await open_hidden_tab();
	await set_up(a, SLOT, ITEMS);
	await set_up(b, SLOT, ITEMS);
	await sleep(1500);
	const before = { a: await a(state), b: await b(state), painted_a: await a(painted), painted_b: await b(painted) };
	// A margin of 255 with no margin copies says the stand-in plays as a Phase 4 seed: one from before has none.
	check("both tabs are hidden, at 256 pixels a second, with 500 s of fillers, in a Phase 4 seed", before.a.hidden && before.b.hidden && before.a.speed === 256 && before.b.speed === 256 && before.a.bank.filler === 500 && before.a.margin === 255 && before.b.margin === 255, json({ a: before.a, b: before.b }));

	await a(shift_m);
	await b(shift_m);
	await sleep(SECONDS * 1000);
	const running = { a: await a(state), b: await b(state) };
	await a(shift_m); // pause, which merges
	await b(shift_m);
	await sleep(1500);
	const after = { a: await a(state), b: await b(state), painted_a: await a(painted), painted_b: await b(painted) };
	// Every second at double speed paints twice the tier's pixels, and costs a filler second.
	const doubled_a = (after.painted_a - before.painted_a) / (2 * 256), doubled_b = (after.painted_b - before.painted_b) / (2 * 256);
	check("both tabs ran auto copy, Overclocked all the way", running.a.running && running.b.running && doubled_a > SECONDS * 0.8 && doubled_b > SECONDS * 0.8 && doubled_a < SECONDS * 1.1 && doubled_b < SECONDS * 1.1, `${doubled_a.toFixed(2)} s and ${doubled_b.toFixed(2)} s doubled, by the pixels painted`);
	const charged = before.a.bank.filler - after.a.bank.filler, doubled = doubled_a + doubled_b;
	check("every second either tab copied at double speed comes out of the fillers", Math.abs(charged - doubled) <= Math.max(1, doubled * 0.05), `${charged.toFixed(3)} s charged for ${doubled.toFixed(3)} s doubled`);
	check("...and both tabs see the same seconds left", Math.abs(after.a.bank.filler - after.b.bank.filler) < 1e-9, `${after.a.bank.filler} and ${after.b.bank.filler}`);
	check("...which is what each tab spent, added up", !!after.a.record && Math.abs(charged - (after.a.record.mine.spent + after.b.record.mine.spent)) < 1e-9 && Math.abs(after.a.record.others.spent - after.b.record.mine.spent) < 1e-9, json({ a: after.a.record, b: after.b.record }));

	// Both tabs connected and idle with D25's default bank: it fills once for the two of them, 10 s a minute.
	await set_up(a, BANK_SLOT, BANK_ITEMS);
	await set_up(b, BANK_SLOT, BANK_ITEMS);
	await sleep(1200);
	const bank_from = (await a(state)).bank.level;
	await sleep(6000);
	const bank_a = (await a(state)).bank.level, bank_b = (await b(state)).bank.level;
	check("the bank fills once for both tabs", bank_a - bank_from > 0.6 && bank_a - bank_from < 1.4 && Math.abs(bank_a - bank_b) < 0.2, `${bank_from.toFixed(3)} -> ${bank_a.toFixed(3)} in 6 s at 1/6 s a second; the other tab sees ${bank_b.toFixed(3)}`);

	// While one tab runs auto copy, the bank fills in neither, though the other rests: the running tab holds its run lock
	// from the moment it starts. The resting tab's merges are held for 3 s as it starts, as between a minute's wakes, and
	// its first merge since reads the locks before it counts, so it fills nothing for those 3 s either. The running tab
	// has nothing to spend here, no fillers and the bank drained, so the totals in its key stay as they are, and it lets
	// go of the lock as it pauses. The bank fills again from then: the pause adds nothing, where a pause that counted from
	// the fill note, last moved as it started, would add the whole run at a sixth of a second a second.
	const QUIET_ITEMS = BANK_ITEMS.filter((name) => name !== "Overclock");
	await set_up(a, BANK_SLOT, QUIET_ITEMS);
	await set_up(b, BANK_SLOT, QUIET_ITEMS);
	await sleep(1200);
	const filled = () => window.paint_hard_auto_copy.overclock_record().fill.filled;
	// Whether the page with this id holds its run lock for the game, as any tab of the browser sees it, by a query after a
	// task, so a lock let go of in the task before shows as let go.
	const run_held = async (session, page) => {
		await new Promise((resolve) => setTimeout(resolve));
		return (await navigator.locks.query()).held.some((lock) => lock.name === `pain-t-overclock-run:${session}:${page}`);
	};
	const note_of = (session) => JSON.parse(localStorage.getItem(`pain-t-overclock-fill:${session}`) ?? "null")?.filled ?? 0;
	// The tab's first merge after `after`, by its own clock, and the stored fill note, read in the same task, so no later
	// merge comes between. Null if none comes within 10 s.
	const merge_after = async (tab, after, session) => {
		for (let i = 0; i < 100; i++) {
			const seen = await tab((after, session) => {
				const { merged_at } = window.paint_hard_auto_copy.overclock_record();
				return merged_at > after ? { at: merged_at, note: JSON.parse(localStorage.getItem(`pain-t-overclock-fill:${session}`) ?? "null")?.filled ?? 0 } : null;
			}, after, session);
			if (seen) return seen;
			await sleep(100);
		}
		return null;
	};
	// Starts auto copy as Shift+M does, and asks for the locks held in the same task, after the start's lock request, so
	// it reads whether this page holds its run lock for the game from the moment it starts. With `drain`, it first empties
	// the bank, in the same task, so no merge fills it in between. Returns the stored fill note's seconds too.
	const start_and_hold = async (session, drain = false) => {
		if (drain) {
			const { mine, others } = window.paint_hard_auto_copy.overclock_record();
			localStorage.setItem(`pain-t-overclock-fill:${session}`, JSON.stringify({ filled: mine.used + others.used, at: Date.now() }));
		}
		const note = JSON.parse(localStorage.getItem(`pain-t-overclock-fill:${session}`) ?? "null")?.filled ?? 0;
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true }));
		const { page } = window.paint_hard_auto_copy.overclock_record();
		return { held: (await navigator.locks.query()).held.some((lock) => lock.name === `pain-t-overclock-run:${session}:${page}`), note };
	};
	await b(() => { window.hold_merges = true; }); // b rests, its merges held
	const started = await a(start_and_hold, "test", true); // a runs
	await sleep(3000);
	await b(() => { window.hold_merges = false; });
	let seen_running = false; // at b's next merge
	for (let i = 0; i < 50 && !seen_running; i++) {
		await sleep(100);
		seen_running = (await b(state)).record.others.running;
	}
	const quiet = (await a(state)).bank;
	await sleep(4000);
	const run_to = await b(note_of, "test");
	const paused = await a(async (session) => {
		const record = () => window.paint_hard_auto_copy.overclock_record();
		const { page } = record(), key = `pain-t-overclock-page:${session}:${page}`, stored = () => JSON.parse(localStorage.getItem(key) ?? "null");
		const before = record(), kept = stored(), at = Date.now();
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true }));
		const after = record();
		// Its key held its totals already and they stayed.
		const unchanged = kept?.spent === before.mine.spent && kept?.used === before.mine.used && after.mine.spent === before.mine.spent && after.mine.used === before.mine.used;
		await new Promise((resolve) => setTimeout(resolve));
		const held = (await navigator.locks.query()).held.some((lock) => lock.name === `pain-t-overclock-run:${session}:${page}`);
		return { added: after.fill.filled - before.fill.filled, running: window.paint_hard_auto_copy.running(), held, unchanged, at };
	}, "test");
	// The other tab's first merge that sees no run, within 5 s, since a hidden tab's 1 s merges can come 2 s apart. It
	// fills from the pause, so no more than the time since at 1/6 s a second.
	let rested = null;
	for (let i = 0; i < 50 && !rested; i++) {
		await sleep(100);
		const record = (await b(state)).record;
		if (!record.others.running) rested = record;
	}
	const rest_from = rested?.fill.filled ?? NaN, rest_after = rested ? (rested.merged_at - paused.at) / 1000 : NaN;
	await sleep(4000);
	const rest_to = await b(filled);
	check("while one tab runs auto copy the bank fills in neither, and once it pauses it fills again", started.held && seen_running && run_to === started.note && paused.unchanged && !paused.running && !paused.held && !!rested && paused.added < 0.05 && rest_from - run_to <= rest_after / 6 + 0.02 && rest_to - rest_from > 0.4, `with ${quiet.filler} s of fillers and ${quiet.level} s banked, holding its run lock as it started: ${started.held}, seen by the other: ${seen_running}; ${(run_to - started.note).toFixed(3)} s filled in the 7 s after it started, with the other's merges held for the first 3; ${paused.added.toFixed(3)} s as it ${paused.running ? "failed to pause" : "paused"}, its totals ${paused.unchanged ? "unchanged" : "changed"}, its lock then ${paused.held ? "still held" : "let go of"}; then ${rested ? `${(rest_from - run_to).toFixed(3)} s at the other's first merge that saw no run, ${rest_after.toFixed(1)} s after the pause, and ${(rest_to - rest_from).toFixed(3)} s in 4 s more` : "no merge of the other's saw the run end in 5 s"}, at 1/6 s a second`);

	// A computer that sleeps an hour while one tab runs auto copy: as it wakes, both tabs' clocks have jumped an hour at
	// once, and the running tab may not merge again for a minute, in a tab Chrome wakes once a minute. It holds its run
	// lock all along, so the resting tab sees the run at every merge and fills nothing, where it would fill the minute and
	// a half a wake allows, 15 s here. The running tab's merges are held from before the jump until the resting tab has
	// merged for 6 s since it. Date.now stands in for the clock.
	await set_up(a, BANK_SLOT, QUIET_ITEMS, "sleep");
	await set_up(b, BANK_SLOT, QUIET_ITEMS, "sleep");
	await sleep(1200);
	await b(() => { window.hold_merges = true; });
	const held_to_sleep = (await a(start_and_hold, "sleep", true)).held;
	await b(() => { window.hold_merges = false; });
	await sleep(1500);
	const woke_at = Date.now() + 1500;
	const jump_date = (at) => {
		window.real_date_now ??= Date.now.bind(Date);
		Date.now = () => window.real_date_now() + (window.real_date_now() >= at ? 3600000 : 0);
	};
	await a(jump_date, woke_at);
	await b(jump_date, woke_at);
	await a(() => { window.hold_merges = true; });
	const slept_from = await b(note_of, "sleep");
	const woke = await merge_after(b, woke_at + 3600000, "sleep"); // the resting tab's first merge since the jump
	const slept = woke && await merge_after(b, woke.at + 6000, "sleep"); // and its first 6 s after that
	await a(() => { window.hold_merges = false; });
	await sleep(1200);
	await a(shift_m);
	await a(() => { Date.now = window.real_date_now; });
	await b(() => { Date.now = window.real_date_now; });
	check("a computer that wakes from an hour's sleep while one tab runs auto copy fills the bank in neither, for the 6 s after the resting tab's first merge since", held_to_sleep && !!slept && woke.note - slept_from < 0.05 && slept.note - slept_from < 0.05, !slept ? `the resting tab didn't merge after the jump: ${JSON.stringify(woke)}` : `${(woke.note - slept_from).toFixed(3)} s filled at the resting tab's first merge after the jump, and ${(slept.note - slept_from).toFixed(3)} s by its merge ${((slept.at - woke.at) / 1000).toFixed(1)} s later, at 1/6 s a second`);

	// Chrome wakes a tab hidden about a minute once a minute, both tabs in the same millisecond, and each late tick spends
	// the minute's seconds. Each takes in what the other wrote before it spends, so the two spend the same seconds for one
	// wake at most. A clock jumped 20 s ahead stands in for the minute, three times, at the same moments in both tabs, and
	// each tab notes when its late ticks came, so a run where they didn't share a wake is tried again. The late ticks come
	// on wakes a second apart, and both tabs' once-a-second merges are held from just before the first until after the
	// last, as between a minute's wakes, so only each late tick's own merge takes in what the other spent. The check
	// after this one holds the merge back too.
	const LATE_ITEMS = ITEMS.filter((name) => name !== "Overclock").concat(Array(10).fill("Overclock")); // 50 s
	// The clock jumps 20 s at each of the given times, from Date.now().
	const jump_clock = (times) => {
		window.real_now ??= performance.now.bind(performance);
		window.jumps = [...(window.jumps ?? []), ...times];
		performance.now = () => window.real_now() + 20000 * window.jumps.filter((at) => Date.now() >= at).length;
	};
	let late = null;
	for (let run = 1; run <= 3 && !late?.together; run++) {
		await set_up(a, SLOT, LATE_ITEMS, `late-ticks-${run}`);
		await set_up(b, SLOT, LATE_ITEMS, `late-ticks-${run}`);
		const first = Date.now() + 2500, times = [first, first + 1000, first + 2000];
		await a(jump_clock, times);
		await b(jump_clock, times);
		await a(() => { window.late_ticks = []; });
		await b(() => { window.late_ticks = []; });
		// Each tab's panel is open from the game before, and the tab takes its run lock in this one as it starts.
		const holding = [(await a(start_and_hold, `late-ticks-${run}`)).held, (await b(start_and_hold, `late-ticks-${run}`)).held];
		await sleep(first - 800 - Date.now());
		await a(() => { window.hold_merges = true; });
		await b(() => { window.hold_merges = true; });
		await sleep(first + 3500 - Date.now());
		await a(() => { window.hold_merges = false; });
		await b(() => { window.hold_merges = false; });
		await a(shift_m);
		await b(shift_m);
		await sleep(1500);
		const ticks = { a: await a(() => window.late_ticks), b: await b(() => window.late_ticks) };
		const together = ticks.a.length === 3 && ticks.b.length === 3 && ticks.a.every((at, i) => Math.abs(at - ticks.b[i]) < 300);
		late = { a: (await a(state)).record.mine.spent, b: (await b(state)).record.mine.spent, together, run, ticks, holding };
	}
	check("two tabs woken together once a minute spend the same seconds for one wake at most", late.together && late.a + late.b <= 50 + 21 + 1 && late.a + late.b >= 49 && late.a >= 20 && late.b >= 20, `${(late.a + late.b).toFixed(2)} s spent of 50 s of fillers: ${late.a.toFixed(2)} and ${late.b.toFixed(2)}, with wakes 21 s apart; late ticks ${late.together ? "shared their wakes" : `didn't share a wake: ${JSON.stringify(late.ticks)}`}, run ${late.run}`);
	check("...and a tab that starts auto copy just after its game changed holds its run lock in the new game at once", late.holding.every(Boolean), JSON.stringify(late.holding));

	// A late tick writes what it spent before the next merge, which matters where the merge runs first at a wake, as at
	// the first minute wake after auto copy starts in a tab Chrome already wakes once a minute. With the merge held, this
	// tab's key holds the late tick's spending right after it: at least the 20 s the clock jumped, since a tick after it
	// may have spent a little more by the time this reads.
	await set_up(a, SLOT, LATE_ITEMS, "late-write");
	await a(shift_m);
	await sleep(1500);
	await a(() => { window.hold_merges = true; });
	const late_from = await a(() => window.paint_hard_auto_copy.overclock_record().mine.spent);
	await a(jump_clock, [Date.now()]);
	let wrote = null;
	for (let i = 0; i < 60 && !wrote; i++) {
		wrote = await a((from) => {
			const record = window.paint_hard_auto_copy.overclock_record();
			if (record.mine.spent < from + 20) return null;
			return { held: !!window.merge_found, mine: record.mine, stored: JSON.parse(localStorage.getItem(`pain-t-overclock-page:late-write:${record.page}`) ?? "null") };
		}, late_from);
		if (!wrote) await sleep(50);
	}
	await a(() => { window.hold_merges = false; });
	await a(shift_m);
	check("a late tick writes what it spent before the next merge", !!wrote?.held && wrote.stored?.spent >= late_from + 20 && wrote.stored.spent <= wrote.mine.spent && wrote.stored.used === wrote.mine.used, JSON.stringify({ from: late_from, ...wrote }));

	// A late tick takes in what another tab spent before it spends: with the merge held, another page's key for the game
	// says 40 of the 50 s of fillers are gone, and then the clock jumps 20 s. The late tick spends only what's left,
	// however two tabs' wakes fall, where without its merge it would spend the 20 s. Read once the tab notes its late tick,
	// which it does in the task that spends.
	await set_up(a, SLOT, LATE_ITEMS, "late-stale");
	await a(shift_m);
	await sleep(1500);
	await a(() => { window.hold_merges = true; });
	await sleep(1200);
	const stale_from = await a(() => {
		localStorage.setItem("pain-t-overclock-page:late-stale:another-tab", JSON.stringify({ spent: 40, used: 0 }));
		return { spent: window.paint_hard_auto_copy.overclock_record().mine.spent, ticks: window.late_ticks.length };
	});
	await a(jump_clock, [Date.now()]);
	let stale = null;
	for (let i = 0; i < 60 && !stale; i++) {
		stale = await a((ticks) => {
			if (window.late_ticks.length <= ticks) return null;
			const { mine, others } = window.paint_hard_auto_copy.overclock_record();
			return { mine, others };
		}, stale_from.ticks);
		if (!stale) await sleep(50);
	}
	await a(() => { window.hold_merges = false; });
	await a(shift_m);
	await a(() => { localStorage.removeItem("pain-t-overclock-page:late-stale:another-tab"); });
	check("...and takes in what another tab spent before it spends", !!stale && stale.others.spent === 40 && stale.mine.spent <= 50 - 40 + 0.01, `${stale_from.spent.toFixed(3)} s spent before the clock jumped 20 s, ${stale ? `${stale.mine.spent.toFixed(3)} s after its late tick, with another page's ${stale.others.spent} s` : "no late tick"} of 50 s of fillers`);

	// A tab that runs auto copy and loses its connection still runs it, waiting, so the other tab, connected, doesn't fill
	// the bank. Then that tab leaves the game while it runs auto copy. Its last merge in the game it left lets go of its
	// run lock there and moves the fill note on to then with nothing added, so the other tab fills only from the change.
	// The other tab's merges are held for the 4 s before, as between a minute's wakes. Its first merge since fills from
	// the stop note: more than nothing, and no more than the time since. With no stop note it would take the end for a
	// crash and fill nothing there; counted from the note from before the run, it would fill the whole run.
	const set_connection_window = (shown) => { for (const w of document.querySelectorAll(".window")) if (/Archipelago Connection Options/.test(w.textContent)) w.style.display = shown ? "" : "none"; };
	await set_up(a, BANK_SLOT, BANK_ITEMS, "leaving");
	await set_up(b, BANK_SLOT, BANK_ITEMS, "leaving");
	await sleep(1200);
	await b(shift_m);
	await sleep(1500);
	await b(set_connection_window, true);
	await sleep(1500);
	const waiting = await b(() => document.querySelector(".auto-copy-panel .window-content").children[0].textContent);
	const wait_from = await a(filled);
	await sleep(4000);
	const wait_to = await a(filled);
	await b(set_connection_window, false);
	await sleep(1500);
	await a(() => { window.hold_merges = true; });
	await sleep(4000);
	const leaving_from = await a(note_of, "leaving");
	const left_at = await b(async (slot, items) => {
		const at = Date.now();
		(await import("/src/archipelago.js")).fake_session(slot, items, "left-for");
		window.paint_hard_auto_copy.overclock_record(); // takes in the new game now, as its next tick would
		return at;
	}, BANK_SLOT, BANK_ITEMS);
	const left = { held: await a(run_held, "leaving", await overclock_id(b)), note: await a(note_of, "leaving") };
	const leaving_released = await a(() => { window.hold_merges = false; return Date.now(); });
	const after_leaving = await merge_after(a, leaving_released, "leaving"); // the other's first merge since
	await b(shift_m); // pause, in the game it went to
	const since_left = after_leaving ? (after_leaving.at - left_at) / 1000 : NaN;
	check("a tab waiting for its connection still runs auto copy, so the other doesn't fill the bank", /Waiting for the connection/.test(waiting) && wait_to === wait_from, `"${waiting}"; ${(wait_to - wait_from).toFixed(3)} s filled in 4 s`);
	check("...and once it leaves the game while it runs, the other fills only from then", !left.held && left.note - leaving_from < 0.05 && !!after_leaving && after_leaving.note > left.note && after_leaving.note - left.note <= since_left / 6 + 0.02, `its run lock in the game it left ${left.held ? "still held" : "let go of"}; ${(left.note - leaving_from).toFixed(3)} s added as it left, then ${after_leaving ? `${(after_leaving.note - left.note).toFixed(3)} s at the other's first merge since, ${since_left.toFixed(1)} s after it left, at 1/6 s a second` : "no merge of the other's"}`);

	// A tab that pauses while it waits for its connection has no fill of its own to count, and still lets go of its run
	// lock and moves the fill note on to then with nothing added, so the other fills only from the pause. The other tab's
	// merges are held for the 4 s before. Its first merge since fills from the stop note: more than nothing, and no more
	// than the time since. With no stop note it would fill nothing there; counted from the note from before the run, it
	// would fill the whole run.
	await set_up(a, BANK_SLOT, QUIET_ITEMS, "waiting-pause");
	await set_up(b, BANK_SLOT, QUIET_ITEMS, "waiting-pause");
	await sleep(1200);
	await a(() => { window.hold_merges = true; });
	const held_to_wait = (await b(start_and_hold, "waiting-pause", true)).held;
	await a(() => { window.hold_merges = false; });
	await sleep(1500);
	await b(set_connection_window, true);
	await sleep(1500);
	await a(() => { window.hold_merges = true; });
	await sleep(4000);
	const wait_pause_from = await a(note_of, "waiting-pause");
	const waited = await b(async (session) => {
		const state = document.querySelector(".auto-copy-panel .window-content").children[0].textContent, at = Date.now();
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true }));
		const { page } = window.paint_hard_auto_copy.overclock_record(), running = window.paint_hard_auto_copy.running();
		await new Promise((resolve) => setTimeout(resolve));
		return { state, at, running, held: (await navigator.locks.query()).held.some((lock) => lock.name === `pain-t-overclock-run:${session}:${page}`) };
	}, "waiting-pause");
	const wait_pause_note = await a(note_of, "waiting-pause");
	const wait_released = await a(() => { window.hold_merges = false; return Date.now(); });
	const after_wait_pause = await merge_after(a, wait_released, "waiting-pause");
	await b(set_connection_window, false);
	const since_wait_pause = after_wait_pause ? (after_wait_pause.at - waited.at) / 1000 : NaN;
	check("...and a tab that pauses while it waits for its connection lets the other fill only from the pause", held_to_wait && /Waiting for the connection/.test(waited.state) && !waited.running && !waited.held && wait_pause_note - wait_pause_from < 0.05 && !!after_wait_pause && after_wait_pause.note > wait_pause_note && after_wait_pause.note - wait_pause_note <= since_wait_pause / 6 + 0.02, `"${waited.state}" as it ${waited.running ? "failed to pause" : "paused"}, its run lock then ${waited.held ? "still held" : "let go of"}; ${(wait_pause_note - wait_pause_from).toFixed(3)} s added at the pause, then ${after_wait_pause ? `${(after_wait_pause.note - wait_pause_note).toFixed(3)} s at the other's first merge since, ${since_wait_pause.toFixed(1)} s after the pause, at 1/6 s a second` : "no merge of the other's"}`);

	// A tab that closes while it runs auto copy lets go of its run lock and moves the fill note on as it goes, so the other
	// fills the bank from then. Its last merge, as it closes, fills nothing for the 5.5 s it ran: its own 1 s merge is held
	// for its last 4 s, and the other's around the close, so only the closing tab's last merge can move the note there.
	const e = await open_hidden_tab();
	await set_up(e, BANK_SLOT, BANK_ITEMS, "closing");
	await set_up(a, BANK_SLOT, BANK_ITEMS, "closing");
	await e(shift_m);
	await sleep(1500);
	const e_errors = await e(() => window.tab_errors);
	const closing_from = await a(filled);
	await e(() => { window.hold_merges = true; });
	await sleep(4000);
	const closing_to = await a(filled);
	await a(() => { window.hold_merges = true; });
	const note_before_close = await a(note_of, "closing"), closed_at = Date.now();
	await cdp("Target.closeTarget", { targetId: e.target });
	await sleep(500);
	const note_after_close = await a(note_of, "closing");
	const close_released = await a(() => { window.hold_merges = false; return Date.now(); });
	const closed = await merge_after(a, close_released, "closing"); // the other's first merge since
	const since_close = closed ? (closed.at - closed_at) / 1000 : NaN;
	check("a tab that closes while it runs auto copy lets the other fill the bank from then", closing_to === closing_from && note_after_close - note_before_close < 0.05 && !!closed && closed.note > note_after_close && closed.note - note_after_close <= since_close / 6 + 0.02, `${(closing_to - closing_from).toFixed(3)} s filled in 4 s while it ran, ${(note_after_close - note_before_close).toFixed(3)} s added by its own last merge as it closed, then ${closed ? `${(closed.note - note_after_close).toFixed(3)} s at the other's first merge since, ${since_close.toFixed(1)} s after the close, at 1/6 s a second` : "no merge of the other's"}`);

	// A duplicated tab starts with a copy of the original's sessionStorage, and so its id. The original holds that id, so
	// the copy takes one of its own.
	const id_a = await overclock_id(a), id_b = await overclock_id(b);
	const c = await open_hidden_tab(`sessionStorage.setItem("pain-t-overclock-id", ${JSON.stringify(id_a)});`);
	const id_c = await overclock_id(c);
	check("a duplicated tab takes an id of its own", ![id_a, id_b].includes(id_c), JSON.stringify({ a: id_a, b: id_b, c: id_c }));

	// The second tab closes and another opens: it takes the closed tab's id, and the totals under it, so the record keeps
	// a key for each tab open at once.
	const test_keys = () => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("pain-t-overclock-page:test:")).map((key) => [key, JSON.parse(localStorage.getItem(key))]));
	const errors = [...(await a(() => window.tab_errors)), ...(await b(() => window.tab_errors)), ...e_errors];
	const keys_before = await a(test_keys);
	await cdp("Target.closeTarget", { targetId: b.target });
	await sleep(500);
	const d = await open_hidden_tab();
	const id_d = await overclock_id(d);
	await set_up(d, SLOT, ITEMS);
	await sleep(1200);
	const d_mine = (await d(state)).record.mine, b_left = keys_before[`pain-t-overclock-page:test:${id_b}`], keys_after = await a(test_keys);
	check("a new tab takes a closed tab's id and its totals, so the record keeps a key for each tab open at once", id_d === id_b && !!b_left && d_mine.spent === b_left.spent && d_mine.used === b_left.used && JSON.stringify(keys_after) === JSON.stringify(keys_before), `${id_d} took ${id_b}'s place with ${JSON.stringify(d_mine)}; keys ${JSON.stringify(keys_before)} -> ${JSON.stringify(keys_after)}`);

	// A tab that crashes while it runs auto copy leaves no word that it stopped: the browser lets go of its run lock, and
	// no note says when the run ended. The other tab, whose last merge saw the run, fills from its first merge since, not
	// from before. Its merges are held for the 4 s before the crash, as between a minute's wakes, and if it counted from
	// the fill note, last moved as the run started, it would fill the whole run, about 7 s. A tab that closes with its
	// pagehide handlers taken out stands in for the crash. It has nothing to spend, so it leaves no key behind.
	const NO_PAGEHIDE = `const add_listener = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (type, ...rest) { if (type !== "pagehide") return add_listener.call(this, type, ...rest); };`;
	const f = await open_hidden_tab(NO_PAGEHIDE);
	await set_up(f, BANK_SLOT, QUIET_ITEMS, "crash");
	await set_up(a, BANK_SLOT, QUIET_ITEMS, "crash");
	await sleep(1200);
	const crash_start = await f(start_and_hold, "crash", true);
	let crash_seen = false; // at a's next merge
	for (let i = 0; i < 50 && !crash_seen; i++) {
		await sleep(100);
		crash_seen = (await a(state)).record.others.running;
	}
	await sleep(1500);
	await a(() => { window.hold_merges = true; });
	await sleep(4000);
	const crash_from = await a(note_of, "crash"), f_record = (await f(state)).record;
	errors.push(...(await f(() => window.tab_errors)));
	await cdp("Target.closeTarget", { targetId: f.target });
	await sleep(500);
	const crash_released = await a(() => { window.hold_merges = false; return Date.now(); });
	const after_crash = await merge_after(a, crash_released, "crash"); // the other's first merge since
	const then_crash = after_crash && await merge_after(a, after_crash.at, "crash");
	check("a tab that crashes while it runs auto copy lets the other fill the bank only from its first merge since", crash_start.held && crash_seen && f_record.mine.spent === 0 && f_record.mine.used === 0 && !!then_crash && after_crash.note === crash_from && then_crash.note > after_crash.note, `holding its run lock as it started: ${crash_start.held}, seen by the other: ${crash_seen}, with ${JSON.stringify(f_record.mine)} spent; ${after_crash ? (after_crash.note - crash_from).toFixed(3) : "no merge"} s at the other's first merge since, then ${then_crash ? (then_crash.note - after_crash.note).toFixed(3) : "no merge"} s at its next, at 1/6 s a second`);

	// A tab that rests and closes while another runs auto copy fills nothing as it goes: the locks it last read may be a
	// minute old, in a tab Chrome wakes once a minute, and the note says a run may go on. Its merges are held from before
	// the other tab starts, so if its last merge filled, it would count the 4 s of the run. The fill note stays as the
	// run's start left it. A tab that hasn't merged since set_up is still in its last game, and its close would leave
	// this note as it was whatever it did, so the hold waits for the resting tab's first merge in the game.
	const k = await open_hidden_tab();
	const k_set_up = await set_up(k, BANK_SLOT, QUIET_ITEMS, "closing-resting");
	await set_up(a, BANK_SLOT, QUIET_ITEMS, "closing-resting");
	const k_first = await first_merge(k, k_set_up);
	const k_merges = await hold_merges_since(k, k_set_up);
	await sleep(1200); // a merge already waiting on its query is done by now
	const resting_start = await a(start_and_hold, "closing-resting", true);
	await sleep(4000);
	const fill_text = (session) => localStorage.getItem(`pain-t-overclock-fill:${session}`);
	const resting_before = await a(fill_text, "closing-resting");
	errors.push(...(await k(() => window.tab_errors)));
	await cdp("Target.closeTarget", { targetId: k.target });
	await sleep(500);
	const resting_after = await a(fill_text, "closing-resting");
	await a(shift_m);
	const resting_word = JSON.parse(resting_before ?? "null")?.running === true;
	check("a resting tab that closes while another runs auto copy, its merges held since before the run, fills nothing as it goes", k_merges > 0 && resting_start.held && resting_word && resting_after === resting_before, `${k_merges} merge${k_merges === 1 ? "" : "s"} in the game before its hold, the first ${k_first} ms after its set_up; holding its run lock as it started: ${resting_start.held}, the note saying a run may go on: ${resting_word}; the fill note ${resting_before} before the close and ${resting_after} after`);

	// With no run, the game's last tab fills the time since its last merge as it closes, since no other tab would: its
	// merges are held for the 5 s before, so it counts them. Its hold waits for its first merge in the game too.
	const l = await open_hidden_tab();
	const l_set_up = await set_up(l, BANK_SLOT, QUIET_ITEMS, "closing-last");
	const l_first = await first_merge(l, l_set_up);
	const last_held_at = Date.now();
	const l_merges = await hold_merges_since(l, l_set_up);
	await sleep(1200);
	const last_from = await a(note_of, "closing-last");
	await sleep(4000);
	errors.push(...(await l(() => window.tab_errors)));
	const last_closed_at = Date.now();
	await cdp("Target.closeTarget", { targetId: l.target });
	await sleep(500);
	const last_to = await a(note_of, "closing-last");
	const last_most = (last_closed_at - last_held_at + 1000) / 6000; // from its last merge, at most a second before the hold
	check("...and with no run, the game's last tab fills the time since its last merge as it closes", l_merges > 0 && last_to - last_from > 0.5 && last_to - last_from <= last_most + 0.02, `${l_merges} merge${l_merges === 1 ? "" : "s"} in the game before its hold, the first ${l_first} ms after its set_up; ${(last_to - last_from).toFixed(3)} s filled as it closed, its merges held for the ${((last_closed_at - last_held_at) / 1000).toFixed(1)} s before, at 1/6 s a second`);

	// A run can start and crash between a resting tab's merges, as between a minute's wakes, so that tab never sees its
	// lock. The run leaves word in the fill note as it starts, so the resting tab, finding the word and no lock, fills from
	// its first merge since, not from the note before the run, which would fill the whole run, about 5.5 s.
	const g = await open_hidden_tab(NO_PAGEHIDE);
	await set_up(g, BANK_SLOT, QUIET_ITEMS, "crash-unseen");
	await set_up(a, BANK_SLOT, QUIET_ITEMS, "crash-unseen");
	await sleep(1200);
	await a(() => { window.hold_merges = true; });
	await sleep(1200);
	const unseen_start = await g(start_and_hold, "crash-unseen", true);
	const unseen_word = JSON.parse(await g(fill_text, "crash-unseen") ?? "null")?.running === true;
	await sleep(4000);
	const unseen_view = (await a(state)).record.others.running;
	errors.push(...(await g(() => window.tab_errors)));
	await cdp("Target.closeTarget", { targetId: g.target });
	await sleep(500);
	const unseen_released = await a(() => { window.hold_merges = false; return Date.now(); });
	const after_unseen = await merge_after(a, unseen_released, "crash-unseen"); // the resting tab's first merge since
	const then_unseen = after_unseen && await merge_after(a, after_unseen.at, "crash-unseen");
	check("...and one that crashes in a run the resting tab never saw, between its merges, lets it fill only from its first merge since", unseen_start.held && unseen_word && !unseen_view && !!then_unseen && after_unseen.note === unseen_start.note && then_unseen.note > after_unseen.note, `holding its run lock as it started: ${unseen_start.held}, the note saying a run may go on: ${unseen_word}, the resting tab seeing it: ${unseen_view}; ${after_unseen ? (after_unseen.note - unseen_start.note).toFixed(3) : "no merge"} s at the resting tab's first merge since, then ${then_unseen ? (then_unseen.note - after_unseen.note).toFixed(3) : "no merge"} s at its next, at 1/6 s a second`);

	// Two tabs run auto copy and the resting tab sees them. One pauses while the other still runs, and its stop note moves
	// the fill note on; then the other crashes, both between the resting tab's merges. The stop beside another run keeps
	// the word that a run may go on, so the resting tab fills from its first merge since, not from the stop, which would
	// fill the crashed run's last 4.5 s. The crashing tab's merges are held from before the stop, as between a minute's
	// wakes, so it can't put back a word the stop took away, and the tab that paused has its merges held from the pause,
	// so only the resting tab's merges move the note on after the crash.
	const h = await open_hidden_tab(NO_PAGEHIDE);
	await set_up(h, BANK_SLOT, QUIET_ITEMS, "crash-after-stop");
	await set_up(c, BANK_SLOT, QUIET_ITEMS, "crash-after-stop");
	await set_up(a, BANK_SLOT, QUIET_ITEMS, "crash-after-stop");
	await sleep(1200);
	const after_stop_start = await h(start_and_hold, "crash-after-stop", true);
	await c(shift_m);
	let both_seen = false; // the resting tab sees a run, and the tab that will pause sees the other's
	for (let i = 0; i < 50 && !both_seen; i++) {
		await sleep(100);
		both_seen = (await a(state)).record.others.running && (await c(state)).record.others.running;
	}
	await a(() => { window.hold_merges = true; });
	await h(() => { window.hold_merges = true; });
	await sleep(1200);
	const stopped_beside = await c((session) => {
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true }));
		window.hold_merges = true;
		return { running: window.paint_hard_auto_copy.running(), note: JSON.parse(localStorage.getItem(`pain-t-overclock-fill:${session}`) ?? "null") };
	}, "crash-after-stop");
	await sleep(4000);
	errors.push(...(await h(() => window.tab_errors)));
	await cdp("Target.closeTarget", { targetId: h.target });
	await sleep(500);
	const after_stop_released = await a(() => { window.hold_merges = false; return Date.now(); });
	const after_stop = await merge_after(a, after_stop_released, "crash-after-stop"); // the resting tab's first merge since
	const then_after_stop = after_stop && await merge_after(a, after_stop.at, "crash-after-stop");
	await c(() => { window.hold_merges = false; });
	const stop_word = stopped_beside.note?.running === true, stop_filled = stopped_beside.note?.filled ?? NaN;
	check("...and one that crashes after another run's stop, both between the resting tab's merges, lets it fill only from its first merge since", after_stop_start.held && both_seen && !stopped_beside.running && stop_word && !!then_after_stop && after_stop.note === stop_filled && then_after_stop.note > after_stop.note, `holding its run lock as it started: ${after_stop_start.held}, both runs seen: ${both_seen}; the tab beside it ${stopped_beside.running ? "failed to pause" : "paused"}, its stop note saying a run may go on: ${stop_word}; ${after_stop ? (after_stop.note - stop_filled).toFixed(3) : "no merge"} s at the resting tab's first merge since, then ${then_after_stop ? (then_after_stop.note - after_stop.note).toFixed(3) : "no merge"} s at its next, at 1/6 s a second`);

	// Without Web Locks, in a browser too old for them or on a page served over plain http from another computer, a tab
	// still gets an id of its own and fills the bank, alone and beside another tab's run, which it can't see (D25), and a
	// run leaves no word in the fill note.
	const NO_LOCKS = `Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined, configurable: true });`;
	const n1 = await open_hidden_tab(NO_LOCKS), n2 = await open_hidden_tab(NO_LOCKS);
	await set_up(n1, BANK_SLOT, QUIET_ITEMS, "no-locks");
	await set_up(n2, BANK_SLOT, QUIET_ITEMS, "no-locks");
	await sleep(1200);
	const lockless = { locks: await n2(() => typeof navigator.locks), ids: [await overclock_id(n1), await overclock_id(n2)] };
	const alone_from = await n2(note_of, "no-locks");
	await sleep(4000);
	const alone_to = await n2(note_of, "no-locks");
	const lockless_start = await n1((session) => {
		for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true }));
		return { running: window.paint_hard_auto_copy.running(), word: JSON.parse(localStorage.getItem(`pain-t-overclock-fill:${session}`) ?? "null")?.running === true };
	}, "no-locks");
	await sleep(1200);
	const beside_from = await n2(note_of, "no-locks");
	await sleep(4000);
	const beside_to = await n2(note_of, "no-locks");
	await n1(shift_m);
	errors.push(...(await n1(() => window.tab_errors)), ...(await n2(() => window.tab_errors)));
	check("without Web Locks a tab still gets an id of its own and fills the bank, alone and beside another tab's run, and a run leaves no word in the note", lockless.locks === "undefined" && lockless.ids[0] !== lockless.ids[1] && alone_to - alone_from > 0.4 && lockless_start.running && !lockless_start.word && beside_to - beside_from > 0.4, `navigator.locks ${lockless.locks}, ids ${lockless.ids.join(" and ")}; ${(alone_to - alone_from).toFixed(3)} s filled in 4 s alone, then ${(beside_to - beside_from).toFixed(3)} s in 4 s beside a run that ${lockless_start.running ? "started" : "didn't start"}, ${lockless_start.word ? "with" : "without"} word in the note, at 1/6 s a second`);

	errors.push(...(await a(() => window.tab_errors)), ...(await c(() => window.tab_errors)), ...(await d(() => window.tab_errors)));
	check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
