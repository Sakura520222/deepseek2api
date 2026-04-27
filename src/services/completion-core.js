import { randomUUID } from "node:crypto";

import { createDeepseekDeltaDecoder, createSseParser } from "../utils/deepseek-sse.js";
import { createChatSession, deleteChatSession } from "./chat-session-service.js";
import { proxyDeepseekRequest } from "./deepseek-proxy.js";

export const TOOL_CALL_MARKERS = ["<tool_call", "<function_call", "<tool_code", "<invoke", "<parameter", "[调用 Agent]", "[Called tool:"];

const JSON_TOOL_CALL_HINT = '{"name"';

export const MARKER_START_CHARS = [...new Set(["<", "`", ...TOOL_CALL_MARKERS.map(m => m[0])])];

export function findToolCallMarker(text) {
  let earliest = -1;
  for (const marker of TOOL_CALL_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

/** Like findToolCallMarker but also detects bare JSON tool calls like {"name":"..."}. */
export function checkForToolCallMarker(buf) {
  const idx = findToolCallMarker(buf);
  if (idx !== -1) return idx;
  const jsonIdx = buf.indexOf(JSON_TOOL_CALL_HINT);
  if (jsonIdx !== -1) return jsonIdx;
  return -1;
}

export function isPartialMarker(text) {
  for (const marker of TOOL_CALL_MARKERS) {
    for (let i = Math.max(0, text.length - marker.length); i < text.length; i++) {
      if (!MARKER_START_CHARS.includes(text[i])) continue;
      const tail = text.slice(i);
      if (marker.startsWith(tail)) return true;
    }
  }
  return false;
}

export function filterToolCalls(toolCalls, tools) {
  if (!toolCalls || !tools) return null;

  const validNames = tools.map((t) => t.function?.name).filter(Boolean);

  const filtered = toolCalls.map((tc) => {
    if (validNames.includes(tc.function.name)) return tc;

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

export async function startCompletion({ account, requestOptions, sessionId, debugCtx }) {
  const body = Buffer.from(
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
  );

  debugCtx?.logUpstream(body);

  return proxyDeepseekRequest({
    account,
    method: "POST",
    path: "/api/v0/chat/completion",
    body,
    headers: { "content-type": "application/json" }
  });
}

export async function consumeTaggedStream(stream, onTagged, debugCtx = null) {
  if (!stream) {
    return;
  }

  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();
  const parser = createSseParser(({ event, data }) => {
    debugCtx?.logSseFrame({ event, data: data.length > 2000 ? data.slice(0, 2000) + `... (${data.length} chars)` : data });

    if (event === "hint") {
      try {
        const hint = JSON.parse(data);
        if (hint.type === "error") {
          onTagged({ kind: "error", text: hint.content || "Upstream error", code: hint.finish_reason || "upstream_error" });
          return;
        }
      } catch { /* not a valid JSON hint */ }
      return;
    }

    const delta = deltaDecoder.consume(data);
    if (delta?.text) {
      debugCtx?.logDelta(delta.kind, delta.text);
      onTagged({ kind: delta.kind, text: delta.text });
    }
  });

  for await (const chunk of stream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
}

export async function collectTaggedContent(stream, debugCtx = null) {
  let content = "";
  let reasoningContent = "";

  await consumeTaggedStream(stream, (tagged) => {
    if (tagged.kind === "error") {
      const err = new Error(tagged.text);
      err.code = tagged.code;
      throw err;
    }
    if (tagged.kind === "thinking") {
      reasoningContent += tagged.text;
    } else {
      content += tagged.text;
    }
  }, debugCtx);

  return { content, reasoningContent };
}

export async function withCompletionSession({ account, body, deleteAfterFinish, onComplete }) {
  const sessionId = await createChatSession(account);

  try {
    return await onComplete(sessionId);
  } finally {
    if (deleteAfterFinish) {
      await deleteChatSession(account, sessionId);
    }
  }
}
