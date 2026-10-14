import type { Project } from "@agnt0/protocol";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { relTime } from "./ui.js";

export type PickResult = { kind: "existing"; project: Project } | { kind: "new" };

export interface PickerIO {
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
}

export function ttyPickerIO(): PickerIO {
  return {
    log: (l) => console.log(l),
    ask: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
  };
}

export const MAX_PICKER_ITEMS = 9;

/**
 * "Use an existing project" vs "Create new". Enter picks the default: the newest project (the one the
 * web guide most likely just created) unless the user typed a name, which signals a new project.
 */
export async function pickProject(projects: Project[], io: PickerIO, opts: { defaultNew: boolean; verb: string }): Promise<PickResult> {
  const shown = projects.slice(0, MAX_PICKER_ITEMS);
  io.log(pc.bold("Your account already has projects."));
  io.log(pc.dim("  Use an existing project:"));
  shown.forEach((p, i) => io.log(`  ${pc.cyan(String(i + 1))}) ${pc.bold(p.name)} ${pc.dim(`${p.id} · ${p.phase.replace("_", " ")} · created ${relTime(p.created_at)}`)}`));
  if (projects.length > shown.length) io.log(pc.dim(`     …and ${projects.length - shown.length} more (use --project <id>)`));
  io.log(`  ${pc.cyan("n")}) Create a new project`);
  const def = opts.defaultNew ? "n" : "1";
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await io.ask(`${opts.verb} [${def}]: `)).trim().toLowerCase() || def;
    if (answer === "n" || answer === "new") return { kind: "new" };
    const idx = Number(answer);
    const chosen = Number.isInteger(idx) ? shown[idx - 1] : shown.find((p) => p.id.toLowerCase() === answer);
    if (chosen) return { kind: "existing", project: chosen };
    io.log(pc.yellow(`  Type 1-${shown.length} or n.`));
  }
  return def === "n" ? { kind: "new" } : { kind: "existing", project: shown[0] as Project };
}
