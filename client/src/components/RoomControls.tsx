import { useEffect, useRef, useState } from "react";

interface Props {
  roomId: string;
  inviteUrl: string;
  currentVideoUrl: string | null;
  onChangeVideo: (newUrl: string) => void;
  connected: boolean;
}

type CopyState = "idle" | "copied" | "manual";

export default function RoomControls({
  roomId,
  inviteUrl,
  currentVideoUrl,
  onChangeVideo,
  connected,
}: Props) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [draftUrl, setDraftUrl] = useState("");
  /**
   * URL, який користувач щойно надіслав на сервер. Тримаємо у полі (input lишається
   * "сабмічений") аж поки сервер не підтвердить через `video:set` (тоді
   * `currentVideoUrl` зміниться на нього і ми очистимо поле). Якщо сервер
   * відмовив — поле лишається, користувач може поправити URL і пере-сабмітити.
   */
  const pendingUrl = useRef<string | null>(null);

  // Очищаємо поле тільки після того, як сервер реально прийняв URL і він повернувся
  // у room state. До цього моменту користувач бачить свій ввід (на випадок відмови).
  useEffect(() => {
    if (pendingUrl.current && currentVideoUrl === pendingUrl.current) {
      pendingUrl.current = null;
      setDraftUrl("");
    }
  }, [currentVideoUrl]);

  async function copy(): Promise<void> {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        setCopyState("copied");
        window.setTimeout(() => setCopyState("idle"), 1500);
        return;
      } catch {
        // Дозвіл відмовлено / SecurityError — падаємо у legacy-fallback нижче.
      }
    }
    // execCommand fallback. У сучасних браузерах це теж може повернути false
    // (deprecated на http), тоді просто показуємо "виділіть і скопіюйте вручну".
    const ta = document.createElement("textarea");
    ta.value = inviteUrl;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    if (ok) {
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } else {
      setCopyState("manual");
      window.setTimeout(() => setCopyState("idle"), 4000);
    }
  }

  function submitChange(e: React.FormEvent): void {
    e.preventDefault();
    const v = draftUrl.trim();
    if (!v) return;
    pendingUrl.current = v;
    onChangeVideo(v);
    // НЕ чистимо draftUrl зараз — почекаємо на серверний echo через `currentVideoUrl`.
  }

  const copyLabel =
    copyState === "copied"
      ? "Скопійовано"
      : copyState === "manual"
        ? "Скопіюй вручну"
        : "Копіювати посилання";

  return (
    <div className="room-controls">
      <div className="room-controls__row">
        <div>
          <div className="room-controls__label">Кімната</div>
          <div className="room-controls__room-id">{roomId}</div>
        </div>
        <div className="room-controls__connection">
          <span
            className={`status-dot ${connected ? "status-dot--ok" : "status-dot--bad"}`}
          />
          {connected ? "Підключено" : "Зʼєднання…"}
        </div>
      </div>

      <div className="room-controls__row">
        <input
          className="input"
          readOnly
          value={inviteUrl}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button className="button" onClick={copy} type="button">
          {copyLabel}
        </button>
      </div>

      <form className="room-controls__row" onSubmit={submitChange}>
        <input
          className="input"
          placeholder={currentVideoUrl ?? "Встав нове посилання на відео…"}
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
        />
        <button className="button button--secondary" type="submit" disabled={!draftUrl.trim()}>
          Замінити відео
        </button>
      </form>
    </div>
  );
}
