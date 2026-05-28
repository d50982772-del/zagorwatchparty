import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import VideoPlayer, { type VideoPlayerHandle } from "../components/VideoPlayer";
import RoomControls from "../components/RoomControls";
import UsersCounter from "../components/UsersCounter";
import { socket } from "../socket/socket";
import { detectSourceType, type SourceType } from "../utils/detectSourceType";

interface RoomState {
  roomId: string;
  videoUrl: string | null;
  sourceType: SourceType;
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
  hostId: string;
  participantsCount: number;
}

/**
 * Рахуємо очікувану позицію відео у кімнаті прямо зараз. Якщо відео грає —
 * треба додати час, який минув з updatedAt. Якщо стоїть на паузі — позиція
 * така ж, як остання збережена.
 */
function expectedPosition(state: RoomState): number {
  if (!state.isPlaying) return state.currentTime;
  const elapsedMs = Date.now() - state.updatedAt;
  return state.currentTime + Math.max(0, elapsedMs) / 1000;
}

export default function RoomPage() {
  const { roomId = "" } = useParams<{ roomId: string }>();
  const [connected, setConnected] = useState(socket.connected);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const playerRef = useRef<VideoPlayerHandle | null>(null);

  /**
   * Захист від циклічних подій. Коли ми отримуємо команду від сервера і
   * застосовуємо її локально, плеєр може випалити власну play/pause/seek
   * подію — ми не повинні слати її назад.
   *
   * Лічильник, а не boolean: якщо два remote-event'и накладаються (наприклад,
   * швидке pause+seek в одного учасника, перші 50ms ще не минули), boolean
   * скидав би guard передчасно — другий `setTimeout(50)` зняв би прапорець
   * поки перший ще "у польоті". З depth-counter обидва release'и спершу
   * декрементять, і `> 0` лишається істинним, поки і другий не релізиться.
   */
  const remoteActionDepth = useRef(0);

  /**
   * Інкремент depth, повертає release() з setTimeout-декрементом.
   * delayMs контролює, скільки тримати guard після завершення await-чейну —
   * це форум для повільних async-подій плеєра (наприклад YouTube state change
   * приходить через ~100-500ms після playVideo()).
   */
  function beginRemoteAction(delayMs = 50): () => void {
    remoteActionDepth.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setTimeout(() => {
        remoteActionDepth.current = Math.max(0, remoteActionDepth.current - 1);
      }, delayMs);
    };
  }

  /** Чи зараз застосовуємо remote-команду — для guard'ів у локальних обробниках. */
  function isApplyingRemoteAction(): boolean {
    return remoteActionDepth.current > 0;
  }

  // Останній стан кімнати в ref'і — щоб onReady міг прочитати його без closure-stale.
  const roomRef = useRef<RoomState | null>(null);
  roomRef.current = room;

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/room/${roomId}`;
  }, [roomId]);

  // --- Сокети та події кімнати ---
  useEffect(() => {
    function onConnect() {
      setConnected(true);
      socket.emit("room:join", { roomId });
    }
    function onDisconnect() {
      setConnected(false);
    }

    function onRoomState(state: RoomState) {
      setRoom(state);
    }

    function onRoomError(payload: { code: string; message: string }) {
      // ROOM_NOT_FOUND — фатально (кімнати немає, кімнатну сторінку нічого показувати).
      // Решта (INVALID_URL і подібні валідаційні помилки) — нефатальні: показуємо
      // інлайн повідомлення у плеєрі, кімната залишається робочою.
      const msg = payload?.message || "Помилка кімнати";
      if (payload?.code === "ROOM_NOT_FOUND") {
        setError(msg);
      } else {
        setPlayerError(msg);
      }
    }

    function onUsersUpdate(payload: { participantsCount: number }) {
      setRoom((r) => (r ? { ...r, participantsCount: payload.participantsCount } : r));
    }

    function onVideoSet(payload: {
      videoUrl: string;
      sourceType: SourceType;
      currentTime: number;
      isPlaying: boolean;
      updatedAt: number;
    }) {
      setRoom((r) =>
        r
          ? {
              ...r,
              videoUrl: payload.videoUrl,
              sourceType: payload.sourceType,
              currentTime: payload.currentTime,
              isPlaying: payload.isPlaying,
              updatedAt: payload.updatedAt,
            }
          : r
      );
    }

    async function onVideoPlay(payload: { currentTime: number; updatedAt: number }) {
      setRoom((r) => (r ? { ...r, isPlaying: true, ...payload } : r));
      if (!playerRef.current) return;
      const release = beginRemoteAction();
      try {
        // Підтягуємо позицію перед play, щоб не стартувати "зі старого часу".
        await playerRef.current.seek(payload.currentTime);
        await playerRef.current.play();
      } finally {
        release();
      }
    }

    async function onVideoPause(payload: { currentTime: number; updatedAt: number }) {
      setRoom((r) => (r ? { ...r, isPlaying: false, ...payload } : r));
      if (!playerRef.current) return;
      const release = beginRemoteAction();
      try {
        await playerRef.current.pause();
        await playerRef.current.seek(payload.currentTime);
      } finally {
        release();
      }
    }

    async function onVideoSeek(payload: { currentTime: number; updatedAt: number }) {
      setRoom((r) => (r ? { ...r, ...payload } : r));
      if (!playerRef.current) return;
      const release = beginRemoteAction();
      try {
        await playerRef.current.seek(payload.currentTime);
      } finally {
        release();
      }
    }

    async function onSyncCorrection(state: RoomState) {
      setRoom(state);
      if (!playerRef.current || !state.videoUrl) return;
      const target = expectedPosition(state);
      const release = beginRemoteAction(100);
      try {
        await playerRef.current.seek(target);
        if (state.isPlaying) await playerRef.current.play();
        else await playerRef.current.pause();
      } finally {
        release();
      }
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:state", onRoomState);
    socket.on("room:error", onRoomError);
    socket.on("users:update", onUsersUpdate);
    socket.on("video:set", onVideoSet);
    socket.on("video:play", onVideoPlay);
    socket.on("video:pause", onVideoPause);
    socket.on("video:seek", onVideoSeek);
    socket.on("sync:correction", onSyncCorrection);

    // Якщо сокет вже підключений на момент монтування — одразу джойнимось.
    if (socket.connected) {
      socket.emit("room:join", { roomId });
    } else {
      socket.connect();
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:state", onRoomState);
      socket.off("room:error", onRoomError);
      socket.off("users:update", onUsersUpdate);
      socket.off("video:set", onVideoSet);
      socket.off("video:play", onVideoPlay);
      socket.off("video:pause", onVideoPause);
      socket.off("video:seek", onVideoSeek);
      socket.off("sync:correction", onSyncCorrection);
      // Явно виходимо з кімнати на сервері, щоб після навігації не ловити
      // play/pause/seek зі старої кімнати (сокет клієнта — сінглтон).
      if (socket.connected) {
        socket.emit("room:leave", { roomId });
      }
    };
  }, [roomId]);

  // --- Початкова синхронізація після того, як VideoPlayer сигналізує onReady ---
  async function handlePlayerReady() {
    const r = roomRef.current;
    if (!r || !r.videoUrl || !playerRef.current) return;
    const target = expectedPosition(r);
    const release = beginRemoteAction(100);
    try {
      await playerRef.current.seek(target);
      if (r.isPlaying) {
        await playerRef.current.play();
      } else {
        await playerRef.current.pause();
      }
    } finally {
      release();
    }
  }

  // --- Drift correction: раз на 5 секунд звіряємо позицію ---
  // Залежність — лише `roomId`: інтервал має жити рівно один раз на кімнату.
  // Якби тут стояло `[room]`, кожен `users:update` / `video:play` / `video:seek`
  // створював би нову object reference → useEffect перезапускався б → інтервал
  // постійно скидався і реально ніколи не "достигав" 5 секунд. Актуальний стан
  // читаємо з `roomRef.current` всередині callback'у.
  useEffect(() => {
    const interval = setInterval(async () => {
      const r = roomRef.current;
      if (!r || !playerRef.current || !r.videoUrl) return;
      // Не коригуємо, поки ми посеред застосування remote-команди.
      if (isApplyingRemoteAction()) return;

      const expected = expectedPosition(r);
      const actual = playerRef.current.getTime();
      const diff = Math.abs(actual - expected);

      // Поріг 1.5с — нижче нього не чіпаємо, щоб не сіпало.
      if (diff > 1.5) {
        const release = beginRemoteAction(100);
        try {
          await playerRef.current.seek(expected);
        } finally {
          release();
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [roomId]);

  // --- Локальні події плеєра: відправляємо на сервер ---
  function handleLocalPlay() {
    if (isApplyingRemoteAction()) return;
    const t = playerRef.current?.getTime() ?? 0;
    socket.emit("video:play", { roomId, currentTime: t });
  }

  function handleLocalPause() {
    if (isApplyingRemoteAction()) return;
    const t = playerRef.current?.getTime() ?? 0;
    socket.emit("video:pause", { roomId, currentTime: t });
  }

  function handleLocalSeek(time: number) {
    if (isApplyingRemoteAction()) return;
    socket.emit("video:seek", { roomId, currentTime: time });
  }

  // --- Заміна відео з UI ---
  function handleChangeVideo(newUrl: string) {
    if (detectSourceType(newUrl) === "unknown") {
      setPlayerError("Це джерело відео не підтримується");
      return;
    }
    setPlayerError(null);
    socket.emit("video:set", { roomId, videoUrl: newUrl });
  }

  if (error) {
    return (
      <div className="layout">
        <header className="layout__header">
          <h1 className="logo">Watch Party</h1>
        </header>
        <main className="layout__main">
          <div className="card">
            <h2 className="card__title">Помилка</h2>
            <p className="error">{error}</p>
            <a className="button button--secondary" href="/">
              На головну
            </a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="layout layout--room">
      <header className="layout__header layout__header--room">
        <a href="/" className="logo logo--small">
          Watch Party
        </a>
        <UsersCounter count={room?.participantsCount ?? 0} />
      </header>

      <main className="room">
        <div className="room__player">
          {room?.videoUrl ? (
            <VideoPlayer
              ref={playerRef}
              url={room.videoUrl}
              onLocalPlay={handleLocalPlay}
              onLocalPause={handleLocalPause}
              onLocalSeek={handleLocalSeek}
              onError={(msg) => setPlayerError(msg)}
              onReady={handlePlayerReady}
            />
          ) : (
            <div className="room__placeholder">
              <p>Відео ще не вибране. Встав посилання нижче — воно зʼявиться у всіх.</p>
            </div>
          )}
          {playerError && <div className="error room__error">{playerError}</div>}
        </div>

        <aside className="room__sidebar">
          <RoomControls
            roomId={roomId}
            inviteUrl={inviteUrl}
            currentVideoUrl={room?.videoUrl ?? null}
            onChangeVideo={handleChangeVideo}
            connected={connected}
          />
        </aside>
      </main>
    </div>
  );
}
