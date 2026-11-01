import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwAdvisor } from "./advisor.js";
import btw from "./btw.js";

export default function piBtw(pi: ExtensionAPI): void {
  btw(pi);
  registerBtwAdvisor(pi);
}
