export function createSseParser(onEvent) {
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  function emit() {
    if (!dataLines.length) {
      eventName = "message";
      return;
    }

    onEvent({
      event: eventName,
      data: dataLines.join("\n")
    });

    eventName = "message";
    dataLines = [];
  }

  return {
    push(chunk) {
      buffer += chunk;

      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);

        if (!line) {
          emit();
          continue;
        }

        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    },
    flush() {
      if (buffer.trim()) {
        dataLines.push(buffer.trim());
        buffer = "";
      }

      emit();
    }
  };
}

const FRAGMENT_KIND_BY_TYPE = Object.freeze({
  THINK: "thinking",
  RESPONSE: "response"
});

function resolveFragmentKind(type) {
  return FRAGMENT_KIND_BY_TYPE[type] ?? null;
}

function getInitialFragment(payload) {
  const fragments = payload.v?.response?.fragments;
  return Array.isArray(fragments) ? fragments.at(-1) ?? null : null;
}

function getAppendedFragment(payload) {
  if (payload.p !== "response/fragments" || payload.o !== "APPEND") {
    return null;
  }

  return Array.isArray(payload.v) ? payload.v.at(-1) ?? null : null;
}

function resolveCurrentKind(payload, currentKind) {
  const fragment = getAppendedFragment(payload) ?? getInitialFragment(payload);
  return resolveFragmentKind(fragment?.type) ?? currentKind;
}

function extractFragmentText(payload) {
  const fragment = getInitialFragment(payload);
  if (typeof fragment?.content === "string") {
    return fragment.content;
  }

  const appendedFragment = getAppendedFragment(payload);
  if (typeof appendedFragment?.content === "string") {
    return appendedFragment.content;
  }

  if (payload.p === "response/fragments/-1/content" && typeof payload.v === "string") {
    return payload.v;
  }

  if (!("p" in payload) && typeof payload.v === "string") {
    return payload.v;
  }

  // Fallback: try to extract text from common deepseek payload patterns
  // v4/expert models may use different fragment paths
  if (typeof payload.v === "string" && payload.v.length > 0) {
    return payload.v;
  }

  // Try nested content patterns: v.content, v.text, v.delta, etc.
  if (payload.v && typeof payload.v === "object") {
    if (typeof payload.v.content === "string") return payload.v.content;
    if (typeof payload.v.text === "string") return payload.v.text;
    if (typeof payload.v.delta === "string") return payload.v.delta;
  }

  return "";
}

export function createDeepseekDeltaDecoder() {
  let currentKind = "response";

  return {
    consume(payloadText) {
      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        return null;
      }
      currentKind = resolveCurrentKind(payload, currentKind);
      const text = extractFragmentText(payload);

      if (!text && process.env.DEBUG_TOOL_CALL) {
        const hasFragment = payload.v?.response?.fragments || payload.p === "response/fragments" || payload.p === "response/fragments/-1/content";
        if (!hasFragment && payload.p !== undefined) {
          console.log("[sse-debug] unmatched payload:", JSON.stringify(payload).slice(0, 200));
        }
      }

      if (text === "FINISHED") return null;

      return text ? { kind: currentKind, text } : null;
    }
  };
}

export function extractContentDelta(payloadText) {
  const payload = JSON.parse(payloadText);
  return extractFragmentText(payload);
}
