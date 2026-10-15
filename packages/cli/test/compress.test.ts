import { describe, expect, it } from "vitest";
import { compress, compressCsv, compressJson, compressLogs, compressTest, detect, MIN_BYTES } from "../src/compress/index.js";

const repeat = (line: string, n: number) => Array.from({ length: n }, (_, i) => line.replace("#", String(i))).join("\n");

describe("detect", () => {
  it("tells the kinds apart", () => {
    expect(detect(JSON.stringify({ a: [1, 2, 3] }))).toBe("json");
    expect(detect("name,age,city\na,1,x\nb,2,y\nc,3,z\nd,4,w")).toBe("csv");
    expect(detect("✓ adds\n✓ subtracts\n✗ divides\n2 passing 1 failing")).toBe("test");
    expect(detect(repeat("2026-10-15T10:00:00Z GET /x 200", 20))).toBe("logs");
    expect(detect("")).toBeNull();
    // A short, shapeless blob is not worth classifying.
    expect(detect("hello\nthere")).toBeNull();
  });
});

describe("logs", () => {
  it("collapses repetition but never drops a signal", () => {
    const text = [repeat("GET /health 200 in #ms", 400), "ERROR: connection refused to db:5432", repeat("GET /health 200 in #ms", 100)].join("\n");
    const out = compressLogs(text);
    expect(out).toContain("ERROR: connection refused");
    expect(out).toMatch(/× \d+/);
    expect(out.length).toBeLessThan(text.length / 5);
  });

  it("keeps the head, the tail and the line either side of an error", () => {
    const lines = [...Array.from({ length: 200 }, (_, i) => `step ${i} ok`), "at handler (src/app.ts:42)", "TypeError: x is not a function", "done"];
    const out = compressLogs(lines.join("\n"));
    expect(out).toContain("step 0 ok");
    expect(out).toContain("TypeError: x is not a function");
    // The line above an error is usually where the stack starts.
    expect(out).toContain("at handler (src/app.ts:42)");
    expect(out).toContain("done");
    // The 200 identical "step N ok" lines are one run, not 200 lines of noise.
    expect(out).toContain("× 200");
    expect(out.split("\n").length).toBeLessThan(8);
  });
});

describe("json", () => {
  it("keeps every key and trims the bulk", () => {
    const text = JSON.stringify({
      ok: true,
      error: null,
      items: Array.from({ length: 900 }, (_, i) => ({ id: i, name: `item ${i}` })),
      note: "x".repeat(5000),
    });
    const out = compressJson(text);
    const parsed = JSON.parse(out) as { ok: boolean; error: null; items: unknown[]; note: string };
    expect(Object.keys(parsed)).toEqual(["ok", "error", "items", "note"]);
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toHaveLength(4); // three items plus the marker
    expect(String(parsed.items[3])).toContain("+897 more items");
    expect(parsed.note).toContain("+4800 chars");
    expect(out.length).toBeLessThan(text.length / 10);
  });

  it("leaves text it cannot parse alone", () => {
    expect(compressJson("{not json")).toBe("{not json");
  });
});

describe("test output", () => {
  it("keeps failures and the summary, counts the passes", () => {
    const text = [
      ...Array.from({ length: 120 }, (_, i) => `✓ does the thing ${i}`),
      "✗ rejects an expired token",
      "    expected 401, got 200",
      "    at test/auth.test.ts:31",
      "120 passing",
      "1 failing",
    ].join("\n");
    const out = compressTest(text);
    expect(out).toContain("✗ rejects an expired token");
    expect(out).toContain("expected 401, got 200");
    expect(out).toContain("at test/auth.test.ts:31");
    expect(out).toContain("120 passing");
    expect(out).toContain("passing test lines not shown");
    expect(out).not.toContain("does the thing 7");
  });
});

describe("csv", () => {
  it("keeps the header and a sample, and says how much there was", () => {
    const rows = ["id,name,email", ...Array.from({ length: 5000 }, (_, i) => `${i},name ${i},a${i}@example.com`)];
    const out = compressCsv(rows.join("\n"));
    expect(out.split("\n")[0]).toBe("id,name,email");
    expect(out).toContain("3 columns");
    expect(out).toContain("5000 data rows");
    expect(out.length).toBeLessThan(rows.join("\n").length / 50);
  });
});

describe("compress", () => {
  const kinds = ["logs", "json", "test", "csv"] as const;

  it("does nothing to short output", () => {
    const text = "all good\n";
    const r = compress(text, { kinds: [...kinds] });
    expect(r.text).toBe(text);
    expect(r.kind).toBeNull();
    expect(r.sentBytes).toBe(r.rawBytes);
  });

  it("does nothing to a kind the step did not allow", () => {
    const text = JSON.stringify({ items: Array.from({ length: 900 }, (_, i) => i) });
    expect(text.length).toBeGreaterThan(MIN_BYTES);
    expect(compress(text, { kinds: ["logs"] }).kind).toBeNull();
    expect(compress(text, { kinds: ["json"] }).kind).toBe("json");
  });

  it("says where the original is, so nothing is actually lost", () => {
    const text = repeat("GET /health 200 in #ms", 500);
    const r = compress(text, { kinds: [...kinds], originalPath: "/tmp/agnt0/out/7.txt" });
    expect(r.kind).toBe("logs");
    expect(r.text).toContain("/tmp/agnt0/out/7.txt");
    // The note has to answer "did anything go wrong?", or the agent re-runs the command to find out.
    expect(r.text).toContain("no line mentioning an error, warning or failure");
    expect(r.text).toMatch(/\d+ lines of logs output shown as \d+/);
    expect(r.sentBytes).toBeLessThan(r.rawBytes);
  });

  it("passes the original through when compressing would not be a clear win", () => {
    // A signal on every line: nothing may be collapsed, so there is nothing to take out.
    const text = Array.from({ length: 60 }, (_, i) => `ERROR ${i}: ${"detail ".repeat(8)}${i}`).join("\n");
    const r = compress(text, { kinds: [...kinds] });
    expect(r.text).toBe(text);
    expect(r.kind).toBeNull();
  });
});
