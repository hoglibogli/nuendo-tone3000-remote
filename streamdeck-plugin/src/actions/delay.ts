import { action } from "@elgato/streamdeck";

import { Session } from "../state/session";
import { ToggleKeyAction } from "./toggle-key";

/**
 * Delay (Slot 2): Im Bypass schaltet ein Druck es ein und öffnet sein Fenster —
 * Note 2 Velocity 0, Note 3 Velocity 127. Sonst Bypass an und Fenster zu — Note 2
 * Velocity 127, Note 3 Velocity 0. Leuchtet, solange das Delay nicht im Bypass ist
 * (bit2 = 0).
 */
@action({ UUID: "com.sorg.tone3000.delay" })
export class DelayAction extends ToggleKeyAction {
	constructor(session: Session) {
		super(session, "delay");
	}
}
