import { Telegraf } from "telegraf";
import { MongoClient } from "mongodb";

// ==== ENV ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPPORT_CHAT_ID = Number(process.env.SUPPORT_CHAT_ID); // -1003161551022
const MONGODB_URI = process.env.MONGODB_URI;
const AUTO_REPLY_TEXT =
    process.env.AUTO_REPLY_TEXT ||
    "Спасибо! Мы получили ваше сообщение. Оператор скоро ответит 🙌";

if (!BOT_TOKEN || !SUPPORT_CHAT_ID || !MONGODB_URI) {
    console.error("Missing env variables! Check BOT_TOKEN, SUPPORT_CHAT_ID, MONGODB_URI");
    process.exit(1);
}

// ==== DB ====
const mongo = new MongoClient(MONGODB_URI);
await mongo.connect();
const db = mongo.db(); // имя БД из URI (amsupport)
const Tickets = db.collection("tickets");

// ==== BOT ====
const bot = new Telegraf(BOT_TOKEN);

// Красивое имя для человека
function getDisplayName(user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
    if (name && user.username) return `${name} (@${user.username})`;
    if (name) return name;
    if (user.username) return `@${user.username}`;
    return `user_${user.id}`;
}

// Создать / найти тему для пользователя
async function ensureTopicForUser(user, source) {
    const userId = user.id;
    const now = new Date();

    // 1. Пытаемся найти существующий открытый тикет
    const existing = await Tickets.findOne({ userId });

    if (existing && existing.threadId && existing.status !== "closed") {
        // Обновим метаданные (имя, username и т.п.)
        await Tickets.updateOne(
            { userId },
            {
                $set: {
                    displayName: existing.displayName || getDisplayName(user),
                    username: user.username,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    languageCode: user.language_code,
                    ...(source ? { source } : {}),
                    updatedAt: now,
                },
            }
        );
        return existing.threadId;
    }

    // 2. Открытого тика нет или он закрыт → создаём новую тему
    const displayName = getDisplayName(user);

    const topic = await bot.telegram.callApi("createForumTopic", {
        chat_id: SUPPORT_CHAT_ID,
        name: displayName.slice(0, 128), // лимит телеги
    });

    const threadId = topic.message_thread_id;

    await Tickets.updateOne(
        { userId },
        {
            $set: {
                userId,
                threadId,
                status: "open",
                source: source || existing?.source,
                displayName,
                username: user.username,
                firstName: user.first_name,
                lastName: user.last_name,
                languageCode: user.language_code,
                updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
        },
        { upsert: true }
    );

    return threadId;
}

// ==== /start ====
bot.start(async (ctx) => {
    const src = ctx.startPayload || "app";
    const user = ctx.from;

    const threadId = await ensureTopicForUser(user, src);
    const displayName = getDisplayName(user);

    // Автоответ клиенту
    await ctx.reply(AUTO_REPLY_TEXT);

    // Сообщение в AM Support Hub
    try {
        await bot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `🆕 Новый диалог: ${displayName}\n` +
            `ID: ${user.id}${user.username ? ` | @${user.username}` : ""}\n` +
            `Источник: ${src}`,
            { message_thread_id: threadId }
        );
    } catch (err) {
        console.error("Failed to notify support about new dialog", err);
    }
});

// ==== Обработка сообщений ====
bot.on("message", async (ctx) => {
    const msg = ctx.message;

    // ----- 1. Клиент пишет в личку боту -----
    if (ctx.chat.type === "private") {
        // Команды (типа /start) здесь не дублируем
        if (msg.text && msg.text.startsWith("/")) return;

        const user = ctx.from;
        const userId = user.id;

        let ticket = await Tickets.findOne({ userId });
        let threadId = ticket?.threadId;

        // если нет тикета или он закрыт → создаём новый
        if (!ticket || !threadId || ticket.status === "closed") {
            threadId = await ensureTopicForUser(user);
            ticket = await Tickets.findOne({ userId });
        }

        // Пересылаем сообщение в тему саппорта
        try {
            await bot.telegram.copyMessage(
                SUPPORT_CHAT_ID,
                userId,
                msg.message_id,
                { message_thread_id: threadId }
            );
        } catch (err) {
            console.error("Failed to copy message from user to support", err);
        }

        return;
    }

    // ----- 2. Сообщение внутри AM Support Hub -----
    if (ctx.chat.id === SUPPORT_CHAT_ID) {
        const threadId = msg.message_thread_id;

        // Служебка: закрытие темы мышкой в Telegram
        if (msg.forum_topic_closed && threadId) {
            await Tickets.updateOne(
                { threadId },
                { $set: { status: "closed", updatedAt: new Date() } }
            );
            return;
        }

        // Без threadId нам не с чем мапиться
        if (!threadId) return;

        const ticket = await Tickets.findOne({ threadId });
        if (!ticket) return;

        // Не шлём клиенту сообщения ботов
        if (msg.from?.is_bot) return;

        // Отсекаем чистые сервисные сообщения без контента
        const hasContent =
            msg.text ||
            msg.caption ||
            msg.photo ||
            msg.document ||
            msg.audio ||
            msg.video ||
            msg.voice ||
            msg.sticker ||
            msg.animation;
        if (!hasContent) return;

        // Пересылаем сообщение оператора клиенту
        try {
            await bot.telegram.copyMessage(
                ticket.userId,
                SUPPORT_CHAT_ID,
                msg.message_id
            );
        } catch (err) {
            console.error("Failed to copy message from support to user", err);
        }
    }
});

// ==== /close (закрыть диалог из темы) ====
bot.command("close", async (ctx) => {
    if (ctx.chat.id !== SUPPORT_CHAT_ID || !ctx.message.message_thread_id) return;

    const threadId = ctx.message.message_thread_id;
    const now = new Date();

    const ticket = await Tickets.findOne({ threadId });

    await Tickets.updateOne(
        { threadId },
        { $set: { status: "closed", updatedAt: now } }
    );

    await ctx.reply("Диалог закрыт ✅");

    if (ticket) {
        try {
            await bot.telegram.sendMessage(
                ticket.userId,
                "Диалог с поддержкой закрыт. Если появятся новые вопросы — просто напишите сюда ещё раз 🙂"
            );
        } catch (err) {
            console.error("Failed to notify user about closing", err);
        }
    }
});

// ==== Глобальный catch, чтобы бот не падал ====
bot.catch((err, ctx) => {
    console.error(`Global bot error for update ${ctx?.update?.update_id}`, err);
});

bot.launch();
console.log("Bot started…");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
