import { useState } from "react";

interface Props {
  roomId: string;
  inviteUrl: string;
  currentVideoUrl: string | null;
  onChangeVideo: (newUrl: string) => void;
  connected: boolean;
}

export default function RoomControls({
  roomId,
  inviteUrl,
  currentVideoUrl,
  onChangeVideo,
  connected,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback для старіших браузерів — просто виділяємо текст.
      const ta = document.createElement("textarea");
      ta.value = inviteUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  function submitChange(e: React.FormEvent): void {
    e.preventDefault();
    const v = draftUrl.trim();
    if (!v) return;
    onChangeVideo(v);
    setDraftUrl("");
  }

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
          {copied ? "Скопійовано" : "Копіювати посилання"}
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
