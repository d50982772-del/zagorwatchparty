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
   * isApplyingRemoteAction — захист від циклічних подій. Коли ми отримуємо
   * команду від сервера і застосовуємо її локально, плеєр може випалити
   * власну play/pause/seek подію. Цей прапорець каже їй: «не шли назад».
   */
  const isApplyingRemoteAction = useRef(false);

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
      setError(payload?.message || "Помилка кімнати");
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
      isApplyingRemoteAction.current = true;
      try {
        // Підтягуємо позицію перед play, щоб не стартувати "зі старого часу".
        await playerRef.current.seek(payload.currentTime);
        await playerRef.current.play();
      } finally {
        // Невеликий timeout, щоб дочекатися eventів плеєра.
        setTimeout(() => (isApplyingRemoteAction.current = false), 50);
      }
    }

    async function onVideoPause(payload: { currentTime: number; updatedAt: number }) {
      setRoom((r) => (r ? { ...r, isPlaying: false, ...payload } : r));
      if (!playerRef.current) return;
      isApplyingRemoteAction.current = true;
      try {
        await playerRef.current.pause();
        await playerRef.current.seek(payload.currentTime);
      } finally {
        setTimeout(() => (isApplyingRemoteAction.current = false), 50);
      }
    }

    async function onVideoSeek(payload: { currentTime: number; updatedAt: number }) {
      setRoom((r) => (r ? { ...r, ...payload } : r));
      if (!playerRef.current) return;
      isApplyingRemoteAction.current = true;
      try {
        await playerRef.current.seek(payload.currentTime);
      } finally {
        setTimeout(() => (isApplyingRemoteAction.current = false), 50);
      }
    }

    async function onSyncCorrection(state: RoomState) {
      setRoom(state);
      if (!playerRef.current || !state.videoUrl) return;
      const target = expectedPosition(state);
      isApplyingRemoteAction.current = true;
      try {
        await playerRef.current.seek(target);
        if (state.isPlaying) await playerRef.current.play();
        else await playerRef.current.pause();
      } finally {
        setTimeout(() => (isApplyingRemoteAction.current = false), 100);
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
    };
  }, [roomId]);

  // --- Початкова синхронізація після приєднання + drift correction ---
  useEffect(() => {
    if (!room || !room.videoUrl || !playerRef.current) return;

    // Одразу після того, як плеєр готовий, скоригуємо позицію під стан кімнати.
    const target = expectedPosition(room);
    isApplyingRemoteAction.current = true;
    (async () => {
      try {
        await playerRef.current?.seek(target);
        if (room.isPlaying) {
          await playerRef.current?.play();
        } else {
          await playerRef.current?.pause();
        }
      } finally {
        setTimeout(() => (isApplyingRemoteAction.current = false), 100);
      }
    })();
    // Запускаємо одноразово на зміну URL, оскільки далі drift correction робить решту.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.videoUrl]);

  // --- Drift correction: раз на 5 секунд звіряємо позицію ---
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!room || !playerRef.current || !room.videoUrl) return;
      // Не коригуємо, поки ми посеред застосування remote-команди.
      if (isApplyingRemoteAction.current) return;

      const expected = expectedPosition(room);
      const actual = playerRef.current.getTime();
      const diff = Math.abs(actual - expected);

      // Поріг 1.5с — нижче нього не чіпаємо, щоб не сіпало.
      if (diff > 1.5) {
        isApplyingRemoteAction.current = true;
        try {
          await playerRef.current.seek(expected);
        } finally {
          setTimeout(() => (isApplyingRemoteAction.current = false), 100);
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [room]);

  // --- Локальні події плеєра: відправляємо на сервер ---
  function handleLocalPlay() {
    if (isApplyingRemoteAction.current) return;
    const t = playerRef.current?.getTime() ?? 0;
    socket.emit("video:play", { roomId, currentTime: t });
  }

  function handleLocalPause() {
    if (isApplyingRemoteAction.current) return;
    const t = playerRef.current?.getTime() ?? 0;
    socket.emit("video:pause", { roomId, currentTime: t });
  }

  function handleLocalSeek(time: number) {
    if (isApplyingRemoteAction.current) return;
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
