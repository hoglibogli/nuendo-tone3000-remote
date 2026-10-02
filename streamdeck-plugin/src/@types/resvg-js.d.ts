/**
 * Knappe Typen für @resvg/resvg-js (2.6).
 *
 * Das Paket liegt wie das MIDI-Modul nur im .sdPlugin-Ordner (native Teile) und
 * bleibt aus dem Bündel heraus; im node_modules des Projekts, wo der Compiler
 * sucht, fehlt es. Beschrieben ist nur, was der Renderer benutzt.
 */
declare module "@resvg/resvg-js" {
	export type ResvgRenderOptions = {
		font?: {
			loadSystemFonts?: boolean;
			fontFiles?: string[];
			fontDirs?: string[];
			defaultFontSize?: number;
			defaultFontFamily?: string;
			serifFamily?: string;
			sansSerifFamily?: string;
		};
		dpi?: number;
		shapeRendering?: 0 | 1 | 2;
		textRendering?: 0 | 1 | 2;
		imageRendering?: 0 | 1;
		fitTo?:
			| { mode: "original" }
			| { mode: "width"; value: number }
			| { mode: "height"; value: number }
			| { mode: "zoom"; value: number };
		background?: string;
		logLevel?: "off" | "error" | "warn" | "info" | "debug" | "trace";
	};

	export class BBox {
		x: number;
		y: number;
		width: number;
		height: number;
	}

	export class RenderedImage {
		asPng(): Buffer;
		get pixels(): Buffer;
		get width(): number;
		get height(): number;
	}

	export class Resvg {
		constructor(svg: Buffer | string, options?: ResvgRenderOptions | null);
		render(): RenderedImage;
		/** Umriss aller sichtbaren Elemente nach Transformation; Text zählt als Glyphenumriss. */
		getBBox(): BBox | undefined;
		get width(): number;
		get height(): number;
	}
}
