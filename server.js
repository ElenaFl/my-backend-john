import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isAmvera =
  process.env.AMVERA === "true" || process.env.NODE_ENV === "production";

const isAmvera = process.env.AMVERA === 'true' || process.env.NODE_ENV === 'production';
const DATA_PATH = isAmvera ? "/data/data.json" : path.join(__dirname, "data.json");

// АВТОСОЗДАНИЕ: Если файла нет, создаем его перед чтением/записью
if (!fs.existsSync(DATA_PATH)) {
  // На Amvera берем шаблон, локально можно просто создать пустой массив
  const templatePath = path.join(__dirname, "data.template.json");
  const defaultData = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '[]';
  
  fs.writeFileSync(DATA_PATH, defaultData, 'utf8');
}

const app = express();

// 1. Динамически определяем адрес фронтенда (Vercel в Сети или localhost на компьютере)
const allowedOrigin = process.env.CLIENT_URL || "http://localhost:5173";

// 2. CORS (сам обработает все OPTIONS запросы)
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true, // Позволяет браузеру принимать и передавать куку admin_session
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    preflightContinue: false, // Библиотека CORS сама ответит на OPTIONS статус 204/200
    optionsSuccessStatus: 200, // Для старых браузеров
  }),
);

app.use(express.json());
app.use(cookieParser());

let currentDynamicPassword = "Admin2026!";

// =========================================================
// ФУНКЦИЯ ОТПРАВКИ В TELEGRAM ЧЕРЕЗ EMAIL-ШЛЮЗ
// =========================================================
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

const generateNewAdminPassword = () => {
  const newPassword = crypto.randomBytes(6).toString("hex");
  currentDynamicPassword = newPassword;
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(newPassword, 10);
  console.log("\n=========================================");
  console.log(` НОВЫЙ ВРЕМЕННЫЙ ПАРОЛЬ АДМИНИСТРАТОРА: ${newPassword}`);
  console.log("================================*********\n");
};

const strictDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,

  message: {
    error: "Вы уже отправляли запрос сегодня. Пожалуйста, попробуйте завтра.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: {
    error: "Слишком много попыток входа. Доступ заблокирован на 24 часа.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const yandexTransporter = nodemailer.createTransport({
  host: "smtp.yandex.ru",
  port: 465,
  secure: true,
  auth: {
    user: process.env.YANDEX_USER,
    pass: process.env.YANDEX_PASS,
  },
});

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

function renderStatusPage(title, message, isSuccess) {
  return `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #FBFBFA; color: #1A1A1A; display: flex; items-center: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
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
    if (!fs.existsSync(DATA_PATH)) {
      fs.writeFileSync(
        DATA_PATH,
        JSON.stringify({ posts: [], works: [], subscribers: [] }, null, 2),
      );
    }
    const fileData = fs.readFileSync(DATA_PATH, "utf8");
    const db = JSON.parse(fileData);
    if (!db.subscribers) db.subscribers = [];
    const exists = db.subscribers.some((s) => s && s.email === cleanEmail);
    if (exists)
      return res.status(400).json({ error: "Этот email уже подписан" });
    const subId = crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString();
    db.subscribers.push({
      id: subId,
      name: cleanName,
      email: cleanEmail,
      status: "pending",
      date: new Date().toISOString(),
    });
    fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), "utf8");
    const approveToken = jwt.sign(
      { subId, action: "moderate" },
      process.env.JWT_SECRET,
      { expiresIn: "3d" },
    );
    const rejectToken = jwt.sign(
      { subId, action: "moderate" },
      process.env.JWT_SECRET,
      { expiresIn: "3d" },
    );

    // Код будет проверять, где он запущен
    // ИСПРАВЛЕНО: бэкенд проверяет свою среду через process.env.NODE_ENV
    const isProduction = process.env.NODE_ENV === "production";

    const serverUrl = isProduction
      ? "https://portfolio-elenafl.amvera.io" // Адрес в Сети
      : "http://localhost:5000"; // Локальный адрес

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

app.get("/api/moderate", async (req, res) => {
  const { token, status } = req.query;
  if (!token || !status)
    return res
      .status(400)
      .send(
        renderStatusPage(
          "Ошибка доступа",
          "Неполные параметры запроса.",
          false,
        ),
      );
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.action !== "moderate")
      return res
        .status(403)
        .send(
          renderStatusPage("Ошибка безопасности", "Невалидный токен.", false),
        );
    const fileData = fs.readFileSync(DATA_PATH, "utf8");
    const db = JSON.parse(fileData);
    const subIndex = db.subscribers.findIndex(
      (s) => s && s.id === decoded.subId,
    );
    if (subIndex === -1)
      return res
        .status(404)
        .send(
          renderStatusPage(
            "Запись не найдена",
            "Подписчик отсутствует.",
            false,
          ),
        );
    const subscriber = db.subscribers[subIndex];
    if (status === "approve") {
      if (subscriber.status === "active")
        return res.send(
          renderStatusPage(
            "Уже активирован",
            `Пользователь уже одобрен.`,
            true,
          ),
        );
      subscriber.status = "active";
      fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
      await yandexTransporter.sendMail({
        from: process.env.YANDEX_USER,
        to: subscriber.email,
        subject: "🎉 Успешная подписка на обновления блога!",
        html: `<h2>Здравствуйте, ${escapeHtml(subscriber.name)}!</h2><p>Вы успешно подписались на рассылку новых публикаций.</p>`,
      });
      return res.send(
        renderStatusPage(
          "Подписка одобрена",
          `Пользователь ${subscriber.email} успешно активирован.`,
          true,
        ),
      );
    }
    if (status === "reject") {
      db.subscribers.splice(subIndex, 1);
      fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
      return res.send(
        renderStatusPage(
          "Заявка отклонена",
          `Пользователь успешно удален.`,
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
    return res
      .status(403)
      .send(
        renderStatusPage(
          "Ссылка устарела",
          "Срок действия ссылки истек.",
          false,
        ),
      );
  }
});

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

      // Проверяем, запущен ли сервер в Сети (в Amvera NODE_ENV равен "production")
      const isProduction = process.env.NODE_ENV === "production";

      res.cookie("admin_session", token, {
        httpOnly: true,
        maxAge: 2 * 60 * 60 * 1000, // 2 часа

        // ДИНАМИЧЕСКИЕ НАСТРОЙКИ БЕЗОПАСНОСТИ:
        secure: isProduction, // В Сети (HTTPS) — true, на localhost (HTTP) — false

        // КРИТИЧЕСКИ ВАЖНО ДЛЯ СВЯЗКИ VERCEL + AMVERA:
        // В Сети используем 'none' (разрешает кросс-доменные куки), на компьютере — 'lax'
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

app.post("/api/admin/logout", (req, res) => {
  try {
    res.clearCookie("admin_session", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });
    return res.json({ success: true, message: "Вы успешно вышли из системы" });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Ошибка сервера при выходе" });
  }
});

app.get("/api/works", (req, res) => {
  try {
    if (!fs.existsSync(DATA_PATH)) return res.json([]);
    const fileData = fs.readFileSync(DATA_PATH, "utf8");
    return res.json(JSON.parse(fileData).works || []);
  } catch (error) {
    res.status(500).json({ error: "Ошибка сервера при получении работ" });
  }
});

app.get("/api/works/:id", (req, res) => {
  try {
    if (!fs.existsSync(DATA_PATH))
      return res.status(404).json({ error: "База данных не найдена" });
    const db = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const work = db.works
      ? db.works.find((w) => w && String(w.id) === String(req.params.id))
      : null;
    if (!work) return res.status(404).json({ error: "Работа не найдена" });
    res.json(work);
  } catch (error) {
    res.status(500).json({ error: "Ошибка сервера при получении работы" });
  }
});

app.get("/api/posts", (req, res) => {
  try {
    if (!fs.existsSync(DATA_PATH)) return res.json([]);
    const fileData = fs.readFileSync(DATA_PATH, "utf8");
    res.json(JSON.parse(fileData).posts || []);
  } catch (error) {
    res.status(500).json({ error: "Ошибка сервера при получении постов" });
  }
});

app.get("/api/posts/:id", (req, res) => {
  try {
    if (!fs.existsSync(DATA_PATH))
      return res.status(404).json({ error: "База данных не найдена" });
    const db = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const post = db.posts
      ? db.posts.find((p) => p && String(p.id) === String(req.params.id))
      : null;
    if (!post) return res.status(404).json({ error: "Пост не найден" });
    res.json(post);
  } catch (error) {
    res.status(500).json({ error: "Ошибка сервера при получении поста" });
  }
});

app.get("/api/admin/posts", (req, res) => {
  try {
    const token = req.cookies.admin_session;
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Не авторизован" });

    jwt.verify(token, process.env.JWT_SECRET, (err) => {
      if (err)
        return res
          .status(401)
          .json({ success: false, message: "Сессия истекла" });
      if (!fs.existsSync(DATA_PATH)) return res.json([]);
      res.json(JSON.parse(fs.readFileSync(DATA_PATH, "utf8")).posts || []);
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Ошибка сервера" });
  }
});

// =========================================================
// МИДЛВАР АВТОРИЗАЦИИ ПО КУКАМ
// =========================================================
const authenticatetoken = (req, res, next) => {
  // Читаем защищенную куку admin_session, установленную при входе
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
    next(); // Пропускаем бэкенд дальше к коду публикации и Яндекс-рассылки!
  });
};

// =========================================================
// СОЗДАНИЕ ПОСТОВ И ЯНДЕКС-РАССЫЛКА
// =========================================================
app.post("/api/posts", authenticatetoken, async (req, res) => {
  try {
    const newPostData = req.body;

    // Валидация входных данных, чтобы защитить базу от пустых инъекций
    if (!newPostData.title || !newPostData.description) {
      return res.status(400).json({
        success: false,
        message: "Заголовок и описание обязательны для заполнения.",
      });
    }

    if (!fs.existsSync(DATA_PATH)) {
      fs.writeFileSync(
        DATA_PATH,
        JSON.stringify({ posts: [], works: [], subscribers: [] }, null, 2),
      );
    }

    const fileData = fs.readFileSync(DATA_PATH, "utf8");
    const db = JSON.parse(fileData);

    // Безопасное экранирование полей от XSS перед сохранением в базу данных
    const safeTitle = escapeHtml(newPostData.title.trim());
    const safeDescription = newPostData.description
      ? escapeHtml(newPostData.description.trim())
      : "";
    const safeVideoSrc = newPostData.videoSrc
      ? escapeHtml(newPostData.videoSrc.trim())
      : "";
    const safeImg = newPostData.img ? escapeHtml(newPostData.img.trim()) : "";
    const safeVariant = newPostData.variant
      ? escapeHtml(newPostData.variant.trim())
      : "post";

    // Безопасная обработка массива тегов
    let safeTags = [];
    if (Array.isArray(newPostData.tags)) {
      safeTags = newPostData.tags.map((tag) => escapeHtml(tag.trim()));
    }

    const newPost = {
      id:
        db.posts && db.posts.length > 0
          ? String(Math.max(...db.posts.map((p) => Number(p.id) || 0)) + 1)
          : "1",
      title: safeTitle,
      description: safeDescription,
      videoSrc: safeVideoSrc,
      img: safeImg,
      variant: safeVariant,
      tags: safeTags,
      createdAt: new Date().toISOString(),
    };

    if (!db.posts) db.posts = [];
    db.posts.push(newPost);
    fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));

    // Форматирование тегов для Telegram (без лишних пробелов)
    const formattedTags = newPost.tags ? newPost.tags.join(" ") : "";

    // Формируем текст сообщения. Поля уже экранированы, разметка бота не должна сломаться
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

    // ТОТ САМЫЙ КЛЮЧЕВОЙ МОМЕНТ: Вызываем нашу оригинальную, проверенную ночную функцию!
    if (typeof sendToTelegram === "function") {
      await sendToTelegram(messageText);
    }

    const activeSubscribers = (db.subscribers || []).filter(
      (sub) => sub && sub.status === "active",
    );

    if (activeSubscribers.length > 0) {
      const chatId = process.env.TELEGRAM_CHAT_ID || "blogjohn";
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

    // Возвращаем успех в соответствии со стандартами фронтенда
    res.status(201).json({ success: true, post: newPost });
  } catch (error) {
    // Детальный вывод ошибки в терминал для полной прозрачности
    console.error("❌ Ошибка сервера при создании поста:", error);
    res
      .status(500)
      .json({ success: false, message: "Ошибка сервера при сохранении поста" });
  }
});

app.delete("/api/admin/posts/:id", (req, res) => {
  try {
    const token = req.cookies.admin_session;
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Не авторизован" });

    jwt.verify(token, process.env.JWT_SECRET, (err) => {
      if (err)
        return res
          .status(401)
          .json({ success: false, message: "Сессия истекла" });
      if (!fs.existsSync(DATA_PATH))
        return res.status(404).json({ success: false, message: "База пуста" });

      let db = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
      const initialLength = db.posts.length;
      db.posts = db.posts.filter(
        (post) => String(post.id) !== String(req.params.id),
      );

      if (db.posts.length === initialLength)
        return res
          .status(404)
          .json({ success: false, message: "Пост не найден" });
      fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), "utf8");
      return res.json({ success: true, message: "Пост удален" });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Ошибка сервера" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Сервер успешно запущен на порту ${PORT}`);
  generateNewAdminPassword();
});
