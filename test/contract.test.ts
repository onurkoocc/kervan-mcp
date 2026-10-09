import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./helpers.js";
import { listToolsRaw, renderToolsDoc } from "../src/tools-doc.js";

const docText = readFileSync(new URL("../docs/mcp-tools.json", import.meta.url), "utf8");

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe("docs/mcp-tools.json (CustomerTools interface)", () => {
  it("is exactly what the running server returns for tools/list", async () => {
    const res = await h.rpc(await h.mint(), "tools/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result).toEqual(JSON.parse(docText));
  });

  it("is up to date byte for byte (regenerate with npm run docs:tools)", async () => {
    expect(renderToolsDoc(await listToolsRaw())).toBe(docText.replace(/\r\n/g, "\n"));
  });
});
