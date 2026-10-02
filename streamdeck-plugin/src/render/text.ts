/**
 * Text setzen: messen, Größe finden, umbrechen, kürzen.
 *
 * Gemessen wird der echte Glyphenumriss über resvg (engine.measureInk), deshalb
 * sitzt auch Schreibschrift mit ihren weit ausholenden Großbuchstaben genau in
 * der Mitte. Jede Zeile ist ein eigenes <text> mit allen Attributen — so zeichnet
 * es auch der SVG-Rückfall in Stream Deck (Qt, SVG Tiny), der keine tspan-Zeilen
 * kennt.
 */
import { escapeXml, measureInk, type Ink } from "./engine";
import { n } from "./style";

export type Box = { x: number; y: number; w: number; h: number };

/** weight: font-weight, nur für die klare Schrift (Segoe UI halbfett = 600). */
export type TextStyle = { family: string; fill: string; opacity?: number; weight?: number };

/** Ein <text> mit Anfangspunkt auf der Grundlinie. */
export function textEl(x: number, y: number, text: string, size: number, style: TextStyle): string {
	const op = style.opacity !== undefined && style.opacity < 1 ? ` fill-opacity="${n(style.opacity)}"` : "";
	const w = style.weight !== undefined ? ` font-weight="${style.weight}"` : "";
	return `<text x="${n(x)}" y="${n(y)}" font-family="${style.family}"${w} font-size="${n(size)}" fill="${style.fill}"${op}>${escapeXml(text)}</text>`;
}

function inkWidth(ink: Ink): number {
	return ink.right - ink.left;
}

/** x des Textanfangs, damit die Tinte um cx zentriert steht. weight wie in TextStyle. */
export function centeredX(text: string, family: string, size: number, cx: number, weight?: number): number {
	const ink = measureInk(family, text, weight);
	return cx - ((ink.left + ink.right) / 2) * size;
}

/** Breite der Tinte in px bei Größe size. */
export function textWidth(text: string, family: string, size: number, weight?: number): number {
	return inkWidth(measureInk(family, text, weight)) * size;
}

/**
 * Kürzt mit „…", bis der Text bei dieser Größe in maxW passt. Leer bleibt leer.
 */
export function truncateToWidth(text: string, family: string, size: number, maxW: number, weight?: number): string {
	if (textWidth(text, family, size, weight) <= maxW) return text;
	const chars = [...text];
	// Halbierend suchen: höchstens ~6 Messungen statt einer je Zeichen.
	let lo = 0;
	let hi = chars.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		const candidate = chars.slice(0, mid).join("").trimEnd() + "…";
		if (textWidth(candidate, family, size, weight) <= maxW) lo = mid;
		else hi = mid - 1;
	}
	return lo === 0 ? "…" : chars.slice(0, lo).join("").trimEnd() + "…";
}

/** Eine Zeile links bündig: Größe bis maxSize, notfalls bis minSize kleiner, dann gekürzt. */
export function fitLine(
	text: string,
	family: string,
	maxW: number,
	maxSize: number,
	minSize: number,
	weight?: number,
): { text: string; size: number } {
	const w = inkWidth(measureInk(family, text, weight));
	if (w <= 0) return { text, size: maxSize };
	const size = Math.min(maxSize, maxW / w);
	if (size >= minSize) return { text, size };
	return { text: truncateToWidth(text, family, minSize, maxW, weight), size: minSize };
}

export type BlockOptions = {
	maxSize: number;
	minSize: number;
	maxLines: 1 | 2;
	/** Abstand der Grundlinien in Schriftgrößen. */
	lineGap: number;
	/** Einzeilig gewinnt, solange es mindestens diesen Anteil der zweizeiligen Größe erreicht. */
	preferSingle: number;
};

export type Block = { size: number; lines: { text: string; x: number; y: number }[] };

/** Senkrechte Ausdehnung eines Blocks in Schriftgrößen: Oberkante Zeile 1 bis Unterkante letzte Zeile. */
function blockHeight(inks: Ink[], gap: number): number {
	return -inks[0].top + (inks.length - 1) * gap + inks[inks.length - 1].bottom;
}

/** Größte Schrift, mit der diese Zeilen in die Box passen. */
function sizeFor(lines: string[], family: string, box: Box, opts: BlockOptions): number {
	const inks = lines.map((l) => measureInk(family, l));
	const widest = Math.max(...inks.map(inkWidth));
	const tall = blockHeight(inks, opts.lineGap);
	if (widest <= 0 || tall <= 0) return opts.maxSize;
	return Math.min(opts.maxSize, box.w / widest, box.h / tall);
}

/**
 * Setzt einen Namen in eine Box: ein- oder zweizeilig, so groß wie möglich,
 * waagerecht und senkrecht nach der Tinte zentriert. Passt selbst die kleinste
 * Größe nicht, wird zweizeilig umbrochen und die letzte Zeile gekürzt.
 */
export function fitBlock(text: string, family: string, box: Box, opts: BlockOptions): Block {
	const clean = text.replace(/\s+/g, " ").trim();
	const candidates: string[][] = [[clean]];
	if (opts.maxLines === 2) {
		const words = clean.split(" ");
		for (let i = 1; i < words.length; i++) {
			candidates.push([words.slice(0, i).join(" "), words.slice(i).join(" ")]);
		}
	}

	const single = sizeFor(candidates[0], family, box, opts);
	let best = candidates[0];
	let bestSize = single;
	let bestMulti: string[] | null = null;
	let bestMultiSize = 0;
	for (const c of candidates.slice(1)) {
		const s = sizeFor(c, family, box, opts);
		if (s > bestMultiSize) {
			bestMultiSize = s;
			bestMulti = c;
		}
	}
	if (bestMulti && single < bestMultiSize * opts.preferSingle) {
		best = bestMulti;
		bestSize = bestMultiSize;
	}

	// Zu klein selbst mit Umbruch an Leerzeichen (lange Komposita wie
	// „Röhrenverstärkerübersteuerung"): mitten im Wort mit Trennstrich teilen.
	if (bestSize < opts.minSize && opts.maxLines === 2) {
		const split = hyphenSplit(clean, family);
		if (split) {
			const s = sizeFor(split, family, box, opts);
			if (s > bestSize) {
				best = split;
				bestSize = s;
			}
		}
	}

	if (bestSize < opts.minSize) {
		bestSize = opts.minSize;
		best = wrapAndTruncate(clean, family, box.w, opts.minSize, opts.maxLines);
	}
	return place(best, family, bestSize, box, opts.lineGap);
}

/**
 * Teilt einen Text in zwei möglichst gleich breite Zeilen, notfalls mitten im
 * Wort (dann mit „-"). Halbierend gesucht: Die erste Zeile wird mit jedem Zeichen
 * breiter, die zweite schmaler.
 */
function hyphenSplit(text: string, family: string): string[] | null {
	const chars = [...text];
	if (chars.length < 6) return null;
	const make = (i: number): string[] => {
		const inWord = chars[i - 1] !== " " && chars[i] !== " ";
		return [chars.slice(0, i).join("").trimEnd() + (inWord ? "-" : ""), chars.slice(i).join("").trimStart()];
	};
	const widest = (lines: string[]): number => Math.max(...lines.map((l) => inkWidth(measureInk(family, l))));
	let lo = 3;
	let hi = chars.length - 3;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const [a, b] = make(mid);
		if (inkWidth(measureInk(family, a)) < inkWidth(measureInk(family, b))) lo = mid + 1;
		else hi = mid;
	}
	const here = make(lo);
	const before = make(Math.max(3, lo - 1));
	return widest(before) < widest(here) ? before : here;
}

/** Gieriger Umbruch bei fester Größe, letzte Zeile mit „…" gekürzt. */
function wrapAndTruncate(text: string, family: string, maxW: number, size: number, maxLines: number): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";
	for (let i = 0; i < words.length; i++) {
		const next = current ? `${current} ${words[i]}` : words[i];
		if (!current || textWidth(next, family, size) <= maxW) {
			current = next;
			continue;
		}
		if (lines.length === maxLines - 1) {
			current = `${current} ${words.slice(i).join(" ")}`;
			break;
		}
		lines.push(current);
		current = words[i];
	}
	lines.push(current);
	return lines.map((l) => truncateToWidth(l, family, size, maxW));
}

function place(lines: string[], family: string, size: number, box: Box, gap: number): Block {
	const inks = lines.map((l) => measureInk(family, l));
	const tall = blockHeight(inks, gap) * size;
	const firstBaseline = box.y + (box.h - tall) / 2 - inks[0].top * size;
	const cx = box.x + box.w / 2;
	return {
		size,
		lines: lines.map((l, i) => ({
			text: l,
			x: cx - ((inks[i].left + inks[i].right) / 2) * size,
			y: firstBaseline + i * gap * size,
		})),
	};
}

export function blockEl(block: Block, style: TextStyle): string {
	return block.lines.map((l) => textEl(l.x, l.y, l.text, block.size, style)).join("");
}
