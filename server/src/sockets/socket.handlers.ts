import type { Server, Socket } from "socket.io";
import { roomService } from "../rooms/room.service";

interface CreateRoomPayload {
  videoUrl?: string;
}
interface JoinRoomPayload {
  roomId: string;
}
interface LeaveRoomPayload {
  roomId: string;
}
interface VideoSetPayload {
  roomId: string;
  videoUrl: string;
}
interface VideoPlayPayload {
  roomId: string;
  currentTime: number;
}
interface VideoPausePayload {
  roomId: string;
  currentTime: number;
}
interface VideoSeekPayload {
  roomId: string;
  currentTime: number;
}
interface SyncRequestPayload {
  roomId: string;
}

/**
 * Виносимо всі обробники подій сюди, щоб index.ts залишався тонким.
 *
 * Логіка проста:
 *  - сервер не намагається бути занадто розумним: він просто зберігає останній
 *    стан і ретранслює події всім іншим клієнтам у кімнаті;
 *  - синхронізація і drift correction відбуваються на клієнті.
 */
export function registerSocketHandlers(io: Server, socket: Socket): void {
  // --- Створення кімнати ---
  socket.on("room:create", (payload: CreateRoomPayload = {}) => {
    const room = roomService.createRoom(socket.id, payload.videoUrl);
    socket.emit("room:created", { roomId: room.roomId });
  });

  // --- Приєднання до кімнати ---
  socket.on("room:join", (payload: JoinRoomPayload) => {
    const room = roomService.getRoom(payload?.roomId);
    if (!room) {
      socket.emit("room:error", { code: "ROOM_NOT_FOUND", message: "Кімнату не знайдено" });
      return;
    }

    socket.join(room.roomId);
    roomService.addParticipant(room.roomId, socket.id);

    // Шлемо новому учаснику актуальний стан кімнати.
    socket.emit("room:state", roomService.toDTO(room));
    // Решті — оновлений лічильник.
    io.to(room.roomId).emit("users:update", { participantsCount: room.participants.size });
  });

  // --- Вихід з кімнати (явний, без disconnect) ---
  socket.on("room:leave", (payload: LeaveRoomPayload) => {
    if (!payload?.roomId) return;
    socket.leave(payload.roomId);
    const updated = roomService.removeParticipant(payload.roomId, socket.id);
    if (updated) {
      io.to(updated.roomId).emit("users:update", {
        participantsCount: updated.participants.size,
      });
    }
  });

  // --- Зміна джерела відео ---
  socket.on("video:set", (payload: VideoSetPayload) => {
    if (!payload?.roomId || typeof payload.videoUrl !== "string") return;
    const room = roomService.setVideo(payload.roomId, payload.videoUrl);
    if (!room) {
      socket.emit("room:error", { code: "ROOM_NOT_FOUND", message: "Кімнату не знайдено" });
      return;
    }
    io.to(room.roomId).emit("video:set", {
      videoUrl: room.videoUrl,
      sourceType: room.sourceType,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      updatedAt: room.updatedAt,
    });
  });

  // --- Play / Pause / Seek ---
  socket.on("video:play", (payload: VideoPlayPayload) => {
    if (!payload?.roomId) return;
    const room = roomService.setPlaying(payload.roomId, Number(payload.currentTime) || 0);
    if (!room) return;
    socket.to(room.roomId).emit("video:play", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  socket.on("video:pause", (payload: VideoPausePayload) => {
    if (!payload?.roomId) return;
    const room = roomService.setPaused(payload.roomId, Number(payload.currentTime) || 0);
    if (!room) return;
    socket.to(room.roomId).emit("video:pause", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  socket.on("video:seek", (payload: VideoSeekPayload) => {
    if (!payload?.roomId) return;
    const room = roomService.setSeek(payload.roomId, Number(payload.currentTime) || 0);
    if (!room) return;
    socket.to(room.roomId).emit("video:seek", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  // --- Запит на ресинхронізацію (drift correction) ---
  socket.on("sync:request", (payload: SyncRequestPayload) => {
    if (!payload?.roomId) return;
    const room = roomService.getRoom(payload.roomId);
    if (!room) return;
    socket.emit("sync:correction", roomService.toDTO(room));
  });

  // --- Відключення ---
  socket.on("disconnect", () => {
    const rooms = roomService.findRoomsBySocket(socket.id);
    for (const r of rooms) {
      const updated = roomService.removeParticipant(r.roomId, socket.id);
      if (updated) {
        io.to(updated.roomId).emit("users:update", {
          participantsCount: updated.participants.size,
        });
      }
    }
  });
}
