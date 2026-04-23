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
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
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
  const tools: McpToolDescriptor[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));

  return {
    client,
    tools,
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const parts = Array.isArray(result.content) ? result.content : [];
      const text = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n");
      if (result.isError) {
        return `[tool error] ${text}`;
      }
      return text || "[empty result]";
    },
    async close() {
      await client.close();
    },
  };
}
