import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessions } from "./controller.js";

export default function sessions(pi: ExtensionAPI): void {
  registerSessions(pi);
}
