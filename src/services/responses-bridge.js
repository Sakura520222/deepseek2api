import { randomUUID } from "node:crypto";

import { buildPromptFromMessages } from "../utils/prompt.js";
import { buildToolSystemPrompt, extractToolCalls } from "../utils/tool-prompt.js";
import {
  collectTaggedContent,
  consumeTaggedStream,
  filterToolCalls,
  findToolCallMarker,
  isPartialMarker,
  startCompletion,
  TOOL_CALL_MARKERS,
  withCompletionSession
} from "./completion-core.js";
import { resolveOpenAiModel, resolveToolCallModel } from "./openai-request.js";

function toContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (item?.type === "output_text") return item.text ?? "";
      if (item?.type === "input_text") return item.text ?? "";
      if (item?.type === "text") return item.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeResponsesInput(input, instructions) {
  const messages = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const items = typeof input === "string"
    ? [{ role: "user", content: input }]
    : Array.isArray(input) ? input : [];

  for (const item of items) {
    if (item.type === "message" && item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      messages.push({ role, content: toContentText(item.content) });
      continue;
    }

    if (item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      messages.push({ role, content: toContentText(item.content) });
      continue;
    }

    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: `[Called tool: ${item.name}]\n<tool_call={"name": "${item.name}", "arguments": ${item.arguments ?? "{}"}}`
      });
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        content: `[Tool Result for call ${item.call_id ?? "unknown"}]\n${typeof item.output === "string" ? item.output : JSON.stringify(item.output)}`
      });
    }
  }

  return messages;
}

function normalizeResponsesTools(tools) {
  if (!tools?.length) return null;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? {}
      }
    }));
}

function normalizeResponsesToolChoice(toolChoice, tools) {
  if (!tools?.length) return null;
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (toolChoice.type === "function" && toolChoice.name) {
    return { function: { name: toolChoice.name } };
  }
  return "auto";
}

function resolveResponsesRequest(body) {
  const tools = normalizeResponsesTools(body.tools);
  const toolChoice = normalizeResponsesToolChoice(body.tool_choice, tools);
  const toolPrompt = (tools?.length && toolChoice !== "none")
    ? buildToolSystemPrompt(tools, toolChoice)
    : null;

  const messages = normalizeResponsesInput(body.input, body.instructions);
  const resolvedModel = resolveOpenAiModel(body.model);
  const model = tools?.length ? resolveToolCallModel(resolvedModel) : resolvedModel;

  return {
    model,
    prompt: buildPromptFromMessages(messages, toolPrompt),
    tools
  };
}

function formatReasoningItem(reasoningContent) {
  return {
    type: "reasoning",
    id: `rs_${randomUUID()}`,
    summary: [{ type: "summary_text", text: reasoningContent }]
  };
}

function formatMessageItem(content) {
  return {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    content: [{ type: "output_text", text: content }],
    status: "completed"
  };
}

function formatFunctionCallItem(tc) {
  return {
    type: "function_call",
    id: `fc_${randomUUID()}`,
    call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
    status: "completed"
  };
}

function buildResponsesOutput(toolCalls, content, reasoningContent) {
  const output = [];

  if (reasoningContent) {
    output.push(formatReasoningItem(reasoningContent));
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push(formatFunctionCallItem(tc));
    }
  } else {
    output.push(formatMessageItem(content));
  }

  return output;
}

export async function collectResponsesResult({ account, body, deleteAfterFinish }) {
  const requestOptions = resolveResponsesRequest(body);

  return withCompletionSession({
    account,
    body,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      const { response } = await startCompletion({ account, requestOptions, sessionId });
      const { content, reasoningContent } = await collectTaggedContent(response.body);

      const toolCalls = requestOptions.tools
        ? filterToolCalls(extractToolCalls(content), requestOptions.tools)
        : null;

      const output = buildResponsesOutput(toolCalls, content, reasoningContent);
      const now = Math.floor(Date.now() / 1000);

      return {
        id: `resp_${randomUUID()}`,
        object: "response",
        created_at: now,
        status: "completed",
        completed_at: now,
        model: requestOptions.model.id,
        output,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      };
    }
  });
}

function createSseWriter(response) {
  let seq = 0;
  return function writeSSE(event, data) {
    const payload = { type: event, sequence_number: seq++, ...data };
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
}

function emitResponseTextChunk(writeSSE, outIdx, text, state) {
  if (!state.messageItemId) {
    state.messageItemId = `msg_${randomUUID()}`;
    writeSSE("response.output_item.added", {
      output_index: outIdx,
      item: { id: state.messageItemId, type: "message", role: "assistant", content: [] }
    });
    writeSSE("response.content_part.added", {
      item_id: state.messageItemId,
      output_index: outIdx,
      content_index: 0,
      part: { type: "output_text", text: "" }
    });
  }
  writeSSE("response.output_text.delta", {
    item_id: state.messageItemId,
    output_index: outIdx,
    content_index: 0,
    delta: text
  });
  state.textAccumulator += text;
}

export async function streamResponsesResult({ response, account, body, deleteAfterFinish }) {
  const responseId = `resp_${randomUUID()}`;
  const requestOptions = resolveResponsesRequest(body);
  const modelId = requestOptions.model.id;
  const created = Math.floor(Date.now() / 1000);

  return withCompletionSession({
    account,
    body,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      const { response: dsResponse } = await startCompletion({ account, requestOptions, sessionId });

      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      response.flushHeaders?.();

      const baseResponse = {
        id: responseId, object: "response", created_at: created,
        status: "in_progress", model: modelId, output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      };

      const writeSSE = createSseWriter(response);

      writeSSE("response.created", { response: baseResponse });
      writeSSE("response.in_progress", { response: baseResponse });

      const state = {
        reasoningItemId: null,
        messageItemId: null,
        textAccumulator: "",
        reasoningAccumulator: "",
        toolCallDetected: false,
        toolCallBuffer: ""
      };

      const textOutputBaseIdx = () => state.reasoningItemId ? 1 : 0;

      function emitTextChunk(text) {
        emitResponseTextChunk(writeSSE, textOutputBaseIdx(), text, state);
      }

      if (requestOptions.tools) {
        await consumeTaggedStream(dsResponse.body, (tagged) => {
          if (tagged.kind === "thinking") {
            if (!state.reasoningItemId) {
              state.reasoningItemId = `rs_${randomUUID()}`;
              writeSSE("response.output_item.added", {
                output_index: 0,
                item: { type: "reasoning", id: state.reasoningItemId, summary: [] }
              });
            }
            writeSSE("response.reasoning_text.delta", {
              item_id: state.reasoningItemId,
              output_index: 0, delta: tagged.text
            });
            state.reasoningAccumulator += tagged.text;
            return;
          }

          const text = tagged.text;
          if (state.toolCallDetected) {
            state.toolCallBuffer += text;
            return;
          }

          state.textAccumulator += text;
          const markerIndex = findToolCallMarker(state.textAccumulator);
          if (markerIndex !== -1) {
            state.toolCallDetected = true;
            state.toolCallBuffer = state.textAccumulator.slice(markerIndex);
            const before = state.textAccumulator.slice(0, markerIndex);
            state.textAccumulator = "";
            if (before) emitTextChunk(before);
            return;
          }

          let safeEnd = state.textAccumulator.length;
          if (isPartialMarker(state.textAccumulator)) {
            for (let i = Math.max(0, state.textAccumulator.length - 20); i < state.textAccumulator.length; i++) {
              if (state.textAccumulator[i] !== "<" && state.textAccumulator[i] !== "`") continue;
              const tail = state.textAccumulator.slice(i);
              let isPartial = false;
              for (const marker of TOOL_CALL_MARKERS) {
                if (marker.startsWith(tail)) { isPartial = true; break; }
              }
              if (tail.startsWith("```")) { isPartial = true; }
              if (isPartial) { safeEnd = i; break; }
            }
          }
          const toStream = state.textAccumulator.slice(0, safeEnd);
          state.textAccumulator = state.textAccumulator.slice(safeEnd);
          if (toStream) emitTextChunk(toStream);
        });

        if (state.textAccumulator && !state.toolCallDetected) {
          emitTextChunk(state.textAccumulator);
          state.textAccumulator = "";
        }

        if (state.reasoningItemId) {
          writeSSE("response.reasoning_text.done", {
            item_id: state.reasoningItemId,
            output_index: 0, text: state.reasoningAccumulator
          });
          writeSSE("response.output_item.done", {
            output_index: 0,
            item: { type: "reasoning", id: state.reasoningItemId, summary: [{ type: "summary_text", text: state.reasoningAccumulator }] }
          });
        }

        if (state.messageItemId) {
          const outIdx = textOutputBaseIdx();
          writeSSE("response.output_text.done", {
            item_id: state.messageItemId,
            output_index: outIdx, content_index: 0, text: state.textAccumulator
          });
          writeSSE("response.content_part.done", {
            item_id: state.messageItemId,
            output_index: outIdx, content_index: 0,
            part: { type: "output_text", text: state.textAccumulator }
          });
          writeSSE("response.output_item.done", {
            output_index: outIdx,
            item: { type: "message", id: state.messageItemId, role: "assistant", content: [{ type: "output_text", text: state.textAccumulator }] }
          });
        }

        if (state.toolCallDetected) {
          const toolCalls = filterToolCalls(extractToolCalls(state.toolCallBuffer), requestOptions.tools);
          if (toolCalls) {
            let fcIdx = textOutputBaseIdx() + (state.messageItemId ? 1 : 0);
            for (const tc of toolCalls) {
              const fcId = `fc_${randomUUID()}`;
              writeSSE("response.output_item.added", {
                output_index: fcIdx,
                item: { type: "function_call", id: fcId, call_id: tc.id, name: tc.function.name }
              });
              writeSSE("response.function_call_arguments.delta", {
                output_index: fcIdx, item_id: fcId, delta: tc.function.arguments
              });
              writeSSE("response.function_call_arguments.done", {
                output_index: fcIdx, item_id: fcId, arguments: tc.function.arguments
              });
              writeSSE("response.output_item.done", {
                output_index: fcIdx,
                item: { type: "function_call", id: fcId, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments }
              });
              fcIdx++;
            }
          } else {
            emitTextChunk(state.toolCallBuffer);
            if (state.messageItemId) {
              const outIdx = textOutputBaseIdx();
              writeSSE("response.output_text.done", {
                item_id: state.messageItemId,
                output_index: outIdx, content_index: 0, text: state.toolCallBuffer
              });
              writeSSE("response.content_part.done", {
                item_id: state.messageItemId,
                output_index: outIdx, content_index: 0,
                part: { type: "output_text", text: state.toolCallBuffer }
              });
              writeSSE("response.output_item.done", {
                output_index: outIdx,
                item: { type: "message", id: state.messageItemId, role: "assistant", content: [{ type: "output_text", text: state.toolCallBuffer }] }
              });
            }
          }
        }
      } else {
        await consumeTaggedStream(dsResponse.body, (tagged) => {
          if (tagged.kind === "thinking") {
            if (!state.reasoningItemId) {
              state.reasoningItemId = `rs_${randomUUID()}`;
              writeSSE("response.output_item.added", {
                output_index: 0,
                item: { type: "reasoning", id: state.reasoningItemId, summary: [] }
              });
            }
            writeSSE("response.reasoning_text.delta", {
              item_id: state.reasoningItemId,
              output_index: 0, delta: tagged.text
            });
            state.reasoningAccumulator += tagged.text;
            return;
          }

          const outIdx = textOutputBaseIdx();
          if (!state.messageItemId) {
            state.messageItemId = `msg_${randomUUID()}`;
            writeSSE("response.output_item.added", {
              output_index: outIdx,
              item: { id: state.messageItemId, type: "message", role: "assistant", content: [] }
            });
            writeSSE("response.content_part.added", {
              item_id: state.messageItemId,
              output_index: outIdx, content_index: 0,
              part: { type: "output_text", text: "" }
            });
          }
          writeSSE("response.output_text.delta", {
            item_id: state.messageItemId,
            output_index: outIdx, content_index: 0, delta: tagged.text
          });
          state.textAccumulator += tagged.text;
        });

        if (state.reasoningItemId) {
          writeSSE("response.reasoning_text.done", {
            item_id: state.reasoningItemId,
            output_index: 0, text: state.reasoningAccumulator
          });
          writeSSE("response.output_item.done", {
            output_index: 0,
            item: { type: "reasoning", id: state.reasoningItemId, summary: [{ type: "summary_text", text: state.reasoningAccumulator }] }
          });
        }

        if (state.messageItemId) {
          const outIdx = textOutputBaseIdx();
          writeSSE("response.output_text.done", {
            item_id: state.messageItemId,
            output_index: outIdx, content_index: 0, text: state.textAccumulator
          });
          writeSSE("response.content_part.done", {
            item_id: state.messageItemId,
            output_index: outIdx, content_index: 0,
            part: { type: "output_text", text: state.textAccumulator }
          });
          writeSSE("response.output_item.done", {
            output_index: outIdx,
            item: { type: "message", id: state.messageItemId, role: "assistant", content: [{ type: "output_text", text: state.textAccumulator }] }
          });
        }
      }

      writeSSE("response.completed", {
        response: {
          id: responseId, object: "response", created_at: created,
          status: "completed", completed_at: Math.floor(Date.now() / 1000),
          model: modelId, output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
        }
      });

      response.end();
    }
  });
}
