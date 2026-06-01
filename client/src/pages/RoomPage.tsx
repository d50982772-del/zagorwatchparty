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
  /** Серверний `Date.now()` на момент відправки DTO. Опційний (старі сервери / події без поля). */
  serverNow?: number;
  hostId: string;
  participantsCount: number;
}

/**
 * Рахуємо очікувану позицію відео у кімнаті прямо зараз. Якщо відео грає —
 * треба додати час, який минув з updatedAt. Якщо стоїть на паузі — позиція
 * така ж, як остання збережена.
 *
 * `clockSkewMs` — `serverNow - clientNow` з останнього room:state, додається до
 * Date.now(), щоб локальний `now` був у тому ж часовому базисі, що і `updatedAt`
 * сервера. Без цього drift correction помилявся б точно на різницю годинників.
 */
function expectedPosition(state: RoomState, clockSkewMs = 0): number {
  if (!state.isPlaying) return state.currentTime;
  const elapsedMs = Date.now() + clockSkewMs - state.updatedAt;
  return state.currentTime + Math.max(0, elapsedMs) / 1000;
}

/**
 * Якщо два послідовних `setInterval`-tick'и drift correction показують різницю
 * більше за цей поріг — клієнт явно вийшов з синку (швидше за все, через clock
 * skew або довге зависання вкладки). У цьому випадку шлемо `sync:request`, щоб
 * сервер прислав авторитативний `sync:correction`.
 */
const HEAVY_DRIFT_SECONDS = 5;
/** М'який поріг drift correction. Менше — ігноруємо, не сіпаємо плеєр. */
const SOFT_DRIFT_SECONDS = 1.5;

export default function RoomPage() {
  const { roomId = "" } = useParams<{ roomId: string }>();
  const [connected, setConnected] = useState(socket.connected);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  /**
   * Soft error — плашка у плеєрі з кнопкою "Створити нову кімнату". Окремий
   * стейт від `error` (фатальної сторінки), щоб користувач, якого кімнату
   * свіпнули після sleep'у, не лишався без опцій.
   */
  const [softRoomGone, setSoftRoomGone] = useState(false);

  const playerRef = useRef<VideoPlayerHandle | null>(null);

  /** Чи вже бачили хоча б один `room:state` для цієї кімнати. Якщо так — то
   * наступний `ROOM_NOT_FOUND` — це не фатальна "невірний роут", а м'яка
   * "кімната пропала" (sweep, рестарт сервера). */
  const seenRoomState = useRef(false);

  /** Чи плеєр уже зарепортив `onReady`. Drift correction повинен мовчати, поки
   * плеєр не готовий — інакше `getTime()` повертає 0 і drift сіпає у нікуди. */
  const playerReady = useRef(false);

  /** Зміщення часу: server.Date.now() - client.Date.now() на момент останнього
   * `room:state`. Використовується у `expectedPosition`, щоб drift correction
   * не помилявся на дельту годинників (особливо якщо клієнт у тимчасовій зоні з
   * NTP-помилкою). Ref, бо потрібен у inner-callback'ах без useEffect перебудови. */
  const clockSkewMs = useRef(0);

  /**
   * Захист від циклічних подій. Коли ми отримуємо команду від сервера і
   * застосовуємо її локально, плеєр може випалити власну play/pause/seek
   * подію — ми не повинні слати її назад.
   *
   * Лічильник, а не boolean: якщо два remote-event'и накладаються, boolean
   * скидав би guard передчасно.
   */
  const remoteActionDepth = useRef(0);

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

  function isApplyingRemoteAction(): boolean {
    return remoteActionDepth.current > 0;
  }

  const roomRef = useRef<RoomState | null>(null);
  roomRef.current = room;

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/room/${roomId}`;
  }, [roomId]);

  // --- Сокети та події кімнати ---
  useEffect(() => {
    function applyServerNow(state: { serverNow?: number }) {
      if (typeof state.serverNow === "number") {
        clockSkewMs.current = state.serverNow - Date.now();
      }
    }

    function onConnect() {
      setConnected(true);
      // На свіже з'єднання (включаючи reconnect) — пере-джойн.
      socket.emit("room:join", { roomId });
    }
    function onDisconnect() {
      setConnected(false);
      // Плеєр треба буде пере-синхронізувати після reconnect: тепер ми не знаємо,
      // чи стан кімнати у нас актуальний.
      playerReady.current = false;
    }

    function onRoomState(state: RoomState) {
      applyServerNow(state);
      seenRoomState.current = true;
      // Якщо повернулися з soft "кімната пропала" — кімната насправді є,
      // плашку прибираємо.
      setSoftRoomGone(false);
      setRoom(state);
    }

    function onRoomError(payload: { code: string; message: string }) {
      const msg = payload?.message || "Помилка кімнати";
      if (payload?.code === "ROOM_NOT_FOUND") {
        if (seenRoomState.current) {
          // Ми у кімнаті були. Швидше за все, нас свіпнули після sleep'у /
          // рестарту сервера. Не показуємо фатал — пропонуємо створити нову.
          setSoftRoomGone(true);
        } else {
          // Зайшли по застарілому посиланню — фатально.
          setError(msg);
        }
        return;
      }
      // Решта (INVALID_URL / UNSUPPORTED_SOURCE / RATE_LIMITED / ...) — нефатально.
      setPlayerError(msg);
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
      // Новий URL — плеєр буде перестворено, ready треба нулити.
      playerReady.current = false;
      // Користувацька INVALID_URL/UNSUPPORTED_SOURCE-помилка вже неактуальна,
      // якщо сервер прийняв новий URL.
      setPlayerError(null);
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
      applyServerNow(state);
      setRoom(state);
      if (!playerRef.current || !state.videoUrl) return;
      const target = expectedPosition(state, clockSkewMs.current);
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
      if (socket.connected) {
        socket.emit("room:leave", { roomId });
      }
      // При зміні roomId / unmount — обнуляємо seen-flag для нового RoomPage
      // (StrictMode mount→cleanup→mount це передбачає, ми один раз бачили
      // room:state у попередньому mount, але далі це нова сторінка).
      seenRoomState.current = false;
      playerReady.current = false;
    };
  }, [roomId]);

  // --- Початкова синхронізація після того, як VideoPlayer сигналізує onReady ---
  async function handlePlayerReady() {
    playerReady.current = true;
    const r = roomRef.current;
    if (!r || !r.videoUrl || !playerRef.current) return;
    const target = expectedPosition(r, clockSkewMs.current);
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
  useEffect(() => {
    const interval = setInterval(async () => {
      const r = roomRef.current;
      if (!r || !playerRef.current || !r.videoUrl) return;
      if (!playerReady.current) return; // плеєр ще не готовий — не сіпаємо
      if (isApplyingRemoteAction()) return;

      const expected = expectedPosition(r, clockSkewMs.current);
      const actual = playerRef.current.getTime();
      const diff = Math.abs(actual - expected);

      // Великий диф — попросимо у сервера авторитативний стан замість того, щоб
      // самим стрибати. Це покриває кейси, де клієнт довго був у sleep і його
      // expectedPosition давно неактуальний.
      if (diff > HEAVY_DRIFT_SECONDS) {
        socket.emit("sync:request", { roomId });
        return;
      }
      // Малий диф — м'яка локальна корекція без участі сервера.
      if (diff > SOFT_DRIFT_SECONDS) {
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

  // --- Локальні події плеєра: відправляємо на сервер + оптимістично оновлюємо локальний стан ---
  // Без оптимістичного апдейту: sender'у broadcast не приходить (server робить
  // socket.to, не io.to), і `roomRef.current.isPlaying/currentTime/updatedAt`
  // лишаються застарілими. Через 5с drift correction обчислює стейл-expected і
  // повертає плеєр на стару позицію — соло-сесія виглядає так, ніби play/seek
  // "відскакують назад".
  //
  // ВАЖЛИВО: `updatedAt` має бути у серверному часі, бо `expectedPosition()`
  // рахує elapsed як `Date.now() + clockSkewMs - updatedAt`. Якщо тут
  // записати чистий `Date.now()` (client time), drift correction після 5с
  // помилиться рівно на `clockSkewMs` і знову сіпне плеєр.
  function handleLocalPlay() {
    if (isApplyingRemoteAction()) return;
    const t = playerRef.current?.getTime() ?? 0;
    const now = Date.now() + clockSkewMs.current;
    setRoom((r) => (r ? { ...r, isPlaying: true, currentTime: t, updatedAt: now } : r));
    socket.emit("video:play", { roomId, currentTime: t });
  }

  function handleLocalPause() {
    if (isApplyingRemoteAction()) return;
    const t = playerRef.current?.getTime() ?? 0;
    const now = Date.now() + clockSkewMs.current;
    setRoom((r) => (r ? { ...r, isPlaying: false, currentTime: t, updatedAt: now } : r));
    socket.emit("video:pause", { roomId, currentTime: t });
  }

  function handleLocalSeek(time: number) {
    if (isApplyingRemoteAction()) return;
    const now = Date.now() + clockSkewMs.current;
    setRoom((r) => (r ? { ...r, currentTime: time, updatedAt: now } : r));
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
          {softRoomGone ? (
            <div className="room__placeholder">
              <p>
                Зʼєднання з кімнатою втрачено. Можливо, вона закрилась через
                бездіяльність. Можна створити нову.
              </p>
              <a className="button button--primary" href="/">
                Створити нову кімнату
              </a>
            </div>
          ) : !connected && !room ? (
            // Свіже відкриття /room/:id, ще не підключилися — даємо feedback,
            // а не порожній екран.
            <div className="room__placeholder">
              <p>Підключаємось до сервера…</p>
            </div>
          ) : room?.videoUrl ? (
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
