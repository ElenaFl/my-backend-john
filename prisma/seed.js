import { createClient } from "@libsql/client";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Открываем базу данных напрямую как файл
const db = createClient({ url: "file:./prisma/dev.db" });

async function main() {
  console.log("Начинаем импорт данных из data.json...");

  const dataPath = path.join(__dirname, "../data.json");
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Файл data.json не найден по пути: ${dataPath}`);
  }

  const rawData = fs.readFileSync(dataPath, "utf-8");
  // ДОБАВИЛИ subscribers в деструктуризацию:
  const { posts, works, subscribers } = JSON.parse(rawData);

  // 1. Очищаем старые данные
  await db.execute("DELETE FROM Post");
  await db.execute("DELETE FROM Work");
  await db.execute("DELETE FROM Subscribers"); // ДОБАВИЛИ очистку подписчиков
  console.log("Старые данные успешно удалены из базы.");

  // 2. Заполняем Посты (posts)
  if (posts && posts.length > 0) {
    for (const post of posts) {
      await db.execute({
        sql: "INSERT INTO Post (title, img, date, description, tags) VALUES (?, ?, ?, ?, ?)",
        args: [
          post.title,
          post.img,
          post.date,
          post.description,
          JSON.stringify(post.tags || []),
        ],
      });
    }
    console.log(`Успешно перенесено постов: ${posts.length}`);
  }

  // 3. Заполняем Работы (works)
  if (works && works.length > 0) {
    for (const work of works) {
      await db.execute({
        sql: `INSERT INTO Work (title, img, date, description, tags, gallery, videoSrc, detailVideoSrc, sectionTitle, processText, projectLink) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          work.title,
          work.img,
          work.date,
          work.description,
          JSON.stringify(work.tags || []),
          work.gallery ? JSON.stringify(work.gallery) : null,
          work.videoSrc || null,
          work.detailVideoSrc || null,
          work.sectionTitle || null,
          work.processText || null,
          work.projectLink || null,
        ],
      });
    }
    console.log(`Успешно перенесено работ: ${works.length}`);
  }

  // 4. ДОБАВИЛИ: Заполняем Подписчиков (subscribers)
  if (subscribers && subscribers.length > 0) {
    for (const sub of subscribers) {
      await db.execute({
        sql: "INSERT INTO Subscribers (id, name, email, status) VALUES (?, ?, ?, ?)",
        args: [
          Number(sub.id), // Передаем как число
          sub.name,
          sub.email,
          sub.status || "pending",
        ],
      });
    }
    console.log(`Успешно перенесено подписчиков: ${subscribers.length}`);
  }

  console.log("База данных успешно заполнена!");
}

main()
  .catch((e) => {
    console.error("Ошибка при заполнении базы:", e);
    process.exit(1);
  })
  .finally(() => {
    db.close();
  });
