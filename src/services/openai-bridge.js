import { randomUUID } from "node:crypto";

import { createDeepseekDeltaDecoder, createSseParser } from "../utils/deepseek-sse.js";
import { buildPromptFromMessages } from "../utils/prompt.js";
import { buildToolSystemPrompt, extractToolCalls } from "../utils/tool-prompt.js";
import { createChatSession, deleteChatSession } from "./chat-session-service.js";
import { proxyDeepseekRequest } from "./deepseek-proxy.js";
import { assertNoLegacySearchOptions, resolveOpenAiModel, resolveToolCallModel } from "./openai-request.js";

function toContentText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => (item?.type === "text" ? item.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function normalizeToolCall(toolCall) {
  const args = typeof toolCall.function.arguments === "string"
    ? toolCall.function.arguments
    : JSON.stringify(toolCall.function.arguments);
  return `<tool_call={"name": "${toolCall.function.name}", "arguments": ${args}}`;
}

function normalizeMessages(messages) {
  return (messages ?? []).flatMap((message) => {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const content = message.content ?? "";
      const calls = message.tool_calls.map((tc) =>
        `[Called tool: ${tc.function.name}]\n${normalizeToolCall(tc)}`
      ).join("\n");
      return [{ role: "assistant", content: content ? `${content}\n${calls}` : calls }];
    }
    if (message.role === "tool") {
      const resultText = toContentText(message.content);
      const toolName = message.name || "unknown";
      const callId = message.tool_call_id ? ` (call ${message.tool_call_id})` : "";
      return [{ role: "tool", content: `[Tool Result for "${toolName}"${callId}]\n${resultText}` }];
    }
    return [{ role: message.role ?? "user", content: toContentText(message.content) }];
  });
}

function filterToolCalls(toolCalls, tools) {
  if (!toolCalls || !tools) return null;

  const validNames = tools.map((t) => t.function?.name).filter(Boolean);

  const filtered = toolCalls.map((tc) => {
    if (validNames.includes(tc.function.name)) return tc;

    // Fuzzy: case-insensitive, underscore/hyphen interchange
    const tcLower = tc.function.name.toLowerCase().replace(/-/g, "_");
    const match = validNames.find((name) => {
      const nameLower = name.toLowerCase().replace(/-/g, "_");
      return nameLower === tcLower
        || name.endsWith("__" + tc.function.name)
        || name.endsWith("." + tc.function.name);
    });
    if (match) return { ...tc, function: { ...tc.function, name: match } };

    return null;
  }).filter(Boolean);

  return filtered.length > 0 ? filtered : null;
}

function resolveCompletionRequest(body) {
  assertNoLegacySearchOptions(body);

  const tools = body?.tools;
  const toolChoice = body?.tool_choice;
  const toolPrompt = (tools?.length && toolChoice !== "none")
    ? buildToolSystemPrompt(tools, toolChoice)
    : null;

  const resolvedModel = resolveOpenAiModel(body?.model);
  const model = (tools?.length) ? resolveToolCallModel(resolvedModel) : resolvedModel;

  return {
    model,
    prompt: buildPromptFromMessages(normalizeMessages(body?.messages), toolPrompt),
    tools: tools || null
  };
}

async function startCompletion({ account, requestOptions, sessionId }) {
  return proxyDeepseekRequest({
    account,
    method: "POST",
    path: "/api/v0/chat/completion",
    body: Buffer.from(
      JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: requestOptions.model.modelType,
        prompt: requestOptions.prompt,
        ref_file_ids: [],
        thinking_enabled: requestOptions.model.thinkingEnabled,
        search_enabled: requestOptions.model.searchEnabled,
        preempt: false
      })
    ),
    headers: { "content-type": "application/json" }
  });
}

async function consumeTaggedStream(stream, onTagged) {
  if (!stream) {
    return;
  }

  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();
  const parser = createSseParser(({ data }) => {
    const delta = deltaDecoder.consume(data);
    if (delta?.text) {
      onTagged({ kind: delta.kind, text: delta.text });
    }
  });

  for await (const chunk of stream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
}

function buildChunkPayload(completionId, model, delta, finishReason) {
  const choice = finishReason
    ? { index: 0, delta: {}, finish_reason: finishReason }
    : { index: 0, delta };

  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice]
  };
}

async function withCompletionSession({ account, body, deleteAfterFinish, onComplete }) {
  const sessionId = await createChatSession(account);

  try {
    return await onComplete(sessionId);
  } finally {
    if (deleteAfterFinish) {
      await deleteChatSession(account, sessionId);
    }
  }
}

export async function collectOpenAiResponse({ account, body, deleteAfterFinish = false }) {
  const requestOptions = resolveCompletionRequest(body);

  return withCompletionSession({
    account,
    body,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      const { response } = await startCompletion({ account, requestOptions, sessionId });
      let content = "";
      let reasoningContent = "";

      await consumeTaggedStream(response.body, (tagged) => {
        if (tagged.kind === "thinking") {
          reasoningContent += tagged.text;
        } else {
          content += tagged.text;
        }
      });

      const toolCalls = requestOptions.tools ? filterToolCalls(extractToolCalls(content), requestOptions.tools) : null;

      if (toolCalls) {
        const message = {
          role: "assistant",
          content: null,
          tool_calls: toolCalls
        };
        if (reasoningContent) {
          message.reasoning_content = reasoningContent;
        }
        return {
          id: `chatcmpl_${randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: requestOptions.model.id,
          choices: [{ index: 0, finish_reason: "tool_calls", message }]
        };
      }

      const message = {
        role: "assistant",
        content
      };
      if (reasoningContent) {
        message.reasoning_content = reasoningContent;
      }
      return {
        id: `chatcmpl_${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestOptions.model.id,
        choices: [{ index: 0, finish_reason: "stop", message }]
      };
    }
  });
}

function buildToolCallChunkPayload(completionId, model, toolCalls, finishReason) {
  const toolCallDeltas = toolCalls.map((tc, index) => ({
    index,
    id: tc.id,
    type: "function",
    function: { name: tc.function.name, arguments: tc.function.arguments }
  }));

  const choice = finishReason
    ? { index: 0, delta: {}, finish_reason: finishReason }
    : { index: 0, delta: { tool_calls: toolCallDeltas } };

  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice]
  };
}

const TOOL_CALL_MARKERS = ["<tool_call", "<function_call"];

function findToolCallMarker(text) {
  let earliest = -1;
  for (const marker of TOOL_CALL_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

function isPartialMarker(text) {
  for (const marker of TOOL_CALL_MARKERS) {
    for (let i = Math.max(0, text.length - marker.length); i < text.length; i++) {
      if (text[i] !== "<") continue;
      const tail = text.slice(i);
      if (marker.startsWith(tail)) return true;
    }
  }
  return false;
}

export async function streamOpenAiResponse(options) {
  const { account, body, deleteAfterFinish = false, response } = options;
  const completionId = `chatcmpl_${randomUUID()}`;
  const requestOptions = resolveCompletionRequest(body);

  return withCompletionSession({
    account,
    body,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      const { response: deepseekResponse } = await startCompletion({
        account,
        requestOptions,
        sessionId
      });

      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      response.flushHeaders?.();

      response.write(
        `data: ${JSON.stringify(buildChunkPayload(
          completionId,
          requestOptions.model.id,
          { role: "assistant" }
        ))}\n\n`
      );

      if (requestOptions.tools) {
        let toolCallDetected = false;
        let toolCallBuffer = "";
        let textBuffer = "";

        await consumeTaggedStream(deepseekResponse.body, (tagged) => {
          if (tagged.kind === "thinking") {
            response.write(
              `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, { reasoning_content: tagged.text }))}\n\n`
            );
            return;
          }

          const text = tagged.text;

          if (toolCallDetected) {
            toolCallBuffer += text;
            return;
          }

          textBuffer += text;

          const markerIndex = findToolCallMarker(textBuffer);
          if (markerIndex !== -1) {
            toolCallDetected = true;
            const before = textBuffer.slice(0, markerIndex);
            if (before) {
              response.write(
                `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, { content: before }))}\n\n`
              );
            }
            toolCallBuffer = textBuffer.slice(markerIndex);
            textBuffer = "";
            return;
          }

          // Safe streaming: hold back partial marker prefixes
          let safeEnd = textBuffer.length;
          if (isPartialMarker(textBuffer)) {
            for (let i = Math.max(0, textBuffer.length - 20); i < textBuffer.length; i++) {
              if (textBuffer[i] !== "<" && textBuffer[i] !== "`") continue;
              const tail = textBuffer.slice(i);
              let isPartial = false;
              for (const marker of TOOL_CALL_MARKERS) {
                if (marker.startsWith(tail)) { isPartial = true; break; }
              }
              if (tail.startsWith("```")) { isPartial = true; }
              if (isPartial) { safeEnd = i; break; }
            }
          }

          const toStream = textBuffer.slice(0, safeEnd);
          textBuffer = textBuffer.slice(safeEnd);

          if (toStream) {
            response.write(
              `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, { content: toStream }))}\n\n`
            );
          }
        });

        if (textBuffer && !toolCallDetected) {
          response.write(
            `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, { content: textBuffer }))}\n\n`
          );
        }

        if (toolCallDetected) {
          const toolCalls = filterToolCalls(extractToolCalls(toolCallBuffer), requestOptions.tools);
          if (toolCalls) {
            response.write(
              `data: ${JSON.stringify(buildToolCallChunkPayload(completionId, requestOptions.model.id, toolCalls))}\n\n`
            );
            response.write(
              `data: ${JSON.stringify(buildToolCallChunkPayload(completionId, requestOptions.model.id, [], "tool_calls"))}\n\n`
            );
          } else {
            response.write(
              `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, { content: toolCallBuffer }))}\n\n`
            );
            response.write(
              `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, "", "stop"))}\n\n`
            );
          }
        } else {
          response.write(
            `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, "", "stop"))}\n\n`
          );
        }
      } else {
        await consumeTaggedStream(deepseekResponse.body, (tagged) => {
          const delta = tagged.kind === "thinking"
            ? { reasoning_content: tagged.text }
            : { content: tagged.text };
          response.write(
            `data: ${JSON.stringify(buildChunkPayload(
              completionId,
              requestOptions.model.id,
              delta
            ))}\n\n`
          );
        });

        response.write(
          `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, "", "stop"))}\n\n`
        );
      }

      response.end("data: [DONE]\n\n");
    }
  });
}
