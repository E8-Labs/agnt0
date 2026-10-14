import { createInterface } from "node:readline/promises";

export type Ask = (question: string) => Promise<string>;

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export const ttyAsk: Ask = async (q) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
};

/** y/n question; Enter picks the default. */
export async function confirm(ask: Ask, question: string, def: boolean): Promise<boolean> {
  const a = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}
