import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "./log.js";
import { createMcpServer } from "./tools.js";
import type { Upstreams } from "./upstream.js";

const unused: Upstreams = {
  core: () => Promise.reject(new Error("not used")),
  search: () => Promise.reject(new Error("not used")),
};

/** The raw `tools/list` result, exactly as the server puts it on the wire. */
export async function listToolsRaw(): Promise<{ tools: unknown[] }> {
  const server = createMcpServer({ upstreams: unused, log: createLogger({ stdout: () => {} }), traceId: "docs" });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const answer = new Promise<JSONRPCMessage>((resolveAnswer) => {
    client.onmessage = resolveAnswer;
  });
  await server.connect(serverSide);
  await client.start();
  await client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const message = await answer;
  await server.close();
  if (!("result" in message)) throw new Error(`tools/list failed: ${JSON.stringify(message)}`);
  return message.result as { tools: unknown[] };
}

export function renderToolsDoc(result: { tools: unknown[] }): string {
  return `${JSON.stringify({ tools: result.tools }, null, 2)}\n`;
}

// `node dist/tools-doc.js` rewrites docs/mcp-tools.json.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolve(fileURLToPath(new URL("../docs/mcp-tools.json", import.meta.url)));
  writeFileSync(target, renderToolsDoc(await listToolsRaw()));
  process.stdout.write(`wrote ${target}\n`);
}
