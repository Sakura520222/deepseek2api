import { randomUUID } from "node:crypto";

import { buildPromptFromMessages } from "../utils/prompt.js";
import { buildToolSystemPrompt, extractToolCalls } from "../utils/tool-prompt.js";
import {
  checkForToolCallMarker,
  collectTaggedContent,
  consumeTaggedStream,
  filterToolCalls,
  isPartialMarker,
  startCompletion,
  TOOL_CALL_MARKERS,
  MARKER_START_CHARS,
  withCompletionSession
} from "./completion-core.js";
import { resolveOpenAiModel, resolveToolCallModel } from "./openai-request.js";

function extractSystemPrompt(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return null;
}

function normalizeAnthropicMessages(messages) {
  return (messages ?? []).flatMap((message) => {
    const content = message.content;

    if (typeof content === "string") {
      return [{ role: message.role, content }];
    }

    if (!Array.isArray(content)) {
      return [{ role: message.role, content: String(content ?? "") }];
    }

    return content.flatMap((block) => {
      if (block.type === "text") {
        return [{ role: message.role, content: block.text ?? "" }];
      }

      if (block.type === "tool_use") {
        const args = typeof block.input === "string"
          ? block.input
          : JSON.stringify(block.input);
        return [{
          role: "assistant",
          content: `[Called tool: ${block.name}]\n<tool_call={"name": "${block.name}", "arguments": ${args}}>`
        }];
      }

      if (block.type === "tool_result") {
        const resultText = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b) => b.type === "text" ? b.text : "").filter(Boolean).join("\n")
            : "";
        const toolUseId = block.tool_use_id ?? "unknown";
        return [{
          role: "tool",
          content: `[Tool Result for ${toolUseId}]\n${resultText}`
        }];
      }

      if (block.text) {
        return [{ role: message.role, content: block.text }];
      }
      return [];
    });
  });
}

function normalizeAnthropicTools(tools) {
  if (!tools?.length) return null;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? {}
    }
  }));
}

function normalizeAnthropicToolChoice(toolChoice) {
  if (!toolChoice) return null;
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { function: { name: toolChoice.name } };
  }
  return "auto";
}

function resolveAnthropicRequest(body) {
  const tools = normalizeAnthropicTools(body.tools);
  const toolChoice = normalizeAnthropicToolChoice(body.tool_choice);
  const systemPrompt = extractSystemPrompt(body.system);
  const toolPrompt = (tools?.length && toolChoice !== "none")
    ? buildToolSystemPrompt(tools, toolChoice)
    : null;

  const combinedSystem = [systemPrompt, toolPrompt].filter(Boolean).join("\n\n") || null;
  const messages = normalizeAnthropicMessages(body.messages);
  const allMessages = combinedSystem
    ? [{ role: "system", content: combinedSystem }, ...messages]
    : messages;

  const resolvedModel = resolveOpenAiModel(body.model);
  const model = tools?.length ? resolveToolCallModel(resolvedModel) : resolvedModel;

  return {
    model,
    prompt: buildPromptFromMessages(allMessages, null),
    tools,
    modelName: body.model ?? "deepseek-chat-fast"
  };
}

function formatAnthropicContent(toolCalls, content, reasoningContent) {
  const contentBlocks = [];

  if (reasoningContent) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoningContent,
      signature: ""
    });
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      let input;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input
      });
    }
  } else {
    contentBlocks.push({
      type: "text",
      text: content
    });
  }

  return contentBlocks;
}

export async function collectAnthropicMessage({ account, body, deleteAfterFinish, debugCtx }) {
  const requestOptions = resolveAnthropicRequest(body);
  debugCtx?.logResolved(requestOptions.model, account, !!requestOptions.tools);

  return withCompletionSession({
    account,
    body,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      const { response } = await startCompletion({ account, requestOptions, sessionId, debugCtx });
      const { content, reasoningContent } = await collectTaggedContent(response.body, debugCtx);

      const rawToolCalls = extractToolCalls(content, debugCtx);
      const toolCalls = requestOptions.tools
        ? filterToolCalls(rawToolCalls, requestOptions.tools)
        : rawToolCalls;

      const contentBlocks = formatAnthropicContent(toolCalls, content, reasoningContent);

      return {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: requestOptions.modelName,
        content: contentBlocks,
        stop_reason: toolCalls ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      };
    }
  });
}

function writeSSE(response, eventType, data) {
  response.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function streamAnthropicMessage({ response, account, body, deleteAfterFinish, debugCtx }) {
  const messageId = `msg_${randomUUID()}`;
  const requestOptions = resolveAnthropicRequest(body);
  const modelName = requestOptions.modelName;
  debugCtx?.logResolved(requestOptions.model, account, !!requestOptions.tools);

  return withCompletionSession({
    account,
    body,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      const { response: dsResponse } = await startCompletion({ account, requestOptions, sessionId, debugCtx });

      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      response.flushHeaders?.();

      writeSSE(response, "message_start", {
        type: "message_start",
        message: {
          id: messageId, type: "message", role: "assistant",
          model: modelName, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });

      writeSSE(response, "ping", { type: "ping" });

      let blockIndex = 0;
      let reasoningBlockOpen = false;
      let textBlockOpen = false;
      let textAccumulator = "";
      let toolCallDetected = false;
      let toolCallBuffer = "";
      let decidedAsText = false;
      let hasToolCalls = false;

      function startThinkingBlock() {
        if (reasoningBlockOpen) return;
        reasoningBlockOpen = true;
        writeSSE(response, "content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "thinking", thinking: "" }
        });
      }

      function closeThinkingBlock() {
        if (!reasoningBlockOpen) return;
        reasoningBlockOpen = false;
        writeSSE(response, "content_block_stop", {
          type: "content_block_stop", index: blockIndex
        });
        blockIndex++;
      }

      function startTextBlock() {
        if (textBlockOpen) return;
        textBlockOpen = true;
        writeSSE(response, "content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" }
        });
      }

      function closeTextBlock() {
        if (!textBlockOpen) return;
        textBlockOpen = false;
        writeSSE(response, "content_block_stop", {
          type: "content_block_stop", index: blockIndex
        });
        blockIndex++;
      }

      await consumeTaggedStream(dsResponse.body, (tagged) => {
        if (tagged.kind === "thinking") {
          startThinkingBlock();
          writeSSE(response, "content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "thinking_delta", thinking: tagged.text }
          });
          return;
        }

        const text = tagged.text;
        if (reasoningBlockOpen) {
          closeThinkingBlock();
        }
        if (toolCallDetected) {
          toolCallBuffer += text;
          return;
        }

        textAccumulator += text;
        const markerIndex = checkForToolCallMarker(textAccumulator);
        if (markerIndex !== -1) {
          debugCtx?.logToolDetection({
            markerFound: true,
            markerIndex,
            textBeforeMarker: textAccumulator.slice(0, markerIndex).slice(-100),
            markerPrefix: textAccumulator.slice(markerIndex, markerIndex + 30)
          });
          toolCallDetected = true;
          toolCallBuffer = textAccumulator.slice(markerIndex);
          const before = textAccumulator.slice(0, markerIndex);
          textAccumulator = "";
          if (before) {
            startTextBlock();
            writeSSE(response, "content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text: before }
            });
          }
          return;
        }

        let safeEnd = textAccumulator.length;
        if (isPartialMarker(textAccumulator)) {
          for (let i = Math.max(0, textAccumulator.length - 20); i < textAccumulator.length; i++) {
            if (!MARKER_START_CHARS.includes(textAccumulator[i])) continue;
            const tail = textAccumulator.slice(i);
            let isPartial = false;
            for (const marker of TOOL_CALL_MARKERS) {
              if (marker.startsWith(tail)) { isPartial = true; break; }
            }
            if (tail.startsWith("```")) { isPartial = true; }
            if (tail.startsWith('{"na')) { isPartial = true; }
            if (isPartial) { safeEnd = i; break; }
          }
        }
        const toStream = textAccumulator.slice(0, safeEnd);
        textAccumulator = textAccumulator.slice(safeEnd);

        if (toStream) {
          decidedAsText = true;
          startTextBlock();
          writeSSE(response, "content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: toStream }
          });
        }
      }, debugCtx);

      if (textAccumulator && !toolCallDetected) {
        if (decidedAsText) {
          const markerIdx = checkForToolCallMarker(textAccumulator);
          if (markerIdx !== -1) {
            const before = textAccumulator.slice(0, markerIdx);
            if (before) {
              startTextBlock();
              writeSSE(response, "content_block_delta", {
                type: "content_block_delta", index: blockIndex,
                delta: { type: "text_delta", text: before }
              });
            }
            toolCallDetected = true;
            toolCallBuffer = textAccumulator.slice(markerIdx);
            textAccumulator = "";
          }
        }
        if (textAccumulator && !toolCallDetected) {
          startTextBlock();
          writeSSE(response, "content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: textAccumulator }
          });
          textAccumulator = "";
        }
      }

      closeThinkingBlock();
      closeTextBlock();

      if (toolCallDetected) {
        const rawToolCalls = extractToolCalls(toolCallBuffer, debugCtx);
        const toolCalls = requestOptions.tools ? filterToolCalls(rawToolCalls, requestOptions.tools) : rawToolCalls;
        debugCtx?.logToolDetection({
          toolCallBufferLength: toolCallBuffer.length,
          rawToolCallCount: rawToolCalls?.length ?? 0,
          filteredToolCallCount: toolCalls?.length ?? 0,
          toolCalls: toolCalls?.map(tc => ({ name: tc.function.name, id: tc.id })) ?? []
        });
        if (toolCalls) {
          hasToolCalls = true;
          for (const tc of toolCalls) {
            let input;
            try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }

            writeSSE(response, "content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} }
            });
            writeSSE(response, "content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments }
            });
            writeSSE(response, "content_block_stop", {
              type: "content_block_stop", index: blockIndex
            });
            blockIndex++;
          }
        } else {
          startTextBlock();
          writeSSE(response, "content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: toolCallBuffer }
          });
          closeTextBlock();
        }
      }

      debugCtx?.logFinalResponse({ stop_reason: hasToolCalls ? "tool_use" : "end_turn" });

      writeSSE(response, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 }
      });
      writeSSE(response, "message_stop", { type: "message_stop" });

      response.end();
    }
  });
}
