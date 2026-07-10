import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import fs from "fs";

const isAmvera = fs.existsSync('/data');
const databaseUrl = isAmvera ? "file:/data/dev.db" : "file:./dev.db";

const backendUrl = isAmvera ? "https://john-back-elenafl.amvera.io" : "http://localhost:5000";

// Гибридный импорт Prisma Client для поддержки ESM и CommonJS окружений
let PrismaClient;
try {
  const pkg = await import("@prisma/client");
  PrismaClient = pkg.PrismaClient || pkg.default.PrismaClient;
} catch (e) {
  const { PrismaClient: LocalClient } = await import("@prisma/client");
  PrismaClient = LocalClient;
}

import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const db = createClient({ url: databaseUrl });
const adapter = new PrismaLibSql(db);
const prisma = new PrismaClient({ adapter });

export { prisma };
const app = express();

// ИСПРАВЛЕНИЕ: Включаем доверие к прокси-серверу Amvera.
// Это необходимо, чтобы куки авторизации (secure: true) успешно сохранялись в вашем браузере.
app.set("trust proxy", 1);

// 1. Динамически определяем адрес фронтенда (Vercel в Сети или localhost на компьютере)
const allowedOrigins = [
  "http://localhost:5173",
  "https://blog-john.vercel.app",
];

// 2. CORS (сам обработает все OPTIONS запросы)
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true, // Позволяет браузеру принимать и передавать куку admin_session
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    preflightContinue: false,
    optionsSuccessStatus: 200,
  }),
);

app.use(express.json());
app.use(cookieParser());

// УМНЫЙ ПЕРЕХВАТЧИК КУК (Решает проблему "выбрасывания" из админки)
// Автоматически добавляет флаги безопасности ко всем кукам, чтобы браузеры не блокировали их при работе между Amvera и Vercel
app.use((req, res, next) => {
  const originalCookie = res.cookie;
  res.cookie = function (name, value, options = {}) {
    return originalCookie.call(this, name, value, {
      ...options,
      secure: true,
      sameSite: "none",
    });
  };
  next();
});

let currentDynamicPassword = "Admin2026!";

// Вспомогательная функция экранирования XSS
function escapeHtml(string) {
  return String(string).replace(/[&<>"']/g, function (s) {
    const entityMap = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "'",
    };
    return entityMap[s];
  });
}


// Специализированная фильтрация для текстов статей:
// Блокирует HTML-теги (<, >), но сохраняет кавычки и амперсанды для React
function escapeTagsOnly(string) {
  return String(string).replace(/[<>]/g, function (s) {
    const entityMap = {
      "<": "&lt;",
      ">": "&gt;"
    };
    return entityMap[s];
  });
}

// Шаблон страниц ответов модерации
function renderStatusPage(title, message, isSuccess) {
  return `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #FBFBFA; color: #1A1A1A; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .container { background: #ffffff; padding: 40px; border-radius: 24px; border: 1px solid #E5E7EB; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 4px 25px rgba(0,0,0,0.02); }
        h1 { font-size: 24px; font-weight: 800; margin-bottom: 12px; }
        p { font-size: 15px; color: #6B7280; line-height: 1.6; margin-bottom: 0; }
        .icon { font-size: 48px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">${isSuccess ? "✨" : "⚠️"}</div>
        <h1>${title}</h1>
        <p>${message}</p>
      </div>
    </body>
    </html>
  `;
}

// Лимитеры запросов (временно полностью отключаем проверку, чтобы обойти блокировку общего IP)
// const strictDailyLimiter = (req, res, next) => next();
// const adminLoginLimiter = (req, res, next) => next();

// Лимитеры запросов
const strictDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: {
    error: "Вы уже отправляли запрос сегодня. Пожалуйста, попробуйте завтра.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false, // Отключаем строгую валидацию прокси, чтобы избежать ValidationError в Amvera
});

const adminLoginLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: {
    error: "Слишком много попыток входа. Доступ заблокирован на 24 часа.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false, // Отключаем строгую валидацию прокси, чтобы избежать ValidationError в Amvera
});

// Настройка почты Яндекс
const yandexTransporter = nodemailer.createTransport({
  host: "smtp.yandex.ru",
  port: 465,
  secure: true,
  auth: {
    user: process.env.YANDEX_USER,
    pass: process.env.YANDEX_PASS,
  },
});

// Функция генерации нового пароля админа
const generateNewAdminPassword = () => {
  const newPassword = crypto.randomBytes(6).toString("hex");
  currentDynamicPassword = newPassword;
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(newPassword, 10);
  console.log("\n=========================================");
  console.log(` НОВЫЙ ВРЕМЕННЫЙ ПАРОЛЬ АДМИНИСТРАТОРА: ${newPassword}`);
  console.log("================================*********\n");
};

// Функция отправки в Telegram через Email-шлюз
async function sendToTelegram(message) {
  if (!process.env.TELEGRAM_EMAIL) {
    console.log("⚠️ Переменная TELEGRAM_EMAIL не настроена в файле .env");
    return;
  }
  try {
    const htmlBody = `
      ${message}
      <br><br>━━━━━━━━━━━━━━━━━━━━━━━━━━<br>
      Понравился материал? Подпишитесь, чтобы не пропустить новые статьи! НАЖМИТЕ КНОПКУ «ПОДПИСАТЬСЯ» ВНИЗУ ЭКРАНА
    `;
    const mailOptions = {
      from: process.env.YANDEX_USER,
      to: process.env.TELEGRAM_EMAIL.trim(),
      subject: "New publication on the blog",
      html: htmlBody,
      charset: "utf-8",
    };
    await yandexTransporter.sendMail(mailOptions);
    console.log("📢 Яндекс успешно передал письмо для Telegram-шлюза!");
  } catch (err) {
    console.error(
      "❌ КРИТИЧЕСКАЯ ОШИБКА НА ЭТАПЕ ОТПРАВКИ ЯНДЕКСОМ В TELEGRAM:",
      err.message,
    );
  }
}

// МИДЛВАР АВТОРИЗАЦИИ ПО КУКАМ
const authenticatetoken = (req, res, next) => {
  const token = req.cookies && req.cookies.admin_session;
  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "Сессия отсутствует. Войдите заново." });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: "Сессия истекла или недействительна.",
      });
    }
    req.user = user;
    next();
  });
};

// =========================================================
// РОУТЫ ПРИЛОЖЕНИЯ
// =========================================================

// Подписка на блог
app.post("/api/subscribe", strictDailyLimiter, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email)
      return res.status(400).json({ error: "Пожалуйста, заполните все поля" });

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(cleanEmail))
      return res
        .status(400)
        .json({ error: "Некорректный формат email адреса" });

    const nameRegex = /^[a-zA-Zа-яА-ЯёЁ\s-]{2,30}$/;
    if (!nameRegex.test(cleanName))
      return res
        .status(400)
        .json({ error: "Имя должно содержать от 2 до 30 букв" });

    // 1. Проверяем, есть ли уже такой email в базе через чистый SQL
    const existingSubResult = await db.execute({
      sql: "SELECT * FROM Subscribers WHERE email = ? LIMIT 1",
      args: [cleanEmail],
    });

    if (existingSubResult.rows.length > 0)
      return res.status(400).json({ error: "Этот email уже подписан" });

    // 2. Создаем нового подписчика безопасным SQL-запросом с передачей статуса модерации
    const insertResult = await db.execute({
      sql: "INSERT INTO Subscribers (name, email, status) VALUES (:name, :email, :status)",
      args: {
        ":name": cleanName,
        ":email": cleanEmail,
        ":status": "pending", // или "PENDING", если в Prisma Enum написан заглавными буквами
      },
    });

    // Получаем ID только что созданной строки (LibSQL возвращает его в lastInsertRowid)
    const newSubId = Number(insertResult.lastInsertRowid);

    // 3. Генерируем токены, используя новый ID
    const approveToken = jwt.sign(
      { subId: newSubId, action: "moderate" },
      process.env.JWT_SECRET,
      { expiresIn: "3d" },
    );
    const rejectToken = jwt.sign(
      { subId: newSubId, action: "moderate" },
      process.env.JWT_SECRET,
      { expiresIn: "3d" },
    );

    const serverUrl = backendUrl;
    const approveLink = `${serverUrl}/api/moderate?token=${approveToken}&status=approve`;
    const rejectLink = `${serverUrl}/api/moderate?token=${rejectToken}&status=reject`;

    const moderationMailOptions = {
      from: process.env.YANDEX_USER,
      to: process.env.YANDEX_USER,
      subject: `🔔 Модерация подписки: ${cleanName}`,
      html: `<h3>Заявка на подписку</h3><p><b>Имя:</b> ${escapeHtml(cleanName)}</p><p><b>Email:</b> ${cleanEmail}</p><br/><a href="${approveLink}">Одобрить</a> | <a href="${rejectLink}">Отклонить</a>`,
    };

    await yandexTransporter.sendMail(moderationMailOptions);
    return res
      .status(200)
      .json({ success: true, message: "Заявка отправлена на модерацию!" });
  } catch (error) {
    console.error("❌ Ошибка в роуте подписки:", error);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Модерация подписки из Email
app.get("/api/moderate", async (req, res) => {
  const { token, status } = req.query;
  if (!token || !status) {
    return res
      .status(400)
      .send(
        renderStatusPage(
          "Ошибка доступа",
          "Неполные параметры запроса.",
          false,
        ),
      );
  }

  try {
    // 1. Декодируем и проверяем токен
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Оставляем вашу проверку, так как в первом роуте токены генерируются с "moderate"
    if (decoded.action !== "moderate") {
      return res
        .status(403)
        .send(
          renderStatusPage("Ошибка безопасности", "Невалидный токен.", false),
        );
    }

    const subId = decoded.subId;

    // 2. Ищем подписчика в базе SQLite по ID
    const findResult = await db.execute({
      sql: "SELECT * FROM Subscribers WHERE id = ? LIMIT 1",
      args: [subId],
    });

    if (findResult.rows.length === 0) {
      return res
        .status(404)
        .send(
          renderStatusPage(
            "Запись не найдена",
            "Подписчик отсутствует в базе данных.",
            false,
          ),
        );
    }

    const subscriber = findResult.rows[0];

    // Действие: ОДОБРИТЬ
    if (status === "approve") {
      if (subscriber.status === "active") {
        return res.send(
          renderStatusPage(
            "Уже активирован",
            "Пользователь уже одобрен.",
            true,
          ),
        );
      }

      // Обновляем статус в базе данных на active
      await db.execute({
        sql: "UPDATE Subscribers SET status = 'active' WHERE id = ?",
        args: [subId],
      });

      // Отправляем письмо пользователю об успешной активации
      await yandexTransporter.sendMail({
        from: process.env.YANDEX_USER,
        to: subscriber.email,
        subject: "🎉 Успешная подписка на обновления блога!",
        html: `<h2>Здравствуйте, ${escapeHtml(subscriber.name || "Подписчик")}!</h2><p>Вы успешно подписались на рассылку новых публикаций.</p>`,
      });

      return res.send(
        renderStatusPage(
          "Подписка одобрена",
          `Пользователь ${subscriber.email} успешно активирован.`,
          true,
        ),
      );
    }

    // Действие: ОТКЛОНИТЬ
    if (status === "reject") {
      // Удаляем подписчика из таблицы полностью
      await db.execute({
        sql: "DELETE FROM Subscribers WHERE id = ?",
        args: [subId],
      });

      return res.send(
        renderStatusPage(
          "Заявка отклонена",
          "Пользователь успешно удален.",
          true,
        ),
      );
    }

    return res
      .status(400)
      .send(
        renderStatusPage(
          "Неверное действие",
          "Указан некорректный статус.",
          false,
        ),
      );
  } catch (err) {
    console.error("❌ Ошибка в роуте модерации:", err); // Выводим реальный лог в консоль бэкенда
    return res
      .status(403)
      .send(
        renderStatusPage(
          "Ссылка устарела",
          "Срок действия ссылки истек или токен поврежден.",
          false,
        ),
      );
  }
});

// Контакты (Форма обратной связи)
app.post("/api/contact", strictDailyLimiter, (req, res) => {
  const { name, email, message, username_hp } = req.body;
  if (username_hp && username_hp.trim() !== "")
    return res.status(200).json({ success: true, message: "Spam blocked." });
  if (!name || !email || !message)
    return res
      .status(400)
      .json({ success: false, message: "Все поля формы обязательны." });

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanMessage = message.trim();

  const nameRegex = /^[A-Za-zА-Яа-яЁё\s\-]+$/;
  if (
    !nameRegex.test(cleanName) ||
    cleanName.length < 2 ||
    cleanMessage.length < 5
  ) {
    return res
      .status(400)
      .json({ success: false, message: "Некорректные данные формы." });
  }

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(cleanEmail))
    return res
      .status(400)
      .json({ success: false, message: "Некорректный формат email." });

  const safeName = escapeHtml(cleanName);
  const safeMessage = escapeHtml(cleanMessage);

  yandexTransporter.sendMail(
    {
      from: process.env.YANDEX_USER,
      to: process.env.YANDEX_USER,
      subject: `📩 Новое сообщение от ${safeName}`,
      text: `Имя: ${safeName}\nEmail: ${cleanEmail}\n\nСообщение:\n${safeMessage}`,
    },
    (error) => {
      if (error)
        return res
          .status(500)
          .json({ success: false, message: "Ошибка сервера при отправке." });
      res
        .status(200)
        .json({ success: true, message: "Сообщение успешно отправлено!" });
    },
  );
});

// Авторизация администратора
app.post("/api/admin/login", adminLoginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password)
      return res
        .status(400)
        .json({ success: false, message: "Пароль не указан" });

    if (password.trim() === currentDynamicPassword) {
      const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, {
        expiresIn: "2h",
      });
      const isProduction = process.env.NODE_ENV === "production";

      res.cookie("admin_session", token, {
        httpOnly: true,
        maxAge: 2 * 60 * 60 * 1000,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
      });
      generateNewAdminPassword();
      return res.json({ success: true, message: "Авторизация успешна" });
    } else {
      return res
        .status(401)
        .json({ success: false, message: "Неверный текущий код доступа" });
    }
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Ошибка сервера при авторизации" });
  }
});

// Проверка сессии админа
app.get("/api/admin/check", async (req, res) => {
  try {
    const token = req.cookies.admin_session;
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Сессия отсутствует" });

    jwt.verify(token, process.env.JWT_SECRET, (err) => {
      if (err)
        return res
          .status(401)
          .json({ success: false, message: "Сессия истекла" });
      return res.json({ success: true, authorized: true });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Ошибка сервера" });
  }
});

// Логаут
app.post("/api/admin/logout", (req, res) => {
  try {
    res.clearCookie("admin_session", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });
    return res.json({ success: true, message: "Вы успешно вышли из системы" });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Ошибка сервера при выходе" });
  }
});

// Получить все работы (универсальный роут)
app.get("/api/works", async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM Work");

    const works = result.rows.map((work) => ({
      ...work,
      tags: work.tags ? JSON.parse(work.tags) : [],
      gallery: work.gallery ? JSON.parse(work.gallery) : null,
    }));

    res.json(works);
  } catch (error) {
    console.error("Ошибка при чтении работ:", error);
    res.status(500).json({ error: "Ошибка сервера при получении работ" });
  }
});

// Получить конкретную работу по ID
app.get("/api/works/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.execute({
      sql: "SELECT * FROM Work WHERE id = ? LIMIT 1",
      args: [id],
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Работа не найден" });
    }

    const work = result.rows[0];

    // Парсим теги и галерею
    const formattedWork = {
      ...work,
      tags: work.tags ? JSON.parse(work.tags) : [],
      gallery: work.gallery ? JSON.parse(work.gallery) : null,
    };

    res.json(formattedWork);
  } catch (error) {
    console.error("Ошибка при получении деталей работы:", error);
    res.status(500).json({ error: "Ошибка сервера при получении работы" });
  }
});

// Публичный роут: получить все посты
app.get("/api/posts", async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM Post");

    // В отличие от Prisma, нативный драйвер возвращает массив объектов в свойстве rows
    // Парсим теги обратно из строки в массив JSON
    const posts = result.rows.map((post) => ({
      ...post,
      tags: post.tags ? JSON.parse(post.tags) : [],
    }));

    res.json(posts);
  } catch (error) {
    console.error("Ошибка при чтении постов:", error);
    res.status(500).json({ error: "Ошибка сервера при получении постов" });
  }
});

// Публичный роут: получить конкретный пост по ID
app.get("/api/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Безопасный запрос с экранированием параметров
    const result = await db.execute({
      sql: "SELECT * FROM Post WHERE id = ? LIMIT 1",
      args: [id],
    });

    // Если ничего не нашли
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Пост не найден" });
    }

    const post = result.rows[0];

    // Парсим теги обратно в массив
    const formattedPost = {
      ...post,
      tags: post.tags ? JSON.parse(post.tags) : [],
    };

    res.json(formattedPost);
  } catch (error) {
    console.error("Ошибка при получении деталей поста:", error);
    res.status(500).json({ error: "Ошибка сервера при получении поста" });
  }
});

// Админский роут: получить все посты
app.get("/api/admin/posts", authenticatetoken, async (req, res) => {
  try {
    // Выполняем прямой SQL-запрос с сортировкой от новых к старым
    const result = await db.execute("SELECT * FROM Post ORDER BY id DESC");

    // Превращаем строки из базы в массив объектов и парсим теги
    const formattedPosts = result.rows.map((p) => ({
      ...p,
      tags: p.tags ? JSON.parse(p.tags) : [],
    }));

    return res.json(formattedPosts);
  } catch (error) {
    console.error("❌ Ошибка в админ-роуте постов:", error);
    res.status(500).json({ success: false, message: "Ошибка сервера" });
  }
});

// Создание поста администратором + Рассылка
app.post("/api/posts", authenticatetoken, async (req, res) => {
  try {
    const newPostData = req.body;

    // Валидация входных данных
    if (!newPostData.title || !newPostData.description) {
      return res.status(400).json({
        success: false,
        message: "Заголовок и описание обязательны для заполнения.",
      });
    }

    // Безопасное экранирование полей от XSS
    // Для заголовка и текста применяем escapeTagsOnly (сохраняем кавычки)
    const safeTitle = escapeTagsOnly(newPostData.title.trim());
    const safeDescription = escapeTagsOnly(newPostData.description.trim());
    
    const safeImg = newPostData.img ? escapeHtml(newPostData.img.trim()) : "";

    // Формируем строковую дату в формате, который был раньше
    const safeDate = newPostData.date
      ? escapeHtml(newPostData.date.trim())
      : new Date().toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        });

    // Безопасная обработка массива тегов
    let safeTags = [];
    if (Array.isArray(newPostData.tags)) {
      safeTags = newPostData.tags.map((tag) => escapeHtml(tag.trim()));
    }
    const tagsString = JSON.stringify(safeTags);

    // 1. Сохраняем в SQLite строго по колонкам из schema.prisma (id автоинкрементируется)
    const insertResult = await db.execute({
      sql: "INSERT INTO Post (title, description, img, date, tags) VALUES (:title, :description, :img, :date, :tags)",
      args: {
        ":title": safeTitle,
        ":description": safeDescription,
        ":img": safeImg,
        ":date": safeDate,
        ":tags": tagsString,
      },
    });

    // Извлекаем сгенерированный базой ID
    const newPostId = insertResult.lastInsertRowid
      ? insertResult.lastInsertRowid.toString()
      : "0";

    // Собираем объект поста для фронтенда (добавляем videoSrc и variant как виртуальные, если фронтенд их ищет)
    const newPost = {
      id: newPostId,
      title: safeTitle,
      description: safeDescription,
      img: safeImg,
      date: safeDate,
      tags: safeTags,
      videoSrc: newPostData.videoSrc
        ? escapeHtml(newPostData.videoSrc.trim())
        : "",
      variant: newPostData.variant
        ? escapeHtml(newPostData.variant.trim())
        : "post",
      createdAt: new Date().toISOString(),
    };

    // Форматирование тегов для Telegram
    const formattedTags = safeTags.join(" ");

    // Формируем текст сообщения для Telegram
    const messageText = `
<b> ВНИМАНИЕ! 🔥 НОВАЯ ПУБЛИКАЦИЯ В БЛОГЕ 🔥</b>
<br>━━━━━━━━━━━━━━━━━━━━━━━━━━<br><br>
<b>${newPost.title.toUpperCase()}</b>
<br><br>
${newPost.description || ""}
<br><br>━━━━━━━━━━━━━━━━━━━━━━━━━━<br>
📌 ${formattedTags}
<br><br>✍️ <i>Автор: Елена</i>
<br><br>👇 👇 👇
    `.trim();

    // Отправка в Telegram
    if (typeof sendToTelegram === "function") {
      await sendToTelegram(messageText);
    }

    // 2. Рассылка по активным подписчикам
    const subResult = await db.execute({
      sql: "SELECT * FROM Subscribers WHERE status = 'active'",
    });
    const activeSubscribers = subResult.rows;

    if (activeSubscribers.length > 0) {
      const chatId = process.env.TELEGRAM_CHAT_ID || "john_blog_news";
      const cleanChannelName = chatId.replace("@", "").trim();

      const emailTemplate = {
        from: process.env.YANDEX_USER,
        subject: `Новая статья: ${newPost.title}`,
        html: `
          <div style="display: none; max-height: 0px; overflow: hidden; font-size: 1px; line-height: 1px; color: #fff; opacity: 0;">
            Узнайте подробности новой публикации в блоге: ${newPost.title}. ${newPost.description ? newPost.description.substring(0, 50) : ""}
          </div>
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
            <h2 style="color: #333;">${newPost.title}</h2>
            <p style="color: #666; line-height: 1.6;">${newPost.description ? newPost.description.substring(0, 250) : ""}...</p>
            <br />
            <a href="https://t.me/${cleanChannelName}" target="_blank" style="display: inline-block; background-color: #0088cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Читать в Telegram-канале</a>
          </div>
        `,
      };

      activeSubscribers.forEach((subscriber) => {
        if (!subscriber.email) return;
        const cleanEmail = subscriber.email.trim().toLowerCase();
        yandexTransporter.sendMail(
          { ...emailTemplate, to: cleanEmail },
          (err) => {
            if (err)
              console.error(
                `❌ Ошибка рассылки на адрес ${cleanEmail}:`,
                err.message,
              );
          },
        );
      });
    }

    // Возвращаем успех фронтенду
    res.status(201).json({ success: true, post: newPost });
  } catch (error) {
    console.error("❌ Ошибка сервера при создании поста:", error);
    res
      .status(500)
      .json({ success: false, message: "Ошибка сервера при сохранении поста" });
  }
});

// Удаление поста администратором
app.delete("/api/admin/posts/:id", authenticatetoken, async (req, res) => {
  try {
    const postId = Number(req.params.id);

    // Выполняем удаление через чистый параметризованный SQL
    await db.execute({
      sql: "DELETE FROM Post WHERE id = ?",
      args: [postId],
    });

    return res.json({ success: true, message: "Пост успешно удален" });
  } catch (error) {
    console.error("❌ Ошибка при удалении поста:", error);
    res
      .status(500)
      .json({ success: false, message: "Пост не найден или ошибка сервера" });
  }
});

// Получение списка всех подписчиков
app.get("/api/admin/subscribers", authenticatetoken, async (req, res) => {
  try {
    const result = await db.execute(
      "SELECT * FROM Subscribers ORDER BY id DESC",
    );
    return res.json({ success: true, subscribers: result.rows });
  } catch (error) {
    console.error("❌ Ошибка при получении списка подписчиков:", error);
    res
      .status(500)
      .json({ success: false, message: "Ошибка сервера при загрузке" });
  }
});

// Удаление подписчика по ID
app.delete(
  "/api/admin/subscribers/:id",
  authenticatetoken,
  async (req, res) => {
    try {
      const subscriberId = Number(req.params.id);

      if (isNaN(subscriberId)) {
        return res
          .status(400)
          .json({ success: false, message: "Некорректный ID подписчика" });
      }

      await db.execute({
        sql: "DELETE FROM Subscribers WHERE id = ?",
        args: [subscriberId],
      });

      return res.json({ success: true, message: "Подписчик успешно удален" });
    } catch (error) {
      console.error("❌ Ошибка при удалении подписчика:", error);
      res
        .status(500)
        .json({ success: false, message: "Ошибка сервера при удалении" });
    }
  },
);

//комментарий
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Сервер успешно запущен на порту ${PORT}`);
  generateNewAdminPassword();
});
