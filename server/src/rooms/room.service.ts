import { customAlphabet } from "nanoid";
import { detectSourceType, type SourceType } from "../utils/detectSourceType";
import type { Room, RoomStateDTO } from "./room.types";

// Короткі читабельні id для кімнат, без подібних символів.
const generateRoomId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 8);

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
    const room: Room = {
      roomId,
      videoUrl: url,
      sourceType: url ? detectSourceType(url) : "unknown",
      isPlaying: false,
      currentTime: 0,
      updatedAt: Date.now(),
      hostId: hostSocketId,
      participants: new Set<string>(),
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
    return room;
  }

  removeParticipant(roomId: string, socketId: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.participants.delete(socketId);
    if (room.participants.size === 0) {
      this.rooms.delete(roomId);
      return undefined;
    }
    return room;
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
      hostId: room.hostId,
      participantsCount: room.participants.size,
    };
  }
}

export const roomService = new RoomService();
