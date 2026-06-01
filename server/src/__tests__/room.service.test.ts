import { describe, it, expect, beforeEach } from "vitest";
import { roomService, ROOM_GRACE_MS } from "../rooms/room.service";

// Перед кожним тестом скидаємо стан сервісу (in-memory map). Сервіс експортується
// як singleton, тож нам потрібно повністю очистити кімнати, які могли залишитися
// з попередніх тестів.
function resetService(): void {
  const internal = roomService as unknown as { rooms: Map<string, unknown> };
  internal.rooms.clear();
}

describe("RoomService", () => {
  beforeEach(() => resetService());

  it("createRoom повертає кімнату з валідним id, без учасників, з emptySince", () => {
    const room = roomService.createRoom("host-socket-1");
    expect(room.roomId).toMatch(/^[0-9a-z]{8}$/);
    expect(room.hostId).toBe("host-socket-1");
    expect(room.participants.size).toBe(0);
    expect(room.emptySince).not.toBeNull();
    expect(room.videoUrl).toBeNull();
  });

  it("addParticipant скасовує emptySince", () => {
    const room = roomService.createRoom("host");
    expect(room.emptySince).not.toBeNull();
    roomService.addParticipant(room.roomId, "client-1");
    expect(room.emptySince).toBeNull();
    expect(room.participants.size).toBe(1);
  });

  it("removeParticipant: якщо останній учасник вийшов, виставляє emptySince але не видаляє", () => {
    const room = roomService.createRoom("host");
    roomService.addParticipant(room.roomId, "client-1");
    expect(room.emptySince).toBeNull();
    const updated = roomService.removeParticipant(room.roomId, "client-1");
    expect(updated).toBeDefined();
    expect(updated!.emptySince).not.toBeNull();
    // Кімната ще існує — grace period дозволяє reconnect.
    expect(roomService.getRoom(room.roomId)).toBeDefined();
  });

  it("sweepStaleRooms видаляє кімнати, які протухли довше за grace period", () => {
    const room = roomService.createRoom("host");
    // Емуляція: кімната була порожньою 10 хвилин тому.
    const longAgo = Date.now() - ROOM_GRACE_MS - 1000;
    (room as { emptySince: number | null }).emptySince = longAgo;

    const removed = roomService.sweepStaleRooms();
    expect(removed).toBe(1);
    expect(roomService.getRoom(room.roomId)).toBeUndefined();
  });

  it("sweepStaleRooms НЕ видаляє кімнати з активними учасниками", () => {
    const room = roomService.createRoom("host");
    roomService.addParticipant(room.roomId, "client-1");
    // emptySince === null — кімната зайнята.
    const removed = roomService.sweepStaleRooms();
    expect(removed).toBe(0);
    expect(roomService.getRoom(room.roomId)).toBeDefined();
  });

  it("isParticipant повертає true тільки для тих, хто увійшов через addParticipant", () => {
    const room = roomService.createRoom("host");
    roomService.addParticipant(room.roomId, "client-1");
    expect(roomService.isParticipant(room.roomId, "client-1")).toBe(true);
    expect(roomService.isParticipant(room.roomId, "stranger")).toBe(false);
    expect(roomService.isParticipant("non-existent", "client-1")).toBe(false);
  });

  it("toDTO включає serverNow", () => {
    const room = roomService.createRoom("host");
    const dto = roomService.toDTO(room);
    expect(typeof dto.serverNow).toBe("number");
    // serverNow має бути близько до Date.now()
    expect(Math.abs(dto.serverNow - Date.now())).toBeLessThan(1000);
  });
});
