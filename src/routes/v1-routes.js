import { randomUUID } from "node:crypto";

import { getApiKeyRecord } from "../services/api-key-service.js";
import { takeRoundRobinAccount } from "../services/account-rotation-service.js";
import { collectAnthropicMessage, streamAnthropicMessage } from "../services/anthropic-bridge.js";
import { isIncognitoEnabledForOwner } from "../services/incognito-service.js";
import { collectOpenAiResponse, streamOpenAiResponse } from "../services/openai-bridge.js";
import { listOpenAiModels } from "../services/openai-request.js";
import { collectResponsesResult, streamResponsesResult } from "../services/responses-bridge.js";
import { withOwnerRequestLimit } from "../services/request-limit-service.js";
import { createRequestDebugContext } from "../utils/debug-logger.js";
import { parseJsonBody, readRequestBody, sendError, sendJson } from "../utils/http.js";

function getBearerToken(request) {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function resolveOpenAiAuth(request) {
  const token = getBearerToken(request);
  return token ? getApiKeyRecord(token) : null;
}

function resolveAnthropicAuth(request) {
  const xApiKey = request.headers["x-api-key"] ?? "";
  if (xApiKey) {
    const record = getApiKeyRecord(xApiKey);
    if (record) return record;
  }
  return resolveOpenAiAuth(request);
}

function handleApiError(response, error) {
  if (error.code === "USER_DISABLED" || error.code === "REQUEST_LIMIT") {
    const status = error.code === "USER_DISABLED" ? 403 : 429;
    sendError(response, status, error.message);
    return true;
  }

  if (error instanceof SyntaxError) {
    sendError(response, 400, "Invalid JSON body");
    return true;
  }

  if (error.statusCode) {
    sendError(response, error.statusCode, error.message);
    return true;
  }

  return false;
}

async function withApiRequest(request, response, apiKeyRecord, { streamHandler, collectHandler }, bridgeName) {
  const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const debugCtx = createRequestDebugContext(requestId, bridgeName);

  try {
    const body = parseJsonBody(await readRequestBody(request));
    debugCtx?.logIncoming(request.headers, body);

    const account = takeRoundRobinAccount(apiKeyRecord);
    if (!account) {
      sendError(response, 404, "Account not found");
      return;
    }

    debugCtx?.logResolved(null, account, !!(body?.tools?.length));
    const deleteAfterFinish = isIncognitoEnabledForOwner(apiKeyRecord.ownerId);

    if (body.stream) {
      await streamHandler({ response, account, body, deleteAfterFinish, debugCtx });
    } else {
      const payload = await collectHandler({ account, body, deleteAfterFinish, debugCtx });
      debugCtx?.logFinalResponse(payload);
      sendJson(response, 200, payload);
    }
  } catch (error) {
    debugCtx?.logError(error);
    throw error;
  } finally {
    debugCtx?.flush();
  }
}

export async function handleV1Request(request, response, url) {
  if (request.method === "GET" && url.pathname === "/v1/models") {
    const apiKeyRecord = resolveOpenAiAuth(request);
    if (!apiKeyRecord) {
      sendError(response, 401, "Invalid API key");
      return true;
    }
    try {
      await withOwnerRequestLimit(apiKeyRecord.ownerId, async () => {
        sendJson(response, 200, { object: "list", data: listOpenAiModels() });
      });
    } catch (error) {
      if (!handleApiError(response, error)) throw error;
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const apiKeyRecord = resolveOpenAiAuth(request);
    if (!apiKeyRecord) {
      sendError(response, 401, "Invalid API key");
      return true;
    }
    try {
      await withOwnerRequestLimit(apiKeyRecord.ownerId, async () => {
        await withApiRequest(request, response, apiKeyRecord, {
          streamHandler: streamOpenAiResponse,
          collectHandler: collectOpenAiResponse
        }, "openai");
      });
    } catch (error) {
      if (!handleApiError(response, error)) throw error;
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/responses") {
    const apiKeyRecord = resolveOpenAiAuth(request);
    if (!apiKeyRecord) {
      sendError(response, 401, "Invalid API key");
      return true;
    }
    try {
      await withOwnerRequestLimit(apiKeyRecord.ownerId, async () => {
        await withApiRequest(request, response, apiKeyRecord, {
          streamHandler: streamResponsesResult,
          collectHandler: collectResponsesResult
        }, "responses");
      });
    } catch (error) {
      if (!handleApiError(response, error)) throw error;
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/messages") {
    const apiKeyRecord = resolveAnthropicAuth(request);
    if (!apiKeyRecord) {
      sendError(response, 401, "Invalid API key");
      return true;
    }
    try {
      await withOwnerRequestLimit(apiKeyRecord.ownerId, async () => {
        await withApiRequest(request, response, apiKeyRecord, {
          streamHandler: streamAnthropicMessage,
          collectHandler: collectAnthropicMessage
        }, "anthropic");
      });
    } catch (error) {
      if (!handleApiError(response, error)) throw error;
    }
    return true;
  }

  return false;
}
