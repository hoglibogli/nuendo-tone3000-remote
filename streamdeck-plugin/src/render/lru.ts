/**
 * Kleiner LRU-Zwischenspeicher für fertige Bilder.
 *
 * Map hält die Einfügereihenfolge; ein Treffer wird ans Ende umgehängt, beim
 * Überlauf fliegt der älteste Eintrag. Mehr braucht es nicht: Ein Regler-Bild ist
 * gut 30 KB groß, 256 davon sind rund 8 MB.
 */
export class Lru<V> {
	private readonly entries = new Map<string, V>();

	constructor(private readonly max: number) {}

	get(key: string): V | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: string, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		while (this.entries.size > this.max) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}
}
