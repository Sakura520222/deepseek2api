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

  // At this point payload.v is not a string (all string cases handled above).
  // Nested content patterns for v4/expert models: v.content, v.text, v.delta
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

      // DeepSeek signal frame: bare "FINISHED" in a payload with no fragment path.
      // Only filter when there's no "p" key — payloads with a "p" key are actual
      // content deltas that happen to contain the word "FINISHED".
      if (text === "FINISHED" && !("p" in payload) && typeof payload.v === "string") {
        return null;
      }

      return text ? { kind: currentKind, text } : null;
    }
  };
}

export function extractContentDelta(payloadText) {
  const payload = JSON.parse(payloadText);
  return extractFragmentText(payload);
}
