import { getApiKeyRecord } from "../services/api-key-service.js";
import { takeRoundRobinAccount } from "../services/account-rotation-service.js";
import { collectAnthropicMessage, streamAnthropicMessage } from "../services/anthropic-bridge.js";
import { isIncognitoEnabledForOwner } from "../services/incognito-service.js";
import { collectOpenAiResponse, streamOpenAiResponse } from "../services/openai-bridge.js";
import { listOpenAiModels } from "../services/openai-request.js";
import { collectResponsesResult, streamResponsesResult } from "../services/responses-bridge.js";
import { withOwnerRequestLimit } from "../services/request-limit-service.js";
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

async function withApiRequest(request, response, apiKeyRecord, { streamHandler, collectHandler }) {
  const body = parseJsonBody(await readRequestBody(request));
  const account = takeRoundRobinAccount(apiKeyRecord);
  if (!account) {
    sendError(response, 404, "Account not found");
    return;
  }

  const deleteAfterFinish = isIncognitoEnabledForOwner(apiKeyRecord.ownerId);

  if (body.stream) {
    await streamHandler({ response, account, body, deleteAfterFinish });
  } else {
    const payload = await collectHandler({ account, body, deleteAfterFinish });
    sendJson(response, 200, payload);
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
        });
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
        });
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
        });
      });
    } catch (error) {
      if (!handleApiError(response, error)) throw error;
    }
    return true;
  }

  return false;
}
