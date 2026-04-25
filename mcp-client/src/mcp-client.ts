import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface McpClientHandle {
  client: Client;
  tools: McpToolDescriptor[];
  callTool: (name: string, args: Record<string, unknown>, uid?: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function connectMcpServer(opts: {
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<McpClientHandle> {
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env: opts.env,
  });

  const client = new Client(
    { name: "hamropanchanga-chat-backend", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const listed = await client.listTools();
  // Filter out internal tools that are not meant to be exposed to the LLM.
  const tools: McpToolDescriptor[] = listed.tools
    .filter((t) => !t.name.startsWith("_"))
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));

  // Serialize all tool calls through this queue to prevent race conditions
  // when multiple concurrent requests share a single stdio MCP subprocess.
  let callQueue: Promise<unknown> = Promise.resolve();

  return {
    client,
    tools,
    async callTool(name, args, uid?) {
      const rawResult = await (callQueue = callQueue.then(async () => {
        if (uid) {
          // Set the user's auth context on the server before the real tool call.
          await client.callTool({ name: "_set_auth_uid", arguments: { uid } });
        }
        return client.callTool({ name, arguments: args });
      })) as Awaited<ReturnType<typeof client.callTool>>;
      const parts = Array.isArray(rawResult.content) ? rawResult.content : [];
      const text = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n");
      if (rawResult.isError) {
        return `[tool error] ${text}`;
      }
      return text || "[empty result]";
    },
    async close() {
      await client.close();
    },
  };
}
