import { customAlphabet } from "nanoid";
import { detectSourceType, type SourceType } from "../utils/detectSourceType";
import type { Room, RoomStateDTO } from "./room.types";

// Короткі читабельні id для кімнат, без подібних символів.
const generateRoomId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 8);

/**
 * Скільки часу тримати порожню кімнату в пам'яті, перш ніж видалити її.
 * 5 хв покриває:
 *  - React 18 StrictMode mount→cleanup→mount у dev (без цього кімната б видалялася
 *    між cleanup і re-mount і user бачив би "Кімнату не знайдено");
 *  - "осиротілі" кімнати, в яких хост ніколи не викликав room:join;
 *  - помірні мережеві обриви — sleep ноутбука, рекоонект після переходу між Wi-Fi;
 *  - повільні reconnect'и socket.io після короткого фейлу.
 * Раніше було 60с — це не покривало sleep-сценаріїв і користувач бачив
 * фатальну сторінку "Кімнату не знайдено" після того, як його кімнату свіпнули.
 */
export const ROOM_GRACE_MS = 5 * 60_000;

/**
 * In-memory сховище кімнат. Для MVP цього достатньо: при перезапуску сервера
 * кімнати губляться, і це нормально.
 *
 * У майбутньому це місце можна замінити на Redis або БД, не змінюючи інтерфейс.
 */
class RoomService {
  private rooms = new Map<string, Room>();

  createRoom(hostSocketId: string, videoUrl?: string): Room {
    const roomId = generateRoomId();
    const url = videoUrl?.trim() || null;
    const now = Date.now();
    const room: Room = {
      roomId,
      videoUrl: url,
      sourceType: url ? detectSourceType(url) : "unknown",
      isPlaying: false,
      currentTime: 0,
      updatedAt: now,
      hostId: hostSocketId,
      participants: new Set<string>(),
      // Свіжо створена кімната порожня, поки host не викликав room:join.
      emptySince: now,
    };
    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  addParticipant(roomId: string, socketId: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.participants.add(socketId);
    // У кімнаті з'явився хтось — скасовуємо таймер на видалення.
    room.emptySince = null;
    return room;
  }

  /**
   * Не видаляємо кімнату одразу, коли останній учасник вийшов — лише
   * позначаємо час початку порожнечі. Періодичний sweep() прибере пізніше,
   * якщо ніхто так і не повернеться у grace period. Це робить кімнату стійкою
   * до React StrictMode mount→cleanup→mount в dev.
   */
  removeParticipant(roomId: string, socketId: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.participants.delete(socketId);
    if (room.participants.size === 0) {
      room.emptySince = Date.now();
    }
    return room;
  }

  /**
   * Перевірка приналежності — використовуємо, щоб video:play / pause / seek / set
   * від сторонніх сокетів не могли впливати на чужу кімнату.
   */
  isParticipant(roomId: string, socketId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.participants.has(socketId) ?? false;
  }

  /**
   * Видаляє кімнати, які залишаються порожніми довше, ніж ROOM_GRACE_MS.
   * Повертає кількість видалених (для логування / тестів).
   */
  sweepStaleRooms(graceMs = ROOM_GRACE_MS, now: number = Date.now()): number {
    let removed = 0;
    for (const [id, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince > graceMs) {
        this.rooms.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Знаходимо всі кімнати, у яких є цей сокет. Потрібно при disconnect. */
  findRoomsBySocket(socketId: string): Room[] {
    const result: Room[] = [];
    for (const room of this.rooms.values()) {
      if (room.participants.has(socketId)) result.push(room);
    }
    return result;
  }

  setVideo(roomId: string, videoUrl: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.videoUrl = videoUrl;
    room.sourceType = detectSourceType(videoUrl);
    room.isPlaying = false;
    room.currentTime = 0;
    room.updatedAt = Date.now();
    return room;
  }

  setPlaying(roomId: string, currentTime: number): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.isPlaying = true;
    room.currentTime = Math.max(0, currentTime);
    room.updatedAt = Date.now();
    return room;
  }

  setPaused(roomId: string, currentTime: number): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.isPlaying = false;
    room.currentTime = Math.max(0, currentTime);
    room.updatedAt = Date.now();
    return room;
  }

  setSeek(roomId: string, currentTime: number): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.currentTime = Math.max(0, currentTime);
    room.updatedAt = Date.now();
    return room;
  }

  /**
   * Готує DTO для клієнта. Час оновлення (updatedAt) дозволяє новому учаснику
   * порахувати реальну позицію відео = currentTime + (now - updatedAt), якщо
   * відео грає.
   */
  toDTO(room: Room): RoomStateDTO {
    return {
      roomId: room.roomId,
      videoUrl: room.videoUrl,
      sourceType: room.sourceType as SourceType,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
      serverNow: Date.now(),
      hostId: room.hostId,
      participantsCount: room.participants.size,
    };
  }
}

export const roomService = new RoomService();
