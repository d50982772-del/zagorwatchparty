import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { registerSocketHandlers } from "./sockets/socket.handlers";

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[server] CORS origin: ${CORS_ORIGIN.join(", ")}`);
});
