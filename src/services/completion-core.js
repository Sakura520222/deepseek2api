import { randomUUID } from "node:crypto";

import { createDeepseekDeltaDecoder, createSseParser } from "../utils/deepseek-sse.js";
import { createChatSession, deleteChatSession } from "./chat-session-service.js";
import { proxyDeepseekRequest } from "./deepseek-proxy.js";

export const TOOL_CALL_MARKERS = ["<tool_call", "<function_call", "[调用 Agent]"];

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

export async function startCompletion({ account, requestOptions, sessionId }) {
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

export async function consumeTaggedStream(stream, onTagged) {
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

export async function collectTaggedContent(stream) {
  let content = "";
  let reasoningContent = "";

  await consumeTaggedStream(stream, (tagged) => {
    if (tagged.kind === "thinking") {
      reasoningContent += tagged.text;
    } else {
      content += tagged.text;
    }
  });

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
