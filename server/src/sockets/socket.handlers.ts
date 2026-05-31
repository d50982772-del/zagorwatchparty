import type { Server, Socket } from "socket.io";
import { roomService } from "../rooms/room.service";
import { sanitizeTime } from "../utils/sanitizeTime";
import { detectSourceType } from "../utils/detectSourceType";
import { RateLimiter } from "../utils/rateLimit";

/** Жорстка верхня межа на довжину URL, щоб клієнт не міг "роздути" room state. */
const MAX_VIDEO_URL_LENGTH = 2048;

/**
 * Дозволяємо тільки http / https. Це не повноцінна санітизація (frontend все одно
 * має свій detectSourceType), але блокує javascript:, data:, file: і подібні
 * URL'и до того, як вони потраплять у broadcast іншим учасникам.
 */
function isAllowedVideoUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_VIDEO_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Per-socket per-event rate limit. Захищає від випадкових / ненавмисних флудів
 * (баг у клієнті шле сотні `video:seek` на секунду) і від легких сценаріїв
 * зловживання. Це НЕ захист від ботнету — для цього потрібен ще layer на рівні
 * проксі.
 *
 * Капасіті 30 з реджен-швидкістю 10/с — це ~10 подій/с steady-state і
 * 30 burst, що з запасом покриває реальний UX (швидкий скраббінг — це 10-15
 * подій seek підряд, і кожна як 1 token).
 */
const eventLimiter = new RateLimiter({ capacity: 30, refillPerSec: 10 });
/**
 * Окремий, жорсткіший ліміт на video:set — це дорога операція (reset state +
 * broadcast великого payload). 5 у бакеті, 1/с реджен.
 */
const videoSetLimiter = new RateLimiter({ capacity: 5, refillPerSec: 1 });
/**
 * І окремий на room:create — щоб з одного IP не можна було за секунду
 * зробити 1000 кімнат.
 */
const createLimiter = new RateLimiter({ capacity: 5, refillPerSec: 0.5 });

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
    if (!createLimiter.consume(socket.id)) {
      socket.emit("room:error", {
        code: "RATE_LIMITED",
        message: "Забагато запитів. Спробуй ще раз за хвилину.",
      });
      return;
    }
    // Порожній / відсутній URL дозволений (можна задати пізніше через video:set).
    // Якщо URL переданий — має бути валідним http(s).
    const url = typeof payload?.videoUrl === "string" ? payload.videoUrl.trim() : "";
    if (url && !isAllowedVideoUrl(url)) {
      socket.emit("room:error", {
        code: "INVALID_URL",
        message: "Непідтримуваний URL відео (потрібний http або https).",
      });
      return;
    }
    // Якщо URL переданий — він має бути одного з відомих типів. Без цього
    // зловмисник міг би засіяти кімнату відразу при створенні (наприклад
    // через посилання запрошення з ?url=...).
    if (url && detectSourceType(url) === "unknown") {
      socket.emit("room:error", {
        code: "UNSUPPORTED_SOURCE",
        message:
          "Тип відео не підтримується. Працюємо з YouTube, .mp4, .webm, .ogg, .m3u8.",
      });
      return;
    }
    const room = roomService.createRoom(socket.id, url || undefined);
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
    if (!roomService.isParticipant(payload.roomId, socket.id)) return;
    if (!videoSetLimiter.consume(socket.id)) {
      socket.emit("room:error", {
        code: "RATE_LIMITED",
        message: "Забагато змін відео. Зачекай пару секунд.",
      });
      return;
    }
    const url = payload.videoUrl.trim();
    if (!isAllowedVideoUrl(url)) {
      socket.emit("room:error", {
        code: "INVALID_URL",
        message: "Непідтримуваний URL відео (потрібний http або https).",
      });
      return;
    }
    // Reject будь-який URL, який не співпадає з відомим типом джерела —
    // інакше зловмисник з roomId міг би засіяти всім учасникам arbitrary
    // <video src> з трекером (IP-leak / pixel-tracking vector).
    // detectSourceType — це той самий guard, що і у клієнта.
    if (detectSourceType(url) === "unknown") {
      socket.emit("room:error", {
        code: "UNSUPPORTED_SOURCE",
        message:
          "Тип відео не підтримується. Працюємо з YouTube, .mp4, .webm, .ogg, .m3u8.",
      });
      return;
    }
    const room = roomService.setVideo(payload.roomId, url);
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
  // Всі три вимагають, щоб відправник був учасником кімнати — інакше будь-який
  // підключений сокет, який вгадав roomId, міг би ламати чужий перегляд.
  socket.on("video:play", (payload: VideoPlayPayload) => {
    if (!payload?.roomId) return;
    if (!roomService.isParticipant(payload.roomId, socket.id)) return;
    if (!eventLimiter.consume(socket.id)) return;
    const room = roomService.setPlaying(payload.roomId, sanitizeTime(payload.currentTime));
    if (!room) return;
    socket.to(room.roomId).emit("video:play", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  socket.on("video:pause", (payload: VideoPausePayload) => {
    if (!payload?.roomId) return;
    if (!roomService.isParticipant(payload.roomId, socket.id)) return;
    if (!eventLimiter.consume(socket.id)) return;
    const room = roomService.setPaused(payload.roomId, sanitizeTime(payload.currentTime));
    if (!room) return;
    socket.to(room.roomId).emit("video:pause", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  socket.on("video:seek", (payload: VideoSeekPayload) => {
    if (!payload?.roomId) return;
    if (!roomService.isParticipant(payload.roomId, socket.id)) return;
    if (!eventLimiter.consume(socket.id)) return;
    const room = roomService.setSeek(payload.roomId, sanitizeTime(payload.currentTime));
    if (!room) return;
    socket.to(room.roomId).emit("video:seek", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  // --- Запит на ресинхронізацію (drift correction) ---
  socket.on("sync:request", (payload: SyncRequestPayload) => {
    if (!payload?.roomId) return;
    if (!roomService.isParticipant(payload.roomId, socket.id)) return;
    if (!eventLimiter.consume(socket.id)) return;
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
    // Не залишаємо стан bucket'ів у пам'яті після того, як сокет відключився.
    eventLimiter.drop(socket.id);
    videoSetLimiter.drop(socket.id);
    createLimiter.drop(socket.id);
  });
}
