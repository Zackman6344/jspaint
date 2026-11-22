// @ts-check
/* global airbrush_size:writable, brush_shape:writable, brush_size:writable, eraser_size:writable, pencil_size:writable, stroke_size:writable */
/* global default_airbrush_size, default_brush_shape, default_brush_size, default_eraser_size, default_pencil_size, default_stroke_size */
// The tool ladders of D24 (ROADMAP): every painting tool starts one pixel wide, and its own Progressive item unlocks the
// rest of its option box, smallest first. The boxes in tool-options.js gray out what's locked and ignore it. The plus
// and minus keys and voice commands set sizes directly and then trigger "option-changed", where clamp_tool_sizes()
// pulls them back under the largest unlocked. Seeds without the ladders keep every size, as upstream does. Until a
// seed's slot data arrives, the page counts as a ladder seed with no copies.
import { $G } from "./helpers.js";

// Each tool's option box, smallest first, with 1 pixel in front where the box itself starts larger.
const BRUSH_SIZES = { circle: [1, 4, 7], square: [2, 5, 8], reverse_diagonal: [2, 5, 8], diagonal: [2, 5, 8] };
const BRUSH_SHAPES = [["circle"], ["square"], ["reverse_diagonal", "diagonal"]];
const ERASER_SIZES = [1, 4, 6, 8, 10];
const AIRBRUSH_SIZES = [1, 9, 16, 24];
const STROKE_SIZES = [1, 2, 3, 4, 5]; // Line, Curve and the four shapes share one width, as in Paint
const FILL_STYLES = [[true, false], [true, true], [false, true]]; // [stroke, fill]: outline, outline with fill, fill only
const FILL_LADDERS = {
	TOOL_RECTANGLE: "Progressive Rectangle Fill",
	TOOL_POLYGON: "Progressive Polygon Fill",
	TOOL_ELLIPSE: "Progressive Ellipse Fill",
	TOOL_ROUNDED_RECTANGLE: "Progressive Rounded Rectangle Fill",
};

/** @type {((name: string) => number) | null} copies received of a ladder, or null while every size is open */
let rungs = () => 0;
/** @type {Map<object, string>} each shape tool's fill style box, to its own ladder */
const fill_ladders = new Map();

// The largest entry of `list` that the copies of `ladder` received so far unlock. Extra copies change nothing.
const top = (list, ladder) => list[Math.min(rungs?.(ladder) ?? Infinity, list.length - 1)];
const fill_rung = (stroke, fill) => FILL_STYLES.findIndex(([s, f]) => s === stroke && f === fill);

const LADDERS = ["Progressive Brush Size", "Progressive Brush Shape", "Progressive Eraser Size", "Progressive Airbrush Size", "Progressive Line Width", ...Object.values(FILL_LADDERS)];
/** @type {string | undefined} the copies of each ladder when the boxes were last redrawn, or "open" without the ladders */
let drawn_for;

/**
 * Called by archipelago.js whenever items arrive, and once as the page opens.
 * @param {((name: string) => number) | null} count copies received of a ladder; null for a seed without the ladders
 * @param {Tool[]} tools
 */
function set_tool_ladders(count, tools) {
	// A seed without the ladders starts at upstream's sizes, which the page before connecting held at 1 pixel.
	if (!count && drawn_for !== "open") {
		[brush_shape, brush_size, eraser_size, airbrush_size, pencil_size, stroke_size] = [default_brush_shape, default_brush_size, default_eraser_size, default_airbrush_size, default_pencil_size, default_stroke_size];
	}
	rungs = count;
	for (const tool of tools) {
		if (FILL_LADDERS[tool.id]) fill_ladders.set(tool.$options, FILL_LADDERS[tool.id]);
	}
	const now = count ? LADDERS.map((ladder) => count(ladder)).join() : "open";
	// Redraws the boxes only when what's unlocked changed. Every item packet comes through here, and each redraw runs
	// every box's handlers.
	if (clamp_tool_sizes() || now !== drawn_for) $G.trigger("option-changed");
	drawn_for = now;
}

// Each returns what an option still waits for, as "2 more Progressive Eraser Size", or "" once it's unlocked. An
// option's rung is the first entry of its list at least as large, and each copy opens one more rung.
const rung_of = (list, size) => list.findIndex((s) => s >= size);
const more = (rung, ladder) => [Math.max(0, rung - rungs(ladder)), ladder];
const waits = (...needs) => needs.filter(([n]) => n > 0).map(([n, ladder]) => `${n} more ${ladder}`).join(" and ");
/** @param {{ shape: BrushShape, size: number }} option */
function brush_locked({ shape, size }) {
	if (!rungs) return "";
	return waits(
		more(BRUSH_SHAPES.findIndex((row) => row.includes(shape)), "Progressive Brush Shape"),
		more(rung_of(BRUSH_SIZES[shape], size), "Progressive Brush Size"),
	);
}
/** @param {number} size */
const eraser_locked = (size) => rungs ? waits(more(rung_of(ERASER_SIZES, size), "Progressive Eraser Size")) : "";
/** @param {number} size */
const airbrush_locked = (size) => rungs ? waits(more(rung_of(AIRBRUSH_SIZES, size), "Progressive Airbrush Size")) : "";
/** @param {number} size */
const stroke_locked = (size) => rungs ? waits(more(rung_of(STROKE_SIZES, size), "Progressive Line Width")) : "";
/**
 * @param {object} $chooser a shape tool's fill style box
 * @param {{ stroke: boolean, fill: boolean }} style
 */
function fill_style_locked($chooser, { stroke, fill }) {
	const ladder = rungs && fill_ladders.get($chooser);
	return ladder ? waits(more(fill_rung(stroke, fill), ladder)) : "";
}

// Pulls every size and fill style back under what's unlocked. Returns whether anything changed.
function clamp_tool_sizes() {
	if (!rungs) return false;
	const before = [brush_shape, brush_size, eraser_size, airbrush_size, pencil_size, stroke_size].join();
	if (brush_locked({ shape: brush_shape, size: 1 })) brush_shape = "circle";
	brush_size = Math.min(brush_size, top(BRUSH_SIZES[brush_shape], "Progressive Brush Size"));
	eraser_size = Math.min(eraser_size, top(ERASER_SIZES, "Progressive Eraser Size"));
	airbrush_size = Math.min(airbrush_size, top(AIRBRUSH_SIZES, "Progressive Airbrush Size"));
	pencil_size = 1; // the Pencil stays one pixel wide, as Paint describes it
	stroke_size = Math.min(stroke_size, top(STROKE_SIZES, "Progressive Line Width"));
	let changed = before !== [brush_shape, brush_size, eraser_size, airbrush_size, pencil_size, stroke_size].join();
	for (const [$chooser, ladder] of fill_ladders) {
		if (fill_rung($chooser.stroke, $chooser.fill) > rungs(ladder)) {
			[$chooser.stroke, $chooser.fill] = FILL_STYLES[Math.min(rungs(ladder), FILL_STYLES.length - 1)];
			changed = true;
		}
	}
	return changed;
}

// The plus and minus keys, voice commands and the boxes all trigger this after setting a size.
$G.on("option-changed", () => {
	if (clamp_tool_sizes()) $G.trigger("option-changed");
});

export { airbrush_locked, brush_locked, clamp_tool_sizes, eraser_locked, fill_style_locked, set_tool_ladders, stroke_locked };
