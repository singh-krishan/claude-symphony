import { createServer, type Server } from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import { log } from "./logger.js";

export function startStatusServer(
  orchestrator: Orchestrator,
  port: number,
): Server {
  const server = createServer((req, res) => {
    if (req.url === "/status" || req.url === "/") {
      const snapshot = orchestrator.getSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot, null, 2));
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    log.info({ event: "status_server_started", port });
  });

  return server;
}
