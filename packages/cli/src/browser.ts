import { debug } from "./config.js";

/** Opens a URL in the default browser; never throws. Disabled with AGNT0_NO_BROWSER=1. */
export async function openBrowser(url: string): Promise<boolean> {
  if (process.env.AGNT0_NO_BROWSER === "1") return false;
  try {
    const { default: open } = await import("open");
    const child = await open(url, { wait: false });
    child.on("error", (e) => debug("browser open failed", e));
    child.unref();
    return true;
  } catch (e) {
    debug("browser open failed", e);
    return false;
  }
}
