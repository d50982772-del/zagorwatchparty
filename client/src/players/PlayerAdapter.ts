/**
 * Спільний інтерфейс для всіх відео-плеєрів (YouTube / HTML5 / HLS).
 * Завдяки цьому RoomPage не знає, який саме плеєр під капотом — він лише
 * викликає load/play/pause/seek/getTime/isPlaying.
 *
 * Щоб додати нове джерело (наприклад, Vimeo або Twitch), достатньо створити
 * новий клас, що реалізує PlayerAdapter, і додати його у фабрику у VideoPlayer.
 */
export interface PlayerAdapter {
  /** Створює плеєр і завантажує задане джерело. Повертає Promise готовності. */
  load(url: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(time: number): Promise<void>;
  getTime(): number;
  isPlaying(): boolean;
  /** Прибирає за собою всі ресурси/слухачі. */
  destroy(): void;

  /** Колбеки, які адаптер кличе, коли користувач сам натиснув щось у плеєрі. */
  onPlay?: () => void;
  onPause?: () => void;
  onSeek?: (time: number) => void;
  /**
   * Виклик при runtime-помилці ПІСЛЯ того, як load() уже зарезолвився.
   * Приклади: YouTube повернув "embedding disabled", "video removed",
   * "configuration error"; HLS не зміг продовжити завантаження сегмента.
   * Помилки до завершення load() — це reject у load(); ці — це окремий канал.
   */
  onError?: (msg: string) => void;
}
