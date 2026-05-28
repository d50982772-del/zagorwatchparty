import type { SourceType } from "../utils/detectSourceType";

/**
 * Внутрішній стан кімнати, який зберігається в памʼяті сервера.
 *
 * currentTime + updatedAt дають змогу клієнту, який тільки-но підʼєднався,
 * порахувати очікувану позицію плеєра з урахуванням часу, який минув з
 * моменту останнього оновлення.
 */
export interface Room {
  roomId: string;
  videoUrl: string | null;
  sourceType: SourceType;
  isPlaying: boolean;
  currentTime: number;
  /** Unix timestamp у мс, коли востаннє оновлювався стан відтворення. */
  updatedAt: number;
  /** socketId користувача, який створив кімнату. */
  hostId: string;
  /** Учасники кімнати (Socket.IO socket id). */
  participants: Set<string>;
  /**
   * Unix timestamp у мс, коли кімната востаннє стала порожньою (або була щойно
   * створена і ніхто ще не зайшов). null, якщо в кімнаті є хоч один учасник.
   * Sweeper періодично видаляє кімнати, які залишаються порожніми довше за
   * grace period — це покриває і StrictMode mount→cleanup→mount у dev, і
   * "осиротілі" кімнати, у які hostId так і не зайшов.
   */
  emptySince: number | null;
}

/**
 * Те, що ми віддаємо клієнтам, — без Set, тільки серіалізовані поля.
 */
export interface RoomStateDTO {
  roomId: string;
  videoUrl: string | null;
  sourceType: SourceType;
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
  hostId: string;
  participantsCount: number;
}
