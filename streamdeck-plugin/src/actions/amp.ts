import { action } from "@elgato/streamdeck";

import { Session } from "../state/session";
import { ToggleKeyAction } from "./toggle-key";

/**
 * Fenster von TONE3000 (Slot 3) auf und zu: Note 4 auf Kanal 3, Velocity =
 * Zielzustand (offen ? 0 : 127). Leuchtet, solange das Fenster offen ist (bit4).
 */
@action({ UUID: "com.sorg.tone3000.amp" })
export class AmpAction extends ToggleKeyAction {
	constructor(session: Session) {
		super(session, "amp");
	}
}
