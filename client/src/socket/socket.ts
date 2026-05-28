import { io, type Socket } from "socket.io-client";

/**
 * Один спільний інстанс Socket.IO клієнта на весь застосунок.
 *
 * У dev режимі Vite проксує /socket.io на backend, тому достатньо передати
 * порожній URL (тоді socket.io-client підключиться до того ж origin, з якого
 * завантажилась сторінка).
 *
 * У продакшні задається VITE_BACKEND_URL — повна адреса backend сервера.
 */
const url = import.meta.env.VITE_BACKEND_URL || "";

export const socket: Socket = io(url, {
  autoConnect: true,
  transports: ["websocket", "polling"],
});

export type AppSocket = typeof socket;
