import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { socket } from "../socket/socket";
import { detectSourceType } from "../utils/detectSourceType";

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const navigate = useNavigate();

  useEffect(() => {
    function onConnect() {
      setConnected(true);
    }
    function onDisconnect() {
      setConnected(false);
    }
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = url.trim();
    if (trimmed && detectSourceType(trimmed) === "unknown") {
      setError(
        "Не вдалося визначити тип відео. Підтримуються YouTube, .mp4, .webm, .ogg, .m3u8."
      );
      return;
    }

    setCreating(true);
    socket.emit("room:create", { videoUrl: trimmed || undefined });

    const onCreated = ({ roomId }: { roomId: string }) => {
      socket.off("room:created", onCreated);
      navigate(`/room/${roomId}`);
    };
    socket.on("room:created", onCreated);
  }

  return (
    <div className="layout">
      <header className="layout__header">
        <h1 className="logo">Watch Party</h1>
        <p className="logo__subtitle">
          Створи кімнату, поділись посиланням і дивіться відео разом — синхронно.
        </p>
      </header>

      <main className="layout__main">
        <div className="card">
          <h2 className="card__title">Нова кімната</h2>
          <p className="card__description">
            Встав посилання на YouTube, прямий відеофайл (.mp4 / .webm / .ogg) або HLS-потік
            (.m3u8). Поле можна залишити порожнім і вставити URL вже всередині кімнати.
          </p>

          <form onSubmit={handleCreate} className="form">
            <input
              className="input input--big"
              type="text"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
            {error && <div className="error">{error}</div>}
            <button className="button button--primary" type="submit" disabled={creating}>
              {creating ? "Створюємо…" : "Створити кімнату"}
            </button>
          </form>

          <div className="status">
            <span
              className={`status-dot ${connected ? "status-dot--ok" : "status-dot--bad"}`}
            />
            {connected ? "Підключено до сервера" : "Зʼєднуємось із сервером…"}
          </div>
        </div>

        <ul className="features">
          <li>Один натиск на play/pause/seek — і всі інші бачать те саме.</li>
          <li>Drift correction кожні 5с, щоб відео не розповзалось у часі.</li>
          <li>Сервер синхронізує лише стан перегляду, не самі відео.</li>
        </ul>
      </main>

      <footer className="layout__footer">
        Використовуйте лише легально доступний контент. Watch Party не проксує і не
        викачує відео.
      </footer>
    </div>
  );
}
