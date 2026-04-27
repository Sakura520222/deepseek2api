import { createServer } from "node:http";

import { config } from "./config.js";
import { handleApiRequest } from "./routes/api-routes.js";
import { handleV1Request } from "./routes/v1-routes.js";
import { handleProxyRequest } from "./routes/proxy-routes.js";
import { parseCookies, sendError, serveStaticFile } from "./utils/http.js";

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  request.cookies = parseCookies(request);

  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type, authorization, x-api-key, x-proxy-account-id");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApiRequest(request, response, url);
      if (!handled) {
        sendError(response, 404, "API route not found");
      }
      return;
    }

    if (url.pathname.startsWith("/proxy/")) {
      await handleProxyRequest(request, response, url, config.allowedProxyPaths);
      return;
    }

    if (url.pathname.startsWith("/v1/")) {
      const handled = await handleV1Request(request, response, url);
      if (!handled) {
        sendError(response, 404, "API route not found");
      }
      return;
    }

    if (!serveStaticFile(request, response, url.pathname)) {
      sendError(response, 404, "Page not found");
    }
  } catch (error) {
    if (response.headersSent || response.writableEnded) {
      response.destroy(error);
      return;
    }

    sendError(response, 500, error.message);
  }
});

server.listen(config.port, () => {
  console.log(`Server listening on http://127.0.0.1:${config.port}`);
});
