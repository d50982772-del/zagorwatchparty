#!/usr/bin/env node
/* eslint-disable */
// Копіює всі файли з shared/ у client/src/utils/ і server/src/utils/.
// Викликається перед збіркою кожного проекту (через npm script "prebuild" або
// перший крок у "build"), щоб уникнути дрейфу між двома сторонами.
//
// Чому копія, а не імпорт ".../shared/..."? Тому що:
//  - server: rootDir у tsconfig — `src/`, ts не дозволяє файли поза rootDir;
//  - client: vite/tsc працює тільки з include `src/`;
//  - щоб не лагодити TS project references і не плутати IDE-навігацію.
//
// Файли копіюються 1-в-1, тож git-diff видно одразу, якщо хтось редагував копію
// (це проти-патерн і прибереться наступним sync).

const fs = require("node:fs");
const path = require("node:path");

const SHARED = __dirname;
const ROOT = path.resolve(SHARED, "..");
const TARGETS = [
  path.join(ROOT, "client", "src", "utils"),
  path.join(ROOT, "server", "src", "utils"),
];

const files = fs
  .readdirSync(SHARED, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".ts"))
  .map((d) => d.name);

for (const target of TARGETS) {
  fs.mkdirSync(target, { recursive: true });
  for (const f of files) {
    const src = path.join(SHARED, f);
    const dst = path.join(target, f);
    const srcContent = fs.readFileSync(src);
    let needWrite = true;
    if (fs.existsSync(dst)) {
      const dstContent = fs.readFileSync(dst);
      if (srcContent.equals(dstContent)) needWrite = false;
    }
    if (needWrite) {
      fs.writeFileSync(dst, srcContent);
      process.stdout.write(`[shared/sync] wrote ${path.relative(ROOT, dst)}\n`);
    }
  }
}
