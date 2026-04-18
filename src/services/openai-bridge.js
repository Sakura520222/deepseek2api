import { randomUUID } from "node:crypto";

import { createDeepseekDeltaDecoder, createSseParser } from "../utils/deepseek-sse.js";
import { buildPromptFromMessages } from "../utils/prompt.js";
import { buildToolSystemPrompt, createToolCallStreamParser, extractToolCalls } from "../utils/tool-prompt.js";
import { createChatSession, deleteChatSession } from "./chat-session-service.js";
import { proxyDeepseekRequest } from "./deepseek-proxy.js";
import { assertNoLegacySearchOptions, resolveOpenAiModel } from "./openai-request.js";

const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";

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
      const calls = message.tool_calls.map(normalizeToolCall).join("\n");
      return [{ role: "assistant", content: content ? `${content}\n${calls}` : calls }];
    }
    if (message.role === "tool") {
      return [{ role: "tool", content: `TOOL_RESULT: ${toContentText(message.content)}` }];
    }
    return [{ role: message.role ?? "user", content: toContentText(message.content) }];
  });
}

function resolveCompletionRequest(body) {
  assertNoLegacySearchOptions(body);

  const tools = body?.tools;
  const toolChoice = body?.tool_choice;
  const toolPrompt = (tools?.length && toolChoice !== "none")
    ? buildToolSystemPrompt(tools, toolChoice)
    : null;

  return {
    model: resolveOpenAiModel(body?.model),
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

function createThinkingTagger() {
  let currentKind = null;

  return {
    push(delta) {
      if (!delta?.text) {
        return "";
      }

      let prefix = "";
      if (delta.kind !== currentKind) {
        if (currentKind === "thinking") {
          prefix += THINK_CLOSE_TAG;
        }
        if (delta.kind === "thinking") {
          prefix += THINK_OPEN_TAG;
        }
        currentKind = delta.kind;
      }

      return prefix + delta.text;
    },
    flush() {
      if (currentKind !== "thinking") {
        return "";
      }

      currentKind = "response";
      return THINK_CLOSE_TAG;
    }
  };
}

async function consumeTaggedStream(stream, onText) {
  if (!stream) {
    return;
  }

  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();
  const tagger = createThinkingTagger();
  const parser = createSseParser(({ data }) => {
    const text = tagger.push(deltaDecoder.consume(data));
    if (text) {
      onText(text);
    }
  });

  for await (const chunk of stream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();

  const suffix = tagger.flush();
  if (suffix) {
    onText(suffix);
  }
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

      await consumeTaggedStream(response.body, (text) => {
        content += text;
      });

      const toolCalls = requestOptions.tools ? extractToolCalls(content) : null;

      if (toolCalls) {
        return {
          id: `chatcmpl_${randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: requestOptions.model.id,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: toolCalls
              }
            }
          ]
        };
      }

      return {
        id: `chatcmpl_${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestOptions.model.id,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content
            }
          }
        ]
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
        let emittedToolCalls = false;

        const parser = createToolCallStreamParser(
          (toolCalls) => {
            emittedToolCalls = true;
            response.write(
              `data: ${JSON.stringify(buildToolCallChunkPayload(completionId, requestOptions.model.id, toolCalls))}\n\n`
            );
            response.write(
              `data: ${JSON.stringify(buildToolCallChunkPayload(completionId, requestOptions.model.id, [], "tool_calls"))}\n\n`
            );
          },
          (delta) => {
            response.write(
              `data: ${JSON.stringify(buildChunkPayload(
                completionId,
                requestOptions.model.id,
                { content: delta }
              ))}\n\n`
            );
          }
        );

        await consumeTaggedStream(deepseekResponse.body, (text) => {
          parser.push(text);
        });
        parser.flush();

        if (!emittedToolCalls) {
          response.write(
            `data: ${JSON.stringify(buildChunkPayload(completionId, requestOptions.model.id, "", "stop"))}\n\n`
          );
        }
      } else {
        await consumeTaggedStream(deepseekResponse.body, (delta) => {
          response.write(
            `data: ${JSON.stringify(buildChunkPayload(
              completionId,
              requestOptions.model.id,
              { content: delta }
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
