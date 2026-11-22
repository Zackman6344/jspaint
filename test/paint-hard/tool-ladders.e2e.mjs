// End-to-end test for Pain-T's tool ladders (ROADMAP D24, task 3.9): every painting tool starts one pixel wide, and
// each ladder's copies unlock its option box, smallest first. It also covers the page before a game connects, the
// fills Paint makes by itself, and voice commands. It stands in for a game with fake_session() from
// src/archipelago.js, as auto-copy.e2e.mjs does, and paints with trusted mouse and keyboard input.
// Usage: node test/paint-hard/tool-ladders.e2e.mjs [--headful]. Set BROWSER_PATH if Chrome isn't in its default folder.
import { call, check, evaluate, finish, keyboard, mouse, open_paint, page, page_errors, point_on, same, sleep } from "./harness.mjs";

// Lets the test reach the speech recognizer Paint makes in #speech-recognition-mode. Headless Chrome has no microphone,
// so start and stop do nothing; the test hands the result handler what Chrome would hear.
const SPEECH_STUB = `(() => {
	const Original = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!Original) return;
	const Wrapped = function (...args) { const r = new Original(...args); window.__rec = r; r.start = () => { }; r.stop = () => { }; return r; };
	if (window.SpeechRecognition) window.SpeechRecognition = Wrapped;
	if (window.webkitSpeechRecognition) window.webkitSpeechRecognition = Wrapped;
})();`;

const TOOLS = ["Magnifier", "Brush", "Pencil", "Eraser/Color Eraser", "Airbrush", "Line", "Curve", "Rectangle", "Polygon", "Ellipse", "Rounded Rectangle"];
const SLOT_DATA = { final_width: 800, final_height: 600, start_width: 400, start_height: 300, canvas_width_increment: 100, canvas_height_increment: 100, logic_percent: 80, goal_percent: 80, matched_pixels: 0, shade_counts: Array.from({ length: 255 }, (_, k) => k + 2), auto_copy_speed_items: 10, overclock_seconds: 2, version: "1.0.0", trap_blacklist: [], ladders: true, tool_ladders: true };
const { tool_ladders: _, ...OLD_SEED } = SLOT_DATA; // a seed from before D24
const WHITE = [255, 255, 255, 255];
const json = (value) => JSON.stringify(value);

// Every painting tool, plus `items`, counts as received.
const receive = (items, slot_data = SLOT_DATA) => evaluate(async (slot_data, items) => {
	const { fake_session } = await import("/src/archipelago.js");
	fake_session(slot_data, items);
}, slot_data, [...TOOLS, ...items]);
const pick = (id) => evaluate(async (id) => {
	const { select_tool } = await import("/src/functions.js");
	select_tool(get_tool_by_id(id));
}, id);
const sizes = () => evaluate(() => ({ brush_shape, brush_size, eraser_size, airbrush_size, pencil_size, stroke_size }));
const style = (id) => evaluate((id) => { const box = get_tool_by_id(id).$options; return { stroke: box.stroke, fill: box.fill }; }, id);
// The selected tool's option box: each option's value, whether it's grayed out, its tooltip and where to click it.
const box = () => evaluate(() => [...document.querySelectorAll(".tool-options .chooser-option")].map((el) => {
	const r = el.getBoundingClientRect();
	return { thing: $(el).data("thing"), locked: el.style.opacity !== "" && Number(el.style.opacity) < 1, title: el.title, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}));
const unlocked = async () => (await box()).filter((option) => !option.locked).map((option) => option.thing);
const click_option = async (thing) => {
	const option = (await box()).find((o) => json(o.thing) === json(thing));
	await mouse.click(option.x, option.y);
	await sleep(100);
};
const set_colors = (foreground, background) => evaluate((foreground, background) => {
	selected_colors.foreground = foreground;
	selected_colors.background = background;
	$(window).trigger("option-changed");
}, foreground, background);
const px = (x, y) => evaluate((x, y) => Array.from(main_ctx.getImageData(x, y, 1, 1).data), x, y);
// Pixels darker than mid-gray in the rectangle from (x0, y0) to (x1, y1), both included.
const dark = (x0, y0, x1, y1) => evaluate((x0, y0, x1, y1) => {
	const data = main_ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
	let n = 0;
	for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 384) n++;
	return n;
}, x0, y0, x1, y1);
const drag = async (from, to) => {
	const a = await point_on("canvas", ...from), b = await point_on("canvas", ...to);
	await mouse.move(a.x, a.y);
	await mouse.down();
	await mouse.move(b.x, b.y, 10);
	await mouse.up();
	await sleep(150);
};
const press = async (key, times = 1) => { for (let i = 0; i < times; i++) await keyboard.press(key); };
const connection_shown = () => evaluate(() => [...document.querySelectorAll(".window")].some((w) => /Archipelago Connection Options/.test(w.textContent) && w.offsetParent !== null));
// Clicks <menu> > <item> in the menu bar, then makes sure the menu is closed.
const menu_item = async (menu, pattern) => {
	const button = await evaluate((menu) => { const r = [...document.querySelectorAll(".menu-button")].find((el) => el.textContent.replace(/&/g, "").trim() === menu).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, menu);
	await mouse.click(button.x, button.y);
	await sleep(250);
	const item = await evaluate((source) => { const el = [...document.querySelectorAll(".menu-item")].find((el) => new RegExp(source, "i").test(el.textContent) && el.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, pattern.source);
	if (item) await mouse.click(item.x, item.y);
	await sleep(250);
	if (await evaluate(() => !!document.querySelector(".menu-button.active"))) await keyboard.press("Escape");
	return !!item;
};
const not_white = () => evaluate(() => {
	const data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
	let n = 0;
	for (let i = 0; i < data.length; i += 4) if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) n++;
	return n;
});

try {
	await page("Page.addScriptToEvaluateOnNewDocument", { source: SPEECH_STUB });
	await open_paint(undefined, { hide_connection_window: false });

	// 0. Before a game connects: Escape leaves the connection window up, and the page counts as a ladder seed with no
	// copies, so nothing painted there goes past one pixel.
	const host = await evaluate(() => { const r = document.querySelector("[name=aphost]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
	await mouse.click(host.x, host.y);
	await keyboard.press("Escape");
	check("Escape leaves the connection window up", await connection_shown());
	const before_connecting = await sizes();
	check("...and before a game connects every painting tool is one pixel wide", before_connecting.brush_size === 1 && before_connecting.eraser_size === 1 && before_connecting.airbrush_size === 1 && before_connecting.pencil_size === 1 && before_connecting.stroke_size === 1, json(before_connecting));
	await evaluate(() => { for (const w of document.querySelectorAll(".window")) if (/Archipelago Connection Options/.test(w.textContent)) w.style.display = "none"; });

	await receive([]);
	await call("set_magnification", 1);
	await mouse.click(5, 895); // the status bar, to give the page focus for the keys
	await sleep(100);
	await set_colors("#000000", "#ffffff");
	await call("clear");

	// 1. A ladder seed without copies: every painting tool starts one pixel wide.
	await pick("TOOL_BRUSH");
	let s = await sizes();
	check("the brush starts round at 1 pixel", s.brush_shape === "circle" && s.brush_size === 1, json(s));
	check("...and so do the eraser, airbrush, pencil and line width", s.eraser_size === 1 && s.airbrush_size === 1 && s.pencil_size === 1 && s.stroke_size === 1, json(s));
	const brush_box = await box();
	check("the brush box opens only the 1-pixel round brush", json(await unlocked()) === json([{ shape: "circle", size: 1 }]), json(await unlocked()));
	check("...grays the other 11", brush_box.filter((o) => o.locked).length === 11, `${brush_box.filter((o) => o.locked).length} grayed`);
	const title_of = (thing) => brush_box.find((o) => json(o.thing) === json(thing)).title;
	const titles = [{ shape: "circle", size: 7 }, { shape: "square", size: 2 }, { shape: "square", size: 8 }, { shape: "diagonal", size: 2 }].map(title_of);
	check("...and says how many more copies of which ladder each waits for", json(titles) === json(["Unlocked by 2 more Progressive Brush Size", "Unlocked by 1 more Progressive Brush Shape", "Unlocked by 1 more Progressive Brush Shape and 2 more Progressive Brush Size", "Unlocked by 2 more Progressive Brush Shape"]), titles.join(" | "));
	await click_option({ shape: "square", size: 8 });
	s = await sizes();
	check("clicking a locked option does nothing", s.brush_shape === "circle" && s.brush_size === 1, json(s));
	await press("=", 3);
	check("plus leaves the brush at 1 pixel", (await sizes()).brush_size === 1, json(await sizes()));
	await drag([20, 50], [120, 50]);
	check("a brush stroke is one pixel tall", (await dark(70, 40, 70, 60)) === 1, `${await dark(70, 40, 70, 60)} dark in the column`);

	// 2. Brush Size opens the middle column, then the large; plus climbs to the largest open size and no further.
	await receive(["Progressive Brush Size"]);
	check("one Brush Size opens the round brush at 4", json(await unlocked()) === json([{ shape: "circle", size: 4 }, { shape: "circle", size: 1 }]), json(await unlocked()));
	await press("=", 6);
	check("...plus climbs to 4 and stops", (await sizes()).brush_size === 4, json(await sizes()));
	await press("-");
	check("...and minus picks any size under it", (await sizes()).brush_size === 3, json(await sizes()));
	await call("clear");
	await drag([20, 50], [120, 50]);
	check("...a stroke at 3 is 3 pixels tall", (await dark(70, 40, 70, 60)) === 3, `${await dark(70, 40, 70, 60)} dark in the column`);

	// 3. Brush Shape opens the square row, at the sizes open so far, then both slants.
	await receive(["Progressive Brush Size", "Progressive Brush Shape"]);
	check("Brush Shape opens the square brush at 2 and 5", json(await unlocked()) === json([{ shape: "circle", size: 4 }, { shape: "circle", size: 1 }, { shape: "square", size: 5 }, { shape: "square", size: 2 }]), json(await unlocked()));
	await click_option({ shape: "square", size: 5 });
	s = await sizes();
	check("...which the box now picks", s.brush_shape === "square" && s.brush_size === 5, json(s));
	await receive(["Progressive Brush Size", "Progressive Brush Size", "Progressive Brush Shape", "Progressive Brush Shape"]);
	check("two copies of each open all 12", (await unlocked()).length === 12, `${(await unlocked()).length} open`);

	// 4. Anything that sets a size and says so, as voice commands do, is pulled back under the ladder.
	await receive([]);
	s = await sizes();
	check("losing the copies brings the brush back to round at 1", s.brush_shape === "circle" && s.brush_size === 1, json(s));
	await evaluate(() => { brush_size = 50; $(window).trigger("option-changed"); });
	check("a size set past the ladder comes back to it", (await sizes()).brush_size === 1, json(await sizes()));

	// 5. The eraser: 1 pixel, then its box's 4, 6, 8 and 10.
	await pick("TOOL_ERASER");
	check("the eraser box is all locked at the start", (await unlocked()).length === 0 && (await sizes()).eraser_size === 1, json(await unlocked()));
	const eraser_titles = (await box()).map((o) => o.title);
	check("...each saying how many Eraser Size copies it waits for", json(eraser_titles) === json([1, 2, 3, 4].map((n) => `Unlocked by ${n} more Progressive Eraser Size`)), eraser_titles.join(" | "));
	await receive(["Progressive Eraser Size"]);
	check("one Eraser Size opens 4", json(await unlocked()) === json([4]), json(await unlocked()));
	check("...and the 10 then waits for 3 more", (await box()).find((o) => o.thing === 10).title === "Unlocked by 3 more Progressive Eraser Size", (await box()).find((o) => o.thing === 10).title);
	await click_option(4);
	check("...which the box picks", (await sizes()).eraser_size === 4, json(await sizes()));
	await click_option(6);
	check("...while 6 stays locked", (await sizes()).eraser_size === 4, json(await sizes()));

	// 6. The airbrush at 1 pixel sprays only the pixel under it.
	await receive([]);
	await pick("TOOL_AIRBRUSH");
	check("the airbrush box is all locked at the start", (await unlocked()).length === 0, json(await unlocked()));
	await call("clear");
	const spot = await point_on("canvas", 200, 150);
	await mouse.move(spot.x, spot.y);
	await mouse.down();
	await sleep(300);
	await mouse.up();
	await sleep(100);
	check("the airbrush at 1 pixel paints one dot", (await dark(185, 135, 215, 165)) === 1 && !same(await px(200, 150), WHITE), `${await dark(185, 135, 215, 165)} dark`);

	// 7. The pencil stays one pixel wide.
	await pick("TOOL_PENCIL");
	await press("=", 2);
	check("plus leaves the pencil at 1 pixel", (await sizes()).pencil_size === 1, json(await sizes()));

	// 8. One line width for Line, Curve and the shapes.
	await pick("TOOL_LINE");
	await press("=");
	check("the line stays 1 pixel wide", (await sizes()).stroke_size === 1, json(await sizes()));
	check("...and its box opens only 1", json(await unlocked()) === json([1]), json(await unlocked()));
	await receive(["Progressive Line Width"]);
	await press("=", 2);
	check("one Line Width lets plus reach 2", (await sizes()).stroke_size === 2, json(await sizes()));
	await call("clear");
	await drag([20, 100], [200, 100]);
	check("...and a line comes out 2 pixels thick", (await dark(110, 90, 110, 110)) === 2, `${await dark(110, 90, 110, 110)} dark in the column`);

	// 9. Each shape's fill climbs its own ladder. A red background fills the shapes; Clear clears to white paper.
	const white_canvas_red_fill = async () => { await set_colors("#000000", "#ffffff"); await call("clear"); await set_colors("#000000", "#ff0000"); };
	await receive([]);
	await pick("TOOL_RECTANGLE");
	check("the rectangle box opens only the outline", json(await unlocked()) === json([{ stroke: true, fill: false }]), json(await unlocked()));
	await click_option({ stroke: false, fill: true });
	check("clicking fill only does nothing", json(await style("TOOL_RECTANGLE")) === json({ stroke: true, fill: false }), json(await style("TOOL_RECTANGLE")));
	await white_canvas_red_fill();
	await drag([50, 50], [150, 120]);
	check("a rectangle is only its outline", same(await px(100, 85), WHITE) && (await dark(40, 85, 160, 85)) === 2, `${json(await px(100, 85))}, ${await dark(40, 85, 160, 85)} dark across`);
	await receive(["Progressive Rectangle Fill"]);
	await click_option({ stroke: true, fill: true });
	await white_canvas_red_fill();
	await drag([50, 50], [150, 120]);
	check("one Rectangle Fill opens outline with fill", same(await px(100, 85), [255, 0, 0, 255]), json(await px(100, 85)));
	await pick("TOOL_ELLIPSE");
	check("...while the ellipse's fill waits for its own ladder", json(await unlocked()) === json([{ stroke: true, fill: false }]), json(await unlocked()));
	await receive([]);
	check("losing the copy brings the rectangle back to its outline", json(await style("TOOL_RECTANGLE")) === json({ stroke: true, fill: false }), json(await style("TOOL_RECTANGLE")));

	// 10. Seeds from before the ladders keep every size, as upstream.
	await set_colors("#000000", "#ffffff");
	await receive([], OLD_SEED);
	s = await sizes();
	check("an older seed starts at upstream's sizes", s.brush_shape === "circle" && s.brush_size === 4 && s.eraser_size === 8 && s.airbrush_size === 9 && s.pencil_size === 1 && s.stroke_size === 1, json(s));
	await pick("TOOL_BRUSH");
	check("...and opens all 12 brushes", (await unlocked()).length === 12, `${(await unlocked()).length} open`);
	await click_option({ shape: "square", size: 8 });
	await press("=");
	check("...and plus goes past the box, as in JS Paint", (await sizes()).brush_size === 9, json(await sizes()));
	await pick("TOOL_PENCIL");
	await press("=");
	check("...and the pencil grows with plus", (await sizes()).pencil_size === 2, json(await sizes()));

	// 11. An item packet redraws the boxes only when a ladder's copies changed, as every redraw runs each box's handlers.
	// Switching tools takes a box's last handlers off before it binds new ones, so their number stays put.
	await receive([]);
	await pick("TOOL_BRUSH");
	const redraws = await evaluate(async (slot_data, items) => {
		const { fake_session } = await import("/src/archipelago.js");
		let n = 0;
		$(window).on("option-changed.redraws", () => n++);
		fake_session(slot_data, items); // the same items again
		const same_items = n;
		fake_session(slot_data, [...items, "Fill With Color"]); // a new item, on no ladder
		const other_item = n - same_items;
		fake_session(slot_data, [...items, "Fill With Color", "Progressive Brush Size"]);
		const ladder_copy = n - same_items - other_item;
		$(window).off("option-changed.redraws");
		return { same_items, other_item, ladder_copy };
	}, SLOT_DATA, TOOLS);
	check("an item packet redraws the boxes only when a ladder's copies change", redraws.same_items === 0 && redraws.other_item === 0 && redraws.ladder_copy >= 1, json(redraws));
	const handlers = await evaluate(async () => {
		const { select_tool } = await import("/src/functions.js");
		// Every handler bound on the window, of every type; on each tool's box; and on the sprite images ChooserCanvas
		// draws from, found as they get one.
		const images = new Set(), add = jQuery.event.add;
		jQuery.event.add = function (element, ...rest) { if (element?.tagName === "IMG") images.add(element); return add.call(this, element, ...rest); };
		const sum = (target) => Object.values($._data(target, "events") ?? {}).reduce((n, list) => n + list.length, 0);
		const boxes = [...new Set((await import("/src/tools.js")).tools.map((tool) => tool.$options?.[0]).filter(Boolean))];
		const count = () => ({ window: sum(window), boxes: boxes.reduce((n, box) => n + sum(box), 0), images: [...images].reduce((n, image) => n + sum(image), 0) });
		// The Airbrush box draws from a sprite, and the Magnifier and Select boxes are made of ChooserDivs. A box keeps its
		// first build's handlers by design, so the count starts after one pass.
		const pass = () => { for (const id of ["TOOL_AIRBRUSH", "TOOL_MAGNIFIER", "TOOL_SELECT", "TOOL_BRUSH"]) select_tool(get_tool_by_id(id)); $(window).trigger("option-changed"); };
		pass();
		const at_start = count();
		for (let i = 0; i < 25; i++) pass();
		jQuery.event.add = add;
		return { at_start, after: count() };
	});
	check("...and 100 tool switches leave the boxes' handlers as many as they were", json(handlers.after) === json(handlers.at_start), json(handlers));

	// A glide through a box goes on when the box rebuilds under the held button, as when a Tool Swap Trap turns Line
	// into Curve, which shares its box. After the button comes up, hovering picks nothing.
	await receive(Array(4).fill("Progressive Line Width"));
	await pick("TOOL_LINE");
	let widths = await box();
	await mouse.move(widths[0].x, widths[0].y, 4);
	await mouse.down();
	await sleep(50);
	await pick("TOOL_CURVE");
	widths = await box();
	const glide = [];
	for (const option of widths.slice(1)) {
		await mouse.move(option.x, option.y, 4);
		glide.push((await sizes()).stroke_size);
	}
	await mouse.up();
	await sleep(100);
	await mouse.move(widths[2].x, widths[2].y, 4);
	await sleep(50);
	check("a glide through the line widths goes on when the box rebuilds under the held button", json(glide) === json([2, 3, 4, 5]), json(glide));
	check("...and once the button is up, hovering picks nothing", (await sizes()).stroke_size === 5, json(await sizes()));

	// 12. The Magnifier's secret 10x option stays hidden through redraws: only boxes with a ladder touch opacity.
	await pick("TOOL_MAGNIFIER");
	const secret = () => evaluate(() => { const el = [...document.querySelectorAll(".tool-options .chooser-option")].find((o) => $(o).data("thing") === 10); return el ? getComputedStyle(el).opacity : "none"; });
	const secret_at_first = await secret();
	await evaluate(() => { $(window).trigger("option-changed"); });
	await receive(["Progressive Brush Size", "Progressive Brush Size"]); // a ladder copy, so the boxes redraw
	check("the Magnifier's secret 10x option stays hidden through redraws", secret_at_first === "0" && (await secret()) === "0", `${secret_at_first} -> ${await secret()}`);

	// 13. In a ladder seed Paint's own fills use white paper, whatever the background color: Image > Clear Image, a canvas
	// item's new strip and a DeathLink reset. Otherwise a background near the goal's average would paint it all at once.
	// Every shade is received, so the gray background is one the player could pick; with fewer, Paint rounds it.
	const FULL_COLOR = ["Red", "Green", "Blue"].flatMap((channel) => Array(254).fill(`Progressive Color Depth (${channel})`));
	const background = () => evaluate(async () => (await import("/src/helpers.js")).get_rgba_from_color(selected_colors.background).join());
	await receive(FULL_COLOR);
	await pick("TOOL_BRUSH");
	await set_colors("#000000", "#a09e9c");
	const gray = await background();
	check("Image > Clear Image is in the menu, with a gray background", (await menu_item("Image", /^Clear Image/)) && gray === "160,158,156,255", gray);
	check("...and clears to white, not the background color", (await not_white()) === 0, `${await not_white()} pixels not white; ${json(await px(10, 10))}`);
	await call("resize_canvas_without_saving_dimensions", 500, 300);
	check("a canvas item's new strip is white", same(await px(450, 150), WHITE), json(await px(450, 150)));
	await call("reset_canvas_and_history");
	check("a DeathLink reset is white", (await not_white()) === 0, `${await not_white()} pixels not white`);
	// Stretch and Skew has no menu item in AP Paint, and Ctrl+Alt+W opens it no more. It filled what a skew uncovers with
	// the background color, and stretched a small copy over the whole canvas.
	const stretch_and_skew = async () => {
		await mouse.click(5, 895); // the status bar, for the keys
		await sleep(100);
		const steps = await evaluate(() => undos.length);
		for (const type of ["rawKeyDown", "keyUp"]) await page("Input.dispatchKeyEvent", { type, key: "w", code: "KeyW", windowsVirtualKeyCode: 87, modifiers: 3 });
		await sleep(300);
		const opened = await evaluate(() => {
			const shown = [...document.querySelectorAll(".stretch-and-skew")].filter((w) => w.offsetParent !== null);
			for (const w of shown) w.querySelector(".window-close-button")?.click();
			return shown.length;
		});
		return { opened, steps_added: (await evaluate(() => undos.length)) - steps };
	};
	const in_ladder_seed = await stretch_and_skew();
	await receive(FULL_COLOR, OLD_SEED);
	const in_older_seed = await stretch_and_skew();
	check("Ctrl+Alt+W opens no Stretch and Skew, in a ladder seed or an older one", in_ladder_seed.opened === 0 && in_older_seed.opened === 0 && in_ladder_seed.steps_added === 0, json({ in_ladder_seed, in_older_seed }));
	await set_colors("#000000", "#a09e9c");
	await menu_item("Image", /^Clear Image/);
	check("an older seed's Clear Image still uses the background color, as upstream", same(await px(10, 10), [160, 158, 156, 255]), `${json(await px(10, 10))}; background ${await background()}`);
	await set_colors("#000000", "#ffffff");

	// 14. Voice commands go through the same gates as clicks (#speech-recognition-mode): a tool whose item hasn't arrived
	// stays locked, and so does what the menu grays out.
	await evaluate(() => { location.hash = "speech-recognition-mode"; });
	await sleep(400);
	check("speech recognition is on", await evaluate(() => typeof window.__rec?.onresult === "function"));
	const say = (text) => evaluate((text) => {
		try { window.__rec.onresult({ results: [[{ transcript: text, confidence: 0.9 }]] }); } catch (error) { if (!/not connected/i.test(error.message)) return { thrown: error.message }; }
		return { tool: selected_tool.id, status: $status_text.text() };
	}, text);
	await receive(["Select"]); // no Fill With Color or Text; Select open
	await pick("TOOL_BRUSH");
	let said = await say("fill");
	check("saying a locked tool leaves it locked and says why", said.tool === "TOOL_BRUSH" && said.status === "Fill With Color is locked until its item arrives.", json(said));
	said = await say("select text");
	check("...and a locked Text isn't taken for the open Select", said.tool === "TOOL_BRUSH" && /^Text is locked/.test(said.status), json(said));
	said = await say("select");
	check("...while an open tool still answers", said.tool === "TOOL_SELECT", json(said));
	await pick("TOOL_BRUSH");
	said = await say("extras similarity mode");
	check("a view the menu grays out stays hidden by voice", !(await evaluate(() => $sim.is(":visible"))) && said.status === "Similarity Mode isn't available now.", json(said));
	said = await say("paste");
	check("...and so does a menu item that is always off", !said.thrown && said.status === "Paste isn't available now.", json(said));
	await receive(["Select", "Fill With Color"]);
	said = await say("fill");
	check("once its item arrives, saying it picks the tool", said.tool === "TOOL_FILL", json(said));

	check("no page errors", page_errors.length === 0, page_errors.join(" | "));
} catch (error) {
	check("test run completed without exceptions", false, error?.stack || String(error));
} finally {
	finish();
}
