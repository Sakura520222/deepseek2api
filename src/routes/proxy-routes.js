import { resolveScopedAccount, resolveSession } from "../services/auth-service.js";
import { deleteChatSession } from "../services/chat-session-service.js";
import {
  collectDeepseekChatResponse,
  createChatCompletionRequestBody,
  sanitizeChatCompletionBody
} from "../services/deepseek-chat-response.js";
import { isIncognitoEnabledForOwner } from "../services/incognito-service.js";
import { proxyDeepseekRequest } from "../services/deepseek-proxy.js";
import { withOwnerRequestLimit } from "../services/request-limit-service.js";
import { parseJsonBody, readRequestBody, sendError, sendJson } from "../utils/http.js";

const CHAT_COMPLETION_PATH = "/api/v0/chat/completion";

function getForwardHeaders(request) {
  const headers = {};
  const contentType = request.headers["content-type"];
  const accept = request.headers.accept;

  if (contentType) {
    headers["content-type"] = contentType;
  }

  if (accept) {
    headers.accept = accept;
  }

  return headers;
}

function getResponseHeaders(upstream) {
  const headers = Object.fromEntries(upstream.headers.entries());
  delete headers["content-encoding"];
  delete headers["content-length"];
  delete headers.connection;
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  return headers;
}

function tryParseChatCompletionBody(body) {
  if (!body?.byteLength) {
    return null;
  }

  try {
    return parseJsonBody(body);
  } catch {
    return null;
  }
}

function resolveChatCompletionRequest(method, targetPath, body) {
  if (method !== "POST" || targetPath !== CHAT_COMPLETION_PATH) {
    return null;
  }

  const payload = tryParseChatCompletionBody(body);
  if (!payload) {
    return null;
  }

  return {
    payload,
    shouldStream: payload.stream !== false,
    forwardedBody: createChatCompletionRequestBody(payload)
  };
}

function resolveCleanupTask({ account, body, method, ownerId, targetPath }) {
  if (method !== "POST" || targetPath !== CHAT_COMPLETION_PATH) {
    return null;
  }

  if (!isIncognitoEnabledForOwner(ownerId)) {
    return null;
  }

  const chatSessionId = tryParseChatCompletionBody(body)?.chat_session_id;
  if (!chatSessionId) {
    return null;
  }

  return () => deleteChatSession(account, chatSessionId);
}

async function writeUpstreamResponse({ onAfterStream, response, upstream }) {
  response.writeHead(upstream.status, getResponseHeaders(upstream));
  response.flushHeaders?.();

  if (upstream.body) {
    for await (const chunk of upstream.body) {
      response.write(chunk);
    }
  }

  await onAfterStream?.();
  response.end();
}

export async function handleProxyRequest(request, response, url, allowedProxyPaths) {
  const session = resolveSession(request);
  if (!session) {
    sendError(response, 401, "Unauthorized");
    return true;
  }

  const targetPath = url.pathname.slice("/proxy".length);
  if (!allowedProxyPaths.has(targetPath)) {
    sendError(response, 404, "Proxy path not allowed");
    return true;
  }

  const account = resolveScopedAccount(session, request.headers["x-proxy-account-id"]);
  if (!account) {
    sendError(response, 404, "Account not found");
    return true;
  }

  try {
    await withOwnerRequestLimit(session.ownerId, async () => {
      const rawBody = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readRequestBody(request);
      const chatCompletion = resolveChatCompletionRequest(request.method, targetPath, rawBody);
      const forwardedBody = chatCompletion?.forwardedBody ?? rawBody;
      const cleanup = resolveCleanupTask({
        account,
        body: rawBody,
        method: request.method,
        ownerId: session.ownerId,
        targetPath
      });

      if (chatCompletion && !chatCompletion.shouldStream) {
        try {
          const payload = await collectDeepseekChatResponse({
            account,
            body: sanitizeChatCompletionBody(chatCompletion.payload)
          });
          await cleanup?.();
          sendJson(response, 200, payload);
          return;
        } catch (error) {
          await cleanup?.();
          throw error;
        }
      }

      const { response: upstream } = await proxyDeepseekRequest({
        account,
        method: request.method,
        path: targetPath,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: getForwardHeaders(request),
        body: forwardedBody
      });

      await writeUpstreamResponse({
        onAfterStream: cleanup,
        response,
        upstream
      });
    });
  } catch (error) {
    if (error.statusCode) {
      sendError(response, error.statusCode, error.message);
      return true;
    }

    if (error.code !== "USER_DISABLED" && error.code !== "REQUEST_LIMIT") {
      throw error;
    }

    const status = error.code === "USER_DISABLED" ? 403 : 429;
    sendError(response, status, error.message);
  }

  return true;
}
