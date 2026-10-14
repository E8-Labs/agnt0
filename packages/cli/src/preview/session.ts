import { m2routes, type PreviewStatus } from "@agnt0/protocol";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ApiClient } from "../api/client.js";
import { debug } from "../config.js";
import { httpUp, pidAlive } from "../net.js";

export const PREVIEW_FILE = join(".agnt0", "preview.json");

const PreviewFile = z.object({
  pid: z.number().int(),
  page_url: z.string(),
  app_url: z.string(),
  framework: z.string().nullable(),
  started_at: z.string(),
});
export type PreviewFile = z.infer<typeof PreviewFile>;

export async function writePreviewFile(root: string, data: PreviewFile): Promise<void> {
  const p = join(root, PREVIEW_FILE);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(data, null, 2)}\n`);
}

export async function removePreviewFile(root: string): Promise<void> {
  await rm(join(root, PREVIEW_FILE), { force: true });
}

/** The preview another `agnt0 preview` is serving right now, if its process is alive and the app answers. */
export async function readLivePreview(root: string): Promise<PreviewFile | null> {
  try {
    const parsed = PreviewFile.safeParse(JSON.parse(await readFile(join(root, PREVIEW_FILE), "utf8")));
    if (!parsed.success) return null;
    if (!pidAlive(parsed.data.pid)) return null;
    return (await httpUp(parsed.data.app_url)) ? parsed.data : null;
  } catch {
    return null;
  }
}

export const PREVIEW_DEVICES: PreviewStatus["devices"] = ["mobile", "tablet", "desktop"];

/** POST the preview status; best effort (the preview works without the dashboard). */
export async function reportPreview(
  api: ApiClient | null,
  projectId: string | null,
  body: { state: PreviewStatus["state"]; local_url: string | null; framework: string | null; message?: string | null },
): Promise<boolean> {
  if (!api || !projectId) return false;
  try {
    await api.post(m2routes.preview(projectId), {
      body: { state: body.state, local_url: body.local_url, framework: body.framework, devices: PREVIEW_DEVICES, message: body.message ?? null },
      max429Retries: 0,
    });
    return true;
  } catch (e) {
    debug("preview status report failed", e);
    return false;
  }
}
