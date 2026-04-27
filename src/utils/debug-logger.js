import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

export const isDebugEnabled = !!config.debug;

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "x-api-key", "x-ds-pow-response"]);

function maskHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const masked = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      const str = String(value);
      masked[key] = str.length > 12 ? str.slice(0, 8) + "..." + str.slice(-4) : "***";
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function maskSensitive(obj, depth = 0) {
  if (depth > 4) return "...";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj)) return `[Buffer ${obj.length} bytes]`;
  if (Array.isArray(obj)) return obj.slice(0, 200).map(v => maskSensitive(v, depth + 1));

  const masked = {};
  for (const [key, value] of Object.entries(obj)) {
    if (/(password|token|secret|cookie)/i.test(key)) {
      masked[key] = "***";
    } else {
      masked[key] = maskSensitive(value, depth + 1);
    }
  }
  return masked;
}

function writeJson(dir, name, data) {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2), "utf8");
}

function writeJsonl(dir, name, items) {
  const lines = items.map(item => JSON.stringify(item)).join("\n");
  writeFileSync(join(dir, name), lines, "utf8");
}

export function createRequestDebugContext(requestId, bridge) {
  if (!isDebugEnabled) return null;

  const meta = { requestId, bridge, timestamp: new Date().toISOString() };
  let incoming = null;
  let resolved = null;
  let upstream = null;
  const sseFrames = [];
  const deltas = [];
  let toolDetection = null;
  let toolParsing = null;
  let finalResponse = null;
  let error = null;

  return {
    logIncoming(headers, body) {
      incoming = {
        headers: maskHeaders(headers),
        body: body ? maskSensitive(body) : null
      };
    },

    logResolved(model, account, hasTools) {
      resolved = {
        model: model ? { id: model.id, modelType: model.modelType, thinkingEnabled: model.thinkingEnabled, searchEnabled: model.searchEnabled } : null,
        account: account ? { id: account.id, loginValue: account.loginValue ? account.loginValue.slice(0, 4) + "..." : null } : null,
        hasTools
      };
    },

    logUpstream(body) {
      const raw = typeof body === "string" ? body : body ? body.toString("utf8") : null;
      upstream = raw;
    },

    logSseFrame(data) {
      if (sseFrames.length < 5000) {
        sseFrames.push(data);
      }
    },

    logDelta(kind, text) {
      deltas.push({ kind, text });
    },

    logToolDetection(info) {
      toolDetection = toolDetection ? { ...toolDetection, ...info } : info;
    },

    logToolParsing(info) {
      toolParsing = toolParsing ? { ...toolParsing, ...info } : info;
    },

    logFinalResponse(data) {
      finalResponse = data;
    },

    logError(err) {
      error = {
        message: err?.message ?? String(err),
        code: err?.code ?? null,
        stack: err?.stack ?? null
      };
    },

    flush() {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "");

      const logRoot = process.env.DEBUG_LOG_DIR || join(process.cwd(), "logs", "debug");
      const dateDir = join(logRoot, dateStr);
      const reqDir = join(dateDir, `${timeStr}_${bridge}_${requestId}`);
      mkdirSync(reqDir, { recursive: true });

      try {
        writeJson(reqDir, "meta.json", meta);
        if (incoming) writeJson(reqDir, "incoming.json", incoming);
        if (resolved) writeJson(reqDir, "resolved.json", resolved);
        if (upstream) writeJson(reqDir, "upstream.json", {
          bodyLength: upstream.length,
          bodyPreview: upstream.length > 2000 ? upstream.slice(0, 2000) + "..." : upstream
        });
        if (sseFrames.length) writeJsonl(reqDir, "sse-frames.jsonl", sseFrames);
        if (deltas.length) writeJsonl(reqDir, "deltas.jsonl", deltas);
        if (toolDetection) writeJson(reqDir, "tool-detection.json", toolDetection);
        if (toolParsing) writeJson(reqDir, "tool-parsing.json", toolParsing);
        if (finalResponse) writeJson(reqDir, "final-response.json", finalResponse);
        if (error) writeJson(reqDir, "error.json", error);

        // Assembled delta text
        const deltaTexts = { thinking: "", response: "" };
        for (const d of deltas) deltaTexts[d.kind] += d.text;

        writeJson(reqDir, "complete.json", {
          meta,
          request: incoming ? { headers: incoming.headers, body: incoming.body, model: resolved?.model?.id, hasTools: resolved?.hasTools } : null,
          upstream: upstream ? { promptLength: upstream.length, promptPreview: upstream.length > 500 ? upstream.slice(0, 500) + "..." : upstream } : null,
          response: {
            toolDetected: toolDetection?.markerFound ?? false,
            toolCalls: toolDetection?.toolCalls ?? null,
            finishReason: finalResponse?.finishReason ?? finalResponse?.stop_reason ?? null,
            thinking: deltaTexts.thinking || null,
            content: deltaTexts.response || null
          },
          error
        });
      } catch (e) {
        console.error("[debug] failed to write log:", e.message);
      }
    }
  };
}
