import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/authenticate";
import { addConnection } from "../services/realtimeService";

const router = Router();

/**
 * Long-lived Server-Sent-Events stream. The browser opens it with a normal
 * fetch() + "Authorization: Bearer <token>" header, so the same authenticate
 * middleware as every other route protects it.
 */
router.get("/stream", authenticate, (req: Request, res: Response) => {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // stop proxies (nginx/Render) from buffering the stream
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  res.write("event: ready\ndata: {}\n\n");

  const remove = addConnection(req.user!.id, res);

  // A comment line every 25s keeps idle proxies from closing the connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* connection is gone; the close handler below cleans up */
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
});

export default router;