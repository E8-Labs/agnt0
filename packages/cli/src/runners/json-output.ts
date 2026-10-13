/**
 * Pulls the JSON object a step must print when `output_schema` is set: the last ```json fenced block,
 * then the last other fenced block that parses, then the last top-level `{…}` object in the text.
 */
export function extractJsonOutput(text: string): unknown | undefined {
  const fences = [...text.matchAll(/```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)];
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s.trim());
    } catch {
      return undefined;
    }
  };
  for (const f of [...fences].reverse()) {
    if ((f[1] ?? "").toLowerCase() === "json") {
      const v = tryParse(f[2] ?? "");
      if (v !== undefined) return v;
    }
  }
  for (const f of [...fences].reverse()) {
    const v = tryParse(f[2] ?? "");
    if (v !== undefined && typeof v === "object" && v !== null) return v;
  }
  const objects = topLevelObjects(text);
  for (const o of objects.reverse()) {
    const v = tryParse(o);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Balanced top-level `{…}` spans, string-aware. */
function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}
