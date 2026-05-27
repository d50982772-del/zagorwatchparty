# Watch Party

Простий MVP вебзастосунку для **синхронного спільного перегляду відео**.
Користувач вставляє посилання на відео, створює кімнату, надсилає посилання друзям — і всі дивляться разом. Play / pause / seek синхронізуються між усіма учасниками в реальному часі.

Стек:

- **Frontend:** React + Vite + TypeScript + `socket.io-client` + YouTube IFrame API + `hls.js`
- **Backend:** Node.js + Express + TypeScript + Socket.IO (in-memory, без БД)
- Підтримка: YouTube, прямі відеофайли (`.mp4` / `.webm` / `.ogg`), HLS (`.m3u8`).

> Застосунок працює лише з **легально доступними embed / direct video URL**. Сервер
> не проксує і не викачує відео — він синхронізує тільки стан перегляду.

---

## Структура репо

```
zagorwatchparty/
├─ client/         # React + Vite frontend
│  └─ src/
│     ├─ App.tsx
│     ├─ main.tsx
│     ├─ pages/                # HomePage, RoomPage
│     ├─ components/           # VideoPlayer, RoomControls, UsersCounter
│     ├─ players/              # Адаптери: YouTube / HTML5 / HLS
│     ├─ socket/socket.ts      # Один спільний Socket.IO клієнт
│     ├─ utils/                # detectSourceType, parseYouTubeId
│     └─ styles/global.css
├─ server/         # Express + Socket.IO backend
│  └─ src/
│     ├─ index.ts
│     ├─ rooms/                # room.types.ts, room.service.ts
│     ├─ sockets/              # socket.handlers.ts
│     └─ utils/                # detectSourceType.ts
└─ README.md
```

---

## Запуск локально

Потрібно **Node.js 18+** (рекомендовано 20+).

### 1. Backend

```bash
cd server
cp .env.example .env        # (опційно — за замовчуванням працює і так)
npm install
npm run dev
```

Сервер підніметься на `http://localhost:4000`. Перевірити: `GET /health`.

### 2. Frontend

В іншому терміналі:

```bash
cd client
cp .env.example .env        # (опційно)
npm install
npm run dev
```

Vite дев-сервер: `http://localhost:5173`. У dev режимі Vite сам **проксує** запити
`/socket.io` на backend (див. `client/vite.config.ts`), тож зайвих CORS налаштувань
не треба.

### 3. Як користуватись

1. Відкрити `http://localhost:5173`.
2. Вставити посилання на відео (можна залишити порожнім і додати потім).
3. Натиснути «Створити кімнату» → редірект на `/room/:roomId`.
4. Скопіювати invite-посилання і надіслати іншим людям.
5. Будь-який play / pause / seek на одному клієнті повторюється у всіх.

---

## Змінні оточення

### `server/.env`

```env
PORT=4000
CORS_ORIGIN=http://localhost:5173
```

`CORS_ORIGIN` може містити кілька значень через кому (наприклад, для preview-середовищ).

### `client/.env`

```env
# Необовʼязково в dev. У продакшні — публічна адреса backend.
VITE_BACKEND_URL=http://localhost:4000
```

У dev режимі залишай порожнім — Vite проксує `/socket.io` на `localhost:4000`.

---

## Як працює синхронізація

### Стан кімнати на сервері

Для кожної кімнати сервер тримає у памʼяті:

```ts
{
  roomId, videoUrl, sourceType,
  isPlaying, currentTime, updatedAt,
  hostId, participants: Set<socketId>
}
```

`updatedAt` — це момент часу (UTC ms), коли востаннє оновлювали стан відтворення.
Це ключове поле для синхронізації нових учасників: якщо `isPlaying === true`, то
реальна позиція відео зараз =

```
expectedPosition = currentTime + (Date.now() - updatedAt) / 1000
```

Сервер не намагається бути «розумним» — він просто **зберігає останній стан і
ретранслює події** всім іншим клієнтам у кімнаті.

### Події Socket.IO

**Клієнт → сервер**

| Подія           | Payload                                | Що робить                      |
| --------------- | -------------------------------------- | ------------------------------ |
| `room:create`   | `{ videoUrl? }`                        | Створити нову кімнату          |
| `room:join`     | `{ roomId }`                           | Приєднатись до існуючої        |
| `room:leave`    | `{ roomId }`                           | Явно вийти з кімнати           |
| `video:set`     | `{ roomId, videoUrl }`                 | Змінити джерело відео          |
| `video:play`    | `{ roomId, currentTime }`              | Старт із часу                  |
| `video:pause`   | `{ roomId, currentTime }`              | Пауза із часу                  |
| `video:seek`    | `{ roomId, currentTime }`              | Перемотка                      |
| `sync:request`  | `{ roomId }`                           | Запит актуального стану        |

**Сервер → клієнт**

| Подія              | Payload                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `room:created`     | `{ roomId }`                                                            |
| `room:state`       | повний `RoomStateDTO`                                                   |
| `room:error`       | `{ code, message }`                                                     |
| `video:set`        | `{ videoUrl, sourceType, currentTime, isPlaying, updatedAt }`           |
| `video:play`       | `{ currentTime, updatedAt }`                                            |
| `video:pause`      | `{ currentTime, updatedAt }`                                            |
| `video:seek`       | `{ currentTime, updatedAt }`                                            |
| `users:update`     | `{ participantsCount }`                                                 |
| `sync:correction`  | повний `RoomStateDTO` (відповідь на `sync:request`)                    |

### Захист від циклічних подій

Коли клієнт **отримує** віддалену команду (`video:play`/`pause`/`seek`), він має
застосувати її до плеєра, але **не повертати назад** на сервер цю ж подію. Інакше
буде нескінченний цикл.

Це робиться прапорцем `isApplyingRemoteAction` у `RoomPage.tsx`:

1. Прийняли `video:play` → ставимо `isApplyingRemoteAction = true`.
2. Викликаємо `player.seek(...)`, `player.play()`.
3. Плеєр випалює локальну подію `play` → у локальному обробнику бачимо, що
   `isApplyingRemoteAction === true`, і **нічого не відправляємо на сервер**.
4. Знімаємо прапорець через `setTimeout(..., 50)`, коли події плеєра вже відіграли.

### Drift correction

Раз на 5 секунд клієнт порівнює свою реальну позицію з очікуваною позицією
кімнати (порахованою з `currentTime + updatedAt`):

- якщо різниця **< 1.5 c** — не чіпає плеєр (щоб відео не сіпало);
- якщо більша — м'яко перемотує на правильну позицію через `seek()`.

Це знімає накопичений drift (різниця пінгів, паузи через буферизацію тощо) без
агресивного «смикання» плеєра.

### Початкова синхронізація нового учасника

Послідовність:

1. Клієнт підключається, шле `room:join`.
2. Сервер додає його у `Socket.IO room`, відповідає `room:state` із поточним станом.
3. Клієнт ініціалізує адаптер плеєра під `sourceType`, чекає його готовності.
4. Перед `play` робиться `seek` на `expectedPosition`, потім `play()` або `pause()`.
5. Далі стан тримається `drift correction`'ом.

---

## Як додати підтримку нових джерел відео

Архітектура — **адаптери з єдиним інтерфейсом**.

1. Реалізуй новий клас, що відповідає інтерфейсу `PlayerAdapter`
   (`client/src/players/PlayerAdapter.ts`):

   ```ts
   load(url: string): Promise<void>;
   play(): Promise<void>;
   pause(): Promise<void>;
   seek(time: number): Promise<void>;
   getTime(): number;
   isPlaying(): boolean;
   destroy(): void;

   // Колбеки локальних дій користувача:
   onPlay?: () => void;
   onPause?: () => void;
   onSeek?: (time: number) => void;
   ```

2. Додай новий тип у `detectSourceType.ts` **на клієнті і на сервері** — обидві
   функції мають бути синхронізовані.
3. У `client/src/components/VideoPlayer.tsx`, у `createAdapter()`, додай гілку
   `switch`, яка створює новий адаптер для відповідного `SourceType`.
4. (Опційно) Якщо джерело потребує своїх payload-полів — розшир `room:state`
   та інші типи.

Все. RoomPage не знає, що в нього під капотом. Синхронізація працює однаково.

---

## Хостинг (production)

### Backend

Це звичайний Node.js застосунок з Socket.IO. Підійде будь-який VPS / PaaS, який
підтримує **WebSockets** (важливо: треба саме `ws`-апгрейд, а не лише HTTP).

#### Варіант 1: Railway / Render / Fly.io / Heroku alternative

1. Створи новий сервіс із цього репо, root directory: `server/`.
2. Build command: `npm install && npm run build`
3. Start command: `npm run start` (запускає скомпільований `dist/index.js`).
4. Виставити env:
   - `PORT` — провайдер сам зазвичай задає, але Express бере з `process.env.PORT`;
   - `CORS_ORIGIN=https://your-frontend.example.com` (домен фронта).
5. Переконатися, що WebSockets дозволені (більшість сучасних PaaS це підтримує
   з коробки).

#### Варіант 2: Власний VPS + systemd / Docker

```bash
cd server
npm install
npm run build
PORT=4000 CORS_ORIGIN=https://your-frontend.example.com node dist/index.js
```

Поставити це за **Nginx reverse proxy** з підтримкою WebSocket upgrade:

```nginx
location /socket.io/ {
  proxy_pass http://127.0.0.1:4000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

Не забути `certbot --nginx` для HTTPS — інакше браузер може не пускати ws → wss.

### Frontend

`client/` — це статика, яку треба зібрати і задеплоїти куди завгодно.

```bash
cd client
VITE_BACKEND_URL=https://your-backend.example.com npm run build
# далі вміст dist/ деплоїться на хостинг статики
```

Варіанти:

- **Vercel / Netlify / Cloudflare Pages.** Підкласти `client/` як корінь, build
  command `npm run build`, output `dist`. Додати env `VITE_BACKEND_URL`.
- **Nginx.** Закинути `dist/` у `/var/www/watchparty`, додати fallback на
  `index.html` для SPA-роутера:

  ```nginx
  location / {
    try_files $uri /index.html;
  }
  ```

### Поради по продакшну

- Тримати backend і frontend на **одному origin** (через Nginx або CDN-проксі) —
  це знімає проблеми з CORS і дає wss «безкоштовно».
- Якщо різні домени — стежити, щоб у backend `CORS_ORIGIN` містив **точний**
  публічний домен фронта (зокрема зі схемою `https://`).
- Для масштабування на кілька інстансів backend — потрібно винести стан кімнат
  з памʼяті (Redis) і використати [Socket.IO adapter](https://socket.io/docs/v4/redis-adapter/).
  Для MVP цього не потрібно.

---

## Обмеження MVP

- Стан кімнат живе в памʼяті — при перезапуску backend всі кімнати втрачаються.
- Підтримуються лише YouTube embed, прямі відеофайли і HLS. **Не реалізовано**
  обхід DRM, скрапінг прямих URL із YouTube, проксіювання чужих відео або
  підтримка піратських сайтів.
- Немає чату, реєстрації, прав ведучого — будь-який учасник може керувати
  плеєром. Це навмисно для першої ітерації.
