// End-to-end test for Overclock across tabs (D10, D25): two tabs of one game in this browser, both hidden and both
// running auto copy, as when a player opens the client twice and switches away. Chrome wakes hidden tabs' timers
// together once a second, so both tabs merge their spending in the same millisecond. Every second either tab copied at
// double speed has to show in the record. With no bank in play, each of those seconds costs a filler second, and the
// pixels each tab painted tell how many it had. Then the two share a bank they run dry, evenly, then unevenly, then on
// a fill faster than either spends it, and they wake once a minute. Last, a third tab opens as a duplicate of the first
// and a fourth in place of the second.
// Usage: node test/paint-hard/two-tabs.e2e.mjs [--headful]. Set BROWSER_PATH if Chrome isn't in its default folder.
import { cdp, check, finish, ORIGIN, overclock_id, sleep } from "./harness.mjs";

const FULL_COLOR = [];
for (const channel of ["Red", "Green", "Blue"]) for (let k = 0; k < 254; k++) FULL_COLOR.push(`Progressive Color Depth (${channel})`);
const SLOT = { final_width: 800, final_height: 600, start_width: 600, start_height: 450, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 5, version: "1.0.0", trap_blacklist: [] };
const ITEMS = ["Magnifier", "Brush", ...FULL_COLOR, ...Array(10).fill("Progressive Auto Copy Speed"), ...Array(100).fill("Overclock")];
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
// A check can hold auto copy's once-a-second merge, to see what a late tick writes by itself, and each tab notes when
// auto copy's tick came late, more than 2 s after the last.
const set_interval = window.setInterval;
window.late_ticks = [];
window.setInterval = function (callback, ...rest) {
	if (typeof callback === "function" && callback.name === "fill_bank") {
		window.merge_found = true;
		return set_interval.call(this, () => { if (!window.hold_merges) callback(); }, ...rest);
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
// The game's slot data and items, and a goal with lots of different colors, none of them white.
const set_up = (evaluate, slot, items, name = "test") => evaluate(async (slot, items, name) => {
	for (const w of document.querySelectorAll(".window")) if (/Archipelago Connection Options/.test(w.textContent)) w.style.display = "none";
	const { fake_session } = await import("/src/archipelago.js");
	fake_session(slot, items, name);
	const { width, height } = goal_canvas;
	const image = goal_ctx.createImageData(width, height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set([(x * 3 + y) % 256, (y * 2 + 50) % 256, (x + y * 3) % 256, 255], (y * width + x) * 4);
	goal_ctx.putImageData(image, 0, 0);
	(await import("/src/functions.js")).set_magnification(1);
}, slot, items, name);
// Shift+M, as auto copy's own key handler hears it, which starts or pauses auto copy.
const shift_m = () => { for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key: "M", code: "KeyM", shiftKey: true, bubbles: true })); };
const painted = () => {
	const data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
	let n = 0;
	for (let i = 0; i < data.length; i += 4) if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) n++;
	return n;
};
const state = () => ({ hidden: document.hidden, running: window.paint_hard_auto_copy.running(), speed: window.paint_hard_auto_copy.speed(), bank: window.paint_hard_auto_copy.overclock_bank(), record: window.paint_hard_auto_copy.overclock_record?.() ?? null });

try {
	const a = await open_hidden_tab();
	await a(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("pain-t-overclock-")) localStorage.removeItem(key); });
	const b = await open_hidden_tab();
	await set_up(a, SLOT, ITEMS);
	await set_up(b, SLOT, ITEMS);
	await sleep(1500);
	const before = { a: await a(state), b: await b(state), painted_a: await a(painted), painted_b: await b(painted) };
	check("both tabs are hidden, at 256 pixels a second, with 500 s of fillers", before.a.hidden && before.b.hidden && before.a.speed === 256 && before.b.speed === 256 && before.a.bank.filler === 500, json({ a: before.a, b: before.b }));

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

	// With no fillers and the bank drained, both tabs copy from each second's fill, 50 s a minute. Each tab's line shows
	// its own share of the fill over the last 15 s: the share of each second it doubled, which the test reads from its
	// record. So the two lines add up to twice the speed and the fill once, and each keeps one number. The time left
	// counts from the same share. The fill stops in both tabs first, so neither moves on a note it read before the drain
	// reached it.
	const FILL = 50 / 60, TRICKLE_SLOT = { ...BANK_SLOT, overclock_fill_speed_step: 10 };
	const TRICKLE_ITEMS = BANK_ITEMS.filter((name) => name !== "Overclock");
	const NO_FILL_ITEMS = TRICKLE_ITEMS.filter((name) => name !== "Progressive Overclock Fill Speed");
	await set_up(a, TRICKLE_SLOT, NO_FILL_ITEMS);
	await set_up(b, TRICKLE_SLOT, NO_FILL_ITEMS);
	await sleep(1200);
	await a(() => {
		const { mine, others } = window.paint_hard_auto_copy.overclock_record();
		localStorage.setItem("pain-t-overclock-fill:test", JSON.stringify({ filled: mine.used + others.used, at: Date.now() }));
	});
	await sleep(1200);
	const drained = { a: (await a(state)).bank.level, b: (await b(state)).bank.level }; // before the fill is back
	await set_up(a, TRICKLE_SLOT, TRICKLE_ITEMS);
	await set_up(b, TRICKLE_SLOT, TRICKLE_ITEMS);
	await a(shift_m);
	await b(shift_m);
	const reading = () => {
		const content = document.querySelector(".auto-copy-panel .window-content");
		return { line: content.querySelector("span").textContent, progress: content.children[1].textContent, used: window.paint_hard_auto_copy.overclock_record().mine.used, at: performance.now() };
	};
	const readings = { a: [], b: [] };
	const read_for = async (seconds, tabs) => {
		for (let i = 0; i < seconds * 2; i++) {
			for (const [name, tab] of Object.entries(tabs)) readings[name].push(await tab(reading));
			await sleep(500);
		}
	};
	const number = (text) => Number(text.replace(/,/g, "").match(/^[\d.]+/)?.[0]);
	// What a tab doubled of each second over the last 15 s, from its record, and its lines over the last 5 s.
	const own = (name) => {
		const list = readings[name], last = list.at(-1);
		const first = list.reduce((best, r) => (Math.abs(r.at - (last.at - 15000)) < Math.abs(best.at - (last.at - 15000)) ? r : best));
		const share = (last.used - first.used) / ((last.at - first.at) / 1000);
		const lines = [...new Set(list.filter((r) => r.at > last.at - 5000).map((r) => r.line))];
		return { share, expected: TIER_SPEED * (1 + share), shown: number(last.line), lines, progress: last.progress };
	};
	// Within 7% of what the tab doubled, since the line keeps its number until it's 5% off, and a line that keeps one
	// number, as an average of each second's fill should. A line following a share that's rising gets 8%: it can trail
	// by its 5%, and by up to a second's fill where the test's 15 s don't line up with the page's.
	const matches_own = (tab, changing = false) => Math.abs(tab.shown - tab.expected) <= (changing ? 0.08 : 0.07) * tab.expected && (changing || tab.lines.length <= 2) && tab.lines.every((text) => /partly Overclocked$/.test(text) === tab.share > 0.01);
	await read_for(22, { a, b });
	const even = { a: own("a"), b: own("b") };
	// The panel's time left, at the line's speed: banked seconds are none here.
	const minutes_off = (tab) => {
		const [, left, minutes] = tab.progress.match(/^([\d,]+) pixels left, about (\d+) min/) ?? [];
		return minutes === undefined ? Infinity : Math.abs(Number(minutes) - Number(left.replace(/,/g, "")) / tab.shown / 60);
	};
	const both = even.a.shown + even.b.shown, whole = TIER_SPEED * (2 + FILL);
	check("two tabs on a bank they run dry each show their own share of its fill, in one steady line", drained.a < 0.2 && drained.b < 0.2 && matches_own(even.a) && matches_own(even.b) && Math.abs(both - whole) <= 0.07 * whole, `drained to ${drained.a.toFixed(3)} and ${drained.b.toFixed(3)}; ${JSON.stringify(even.a.lines)} for ${even.a.expected.toFixed(1)} and ${JSON.stringify(even.b.lines)} for ${even.b.expected.toFixed(1)}; ${both.toFixed(1)} together against ${whole.toFixed(1)}`);
	check("...and the time left counts from that share", minutes_off(even.a) <= 1 && minutes_off(even.b) <= 1, `${even.a.progress} at ${even.a.shown}; ${even.b.progress} at ${even.b.shown}`);
	// The second tab pauses. The first now takes the whole fill, and its line follows, though for 15 s it still counts
	// the seconds the two shared. The share is then far enough from half the fill that a line showing half the fill,
	// whatever its tab took, would be more than 11% off.
	await b(shift_m);
	await read_for(13, { a });
	const alone = own("a"), half = TIER_SPEED * (1 + FILL / 2);
	check("...and when one tab pauses, the other's line follows the larger share it takes", Math.abs(half - alone.expected) > 0.11 * alone.expected && matches_own(alone, true), `${JSON.stringify(alone.lines)} for ${alone.expected.toFixed(1)}, a share of ${alone.share.toFixed(3)} where the two shared ${even.a.share.toFixed(3)}; half the fill would read ${half.toFixed(1)}`);
	// A fill of a second and a half a second: either tab alone would never run it dry, but the two do.
	await set_up(a, { ...TRICKLE_SLOT, overclock_fill_speed_step: 18 }, TRICKLE_ITEMS);
	await set_up(b, { ...TRICKLE_SLOT, overclock_fill_speed_step: 18 }, TRICKLE_ITEMS);
	await b(shift_m);
	await read_for(21, { a, b });
	await a(shift_m);
	await b(shift_m);
	const fast = { a: own("a"), b: own("b") };
	check("...and on a fill faster than one tab spends, the two still each show their share", matches_own(fast.a) && matches_own(fast.b) && fast.a.share > 0.5 && fast.b.share > 0.5, `${JSON.stringify(fast.a.lines)} for ${fast.a.expected.toFixed(1)} and ${JSON.stringify(fast.b.lines)} for ${fast.b.expected.toFixed(1)}`);

	// Chrome wakes a tab hidden about a minute once a minute, both tabs in the same millisecond, and each late tick spends
	// the minute's seconds. Each takes in what the other wrote before it spends, so the two spend the same seconds for one
	// wake at most. A clock jumped 20 s ahead stands in for the minute, three times, at the same moments in both tabs, and
	// each tab notes when its late ticks came, so a run where they didn't share a wake is tried again. The tabs stay idle
	// between the late ticks, which come on wakes a second apart. At each of those wakes the tick has run before the
	// merge, which wrote what the tick spent a moment later; the check after this one holds the merge back.
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
		const first = Date.now() + 2000, times = [first, first + 1000, first + 2000];
		await a(jump_clock, times);
		await b(jump_clock, times);
		await a(() => { window.late_ticks = []; });
		await b(() => { window.late_ticks = []; });
		await a(shift_m);
		await b(shift_m);
		await sleep(first + 3500 - Date.now());
		await a(shift_m);
		await b(shift_m);
		await sleep(1500);
		const ticks = { a: await a(() => window.late_ticks), b: await b(() => window.late_ticks) };
		const together = ticks.a.length === 3 && ticks.b.length === 3 && ticks.a.every((at, i) => Math.abs(at - ticks.b[i]) < 300);
		late = { a: (await a(state)).record.mine.spent, b: (await b(state)).record.mine.spent, together, run, ticks };
	}
	check("two tabs woken together once a minute spend the same seconds for one wake at most", late.together && late.a + late.b <= 50 + 21 + 1 && late.a + late.b >= 49 && late.a >= 20 && late.b >= 20, `${(late.a + late.b).toFixed(2)} s spent of 50 s of fillers: ${late.a.toFixed(2)} and ${late.b.toFixed(2)}, with wakes 21 s apart; late ticks ${late.together ? "shared their wakes" : `didn't share a wake: ${JSON.stringify(late.ticks)}`}, run ${late.run}`);

	// A late tick writes what it spent before the next merge, which matters where the merge runs first at a wake, as at
	// the first minute wake after auto copy starts in a tab Chrome already wakes once a minute. With the merge held, this
	// tab's key holds the late tick's spending right after it.
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
	check("a late tick writes what it spent before the next merge", !!wrote?.held && wrote.stored?.spent === wrote.mine.spent && wrote.stored?.used === wrote.mine.used, JSON.stringify({ from: late_from, ...wrote }));

	// A duplicated tab starts with a copy of the original's sessionStorage, and so its id. The original holds that id, so
	// the copy takes one of its own.
	const id_a = await overclock_id(a), id_b = await overclock_id(b);
	const c = await open_hidden_tab(`sessionStorage.setItem("pain-t-overclock-id", ${JSON.stringify(id_a)});`);
	const id_c = await overclock_id(c);
	check("a duplicated tab takes an id of its own", ![id_a, id_b].includes(id_c), JSON.stringify({ a: id_a, b: id_b, c: id_c }));

	// The second tab closes and another opens: it takes the closed tab's id, and the totals under it, so the record keeps
	// a key for each tab open at once.
	const test_keys = () => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("pain-t-overclock-page:test:")).map((key) => [key, JSON.parse(localStorage.getItem(key))]));
	const errors = [...(await a(() => window.tab_errors)), ...(await b(() => window.tab_errors))];
	const keys_before = await a(test_keys);
	await cdp("Target.closeTarget", { targetId: b.target });
	await sleep(500);
	const d = await open_hidden_tab();
	const id_d = await overclock_id(d);
	await set_up(d, SLOT, ITEMS);
	await sleep(1200);
	const d_mine = (await d(state)).record.mine, b_left = keys_before[`pain-t-overclock-page:test:${id_b}`], keys_after = await a(test_keys);
	check("a new tab takes a closed tab's id and its totals, so the record keeps a key for each tab open at once", id_d === id_b && !!b_left && d_mine.spent === b_left.spent && d_mine.used === b_left.used && JSON.stringify(keys_after) === JSON.stringify(keys_before), `${id_d} took ${id_b}'s place with ${JSON.stringify(d_mine)}; keys ${JSON.stringify(keys_before)} -> ${JSON.stringify(keys_after)}`);

	errors.push(...(await a(() => window.tab_errors)), ...(await c(() => window.tab_errors)), ...(await d(() => window.tab_errors)));
	check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
