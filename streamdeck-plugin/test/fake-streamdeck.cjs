/**
 * Attrappe für @elgato/streamdeck, nur im Test: Die Aktionen lassen sich so ohne
 * Stream-Deck-App laden und von Hand mit Ereignissen füttern. Bietet genau, was die
 * Aktionen zur Laufzeit anfassen (Decorator, Basisklasse, Logger, Property Inspector).
 */
"use strict";

const logged = [];
const toPropertyInspector = [];

const streamDeck = {
	logger: {
		info: (...a) => logged.push(`I ${a.join(" ")}`),
		warn: (...a) => logged.push(`W ${a.join(" ")}`),
		error: (...a) => logged.push(`E ${a.join(" ")}`),
	},
	ui: {
		current: {
			sendToPropertyInspector: async (payload) => {
				toPropertyInspector.push(payload);
			},
		},
	},
};

module.exports = {
	__esModule: true,
	default: streamDeck,
	/** Klassen-Decorator (TC39): lässt die Klasse, wie sie ist. */
	action: () => () => undefined,
	SingletonAction: class SingletonAction {},
	logged,
	toPropertyInspector,
};
