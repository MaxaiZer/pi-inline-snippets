import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") {
      return;
    }
    const target = process.env.PI_SNIPPET_PROBE_FILE;
    if (target) {
      writeFileSync(target, JSON.stringify({ prompt: event.prompt, type: event.type }));
    }
  });
}
