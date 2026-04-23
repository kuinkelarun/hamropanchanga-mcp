import type Anthropic from "@anthropic-ai/sdk";
import type { Response } from "express";
import type { AuthedRequest } from "./auth.js";
import type { McpClientHandle } from "./mcp-client.js";
import { createLlmClientForUser } from "./providers.js";

interface ChatRequestBody {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context?: {
    selectedTreeId?: string;
    selectedTreeTitle?: string;
    selectedMemberId?: string;
    page?: string;
  };
  model?: string;
}

const SYSTEM_PROMPT = `You are the HamroPanchanga assistant. You help users manage their family trees, calendar events, and explore the Hindu lunar calendar (panchanga / tithi).

Use the provided tools whenever the user asks about their data or asks you to create/modify something. For destructive actions (delete_* tools, remove_member), confirm with the user first and pass confirmation=true only after they agree.

When a user asks to connect members into a graph (parent/child/spouse edges), tell them that step is done in the Tree Builder UI — not here.

Dates use YYYY-MM-DD (AD). If the user gives a BS (Nepali) date, use convert_bs_to_ad to translate. "Today" means Nepal Time (Asia/Kathmandu). Use get_today to anchor.`;

export function createChatHandler(mcp: McpClientHandle) {
  return async function chat(req: AuthedRequest, res: Response): Promise<void> {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }

    const body = req.body as ChatRequestBody;
    if (!body?.messages?.length) {
      res.status(400).json({ error: "messages[] required" });
      return;
    }

    let llm;
    try {
      llm = await createLlmClientForUser(uid);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
      return;
    }
    if (!llm) {
      res.status(409).json({
        error: "llm_not_configured",
        message: "Configure your AI provider in Settings before chatting.",
      });
      return;
    }

    const model = body.model ?? llm.defaultModel;

    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: SYSTEM_PROMPT },
      ...(body.context
        ? [
            {
              type: "text" as const,
              text: `Current UI context: ${JSON.stringify(body.context)}`,
            },
          ]
        : []),
    ];

    const tools = mcp.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    const messages: Anthropic.MessageParam[] = body.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const toolResults: Array<{ name: string; input: unknown; result: string }> = [];
    const MAX_HOPS = 6;

    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        const response = await llm.create({
          model,
          max_tokens: 1024,
          system,
          tools: tools as Anthropic.Tool[],
          messages,
        });

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        if (toolUses.length === 0) {
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          res.json({
            reply: text,
            toolCalls: toolResults,
            provider: llm.provider,
            model,
          });
          return;
        }

        messages.push({ role: "assistant", content: response.content });

        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const result = await mcp.callTool(tu.name, tu.input as Record<string, unknown>);
          toolResults.push({ name: tu.name, input: tu.input, result });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: result,
          });
        }
        messages.push({ role: "user", content: toolResultBlocks });
      }

      res.status(500).json({
        error: "tool_hop_limit_exceeded",
        toolCalls: toolResults,
      });
    } catch (err) {
      res.status(502).json({
        error: "llm_request_failed",
        message: (err as Error).message,
        toolCalls: toolResults,
      });
    }
  };
}
