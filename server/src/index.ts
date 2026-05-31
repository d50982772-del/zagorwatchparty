import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { registerSocketHandlers } from "./sockets/socket.handlers";
import { roomService } from "./rooms/room.service";

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROOM_SWEEP_INTERVAL_MS = 30_000;
const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

// Простий health-check, який зручно тицяти у проді з моніторингу.
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    credentials: true,
  },
});

io.on("connection", (socket) => {
  registerSocketHandlers(io, socket);
});

// Періодично прибираємо кімнати, які залишилися порожніми довше за grace period.
// Запускаємо разом з сервером і чистимо при graceful shutdown.
const sweepTimer = setInterval(() => {
  roomService.sweepStaleRooms();
}, ROOM_SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[server] CORS origin: ${CORS_ORIGIN.join(", ")}`);
});

// Graceful shutdown — k8s/docker rolling restart шле SIGTERM, дев-сервер SIGINT.
// Без цього:
//  - активні WebSocket з'єднання обриваються абрутно, клієнти ловлять "transport
//    close" і ре-конектяться у нікуди;
//  - sweep timer лишається у пам'яті у тестовому середовищі (хоча .unref() це
//    мінімізує).
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[server] received ${signal}, shutting down…`);
  clearInterval(sweepTimer);
  // io.close() сигналізує всім сокетам про disconnect — клієнти можуть
  // показати "сервер тимчасово недоступний" і ре-конектитися без помилки.
  io.close(() => {
    httpServer.close((err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error("[server] http close error:", err);
        process.exit(1);
        return;
      }
      // eslint-disable-next-line no-console
      console.log("[server] shutdown complete");
      process.exit(0);
    });
  });
  // Якщо щось зависло — добиваємо примусово.
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error("[server] shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_HARD_TIMEOUT_MS).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
