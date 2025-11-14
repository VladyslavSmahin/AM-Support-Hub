import { Telegraf } from "telegraf";
import { MongoClient } from "mongodb";

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPPORT_CHAT_ID = Number(process.env.SUPPORT_CHAT_ID);
const MONGODB_URI = process.env.MONGODB_URI;

if (!BOT_TOKEN || !SUPPORT_CHAT_ID || !MONGODB_URI) {
    console.error("Missing env variables!");
    process.exit(1);
}

// ===== DB =====
const mongo = new MongoClient(MONGODB_URI);
await mongo.connect();
const db = mongo.db(); // например "amsupport"
const Tickets = db.collection("tickets");

// Хелпер: красивое имя пользователя
function getDisplayName(user) {
    const parts = [];
    if (user.first_name) parts.push(user.first_name);
    if (user.last_name) parts.push(user.last_name);
    const fullName = parts.join(" ");

    if (fullName) return fullName;
    if (user.username) return "@" + user.username;
    return "user_" + user.id;
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// Создание / поиск темы (topic) в AM Support Hub
async function ensureTopicForUser(user, source) {
    const userId = user.id;
    const displayName = getDisplayName(user);

    let record = await Tickets.findOne({ userId });

    // если уже есть — просто обновим имя/юзернейм/источник
    if (record && record.threadId) {
        await Tickets.updateOne(
            { userId },
            {
                $set: {
                    displayName,
                    username: user.username || null,
                    firstName: user.first_name || null,
                    lastName: user.last_name || null,
                    source: source || record.source,
                    updatedAt: new Date()
                }
            }
        );
        return record.threadId;
    }

    // создаём новую тему
    const topicTitle = `${displayName} (${userId})`; // то, что видит саппорт в списке тем

    const topic = await bot.telegram.callApi("createForumTopic", {
        chat_id: SUPPORT_CHAT_ID,
        name: topicTitle
    });

    const threadId = topic.message_thread_id;

    await Tickets.updateOne(
        { userId },
        {
            $set: {
                userId,
                threadId,
                status: "open",
                displayName,
                username: user.username || null,
                firstName: user.first_name || null,
                lastName: user.last_name || null,
                source: source || "app",
                updatedAt: new Date()
            },
            $setOnInsert: { createdAt: new Date(), autoReplySent: false }
        },
        { upsert: true }
    );

    return threadId;
}

// ===== /start =====
bot.start(async (ctx) => {
    const src = ctx.startPayload || "app";
    const user = ctx.from;

    const threadId = await ensureTopicForUser(user, src);

    // Автоответ пользователю при /start
    await ctx.reply(
        "Привет! 👋\n" +
        "Это чат поддержки AM.\n" +
        "Напишите свой вопрос, оператор ответит в ближайшее время.\n\n" +
        "⏰ График работы поддержки: 09:00–20:00 по Киеву."
    );

    const displayName = getDisplayName(user);

    // Уведомление в чат саппорта с именем
    await bot.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `🆕 Новый диалог: ${displayName}\n` +
        `ID: ${user.id}${user.username ? ` | @${user.username}` : ""}\n` +
        `Источник: ${src}`,
        { message_thread_id: threadId }
    );
});

// ===== Клиент пишет боту (любой текст/фото и т.п.) =====
bot.on("message", async (ctx) => {
    // Сообщение от клиента (личка с ботом)
    if (ctx.chat.type === "private") {
        const user = ctx.from;
        const userId = user.id;

        const threadId = await ensureTopicForUser(user);

        // --------------- Автоответ при первом сообщении ---------------
        // (отдельно от /start: вдруг человек закрыл/открыл чат позже)
        const ticket = await Tickets.findOne({ userId });
        if (ticket && !ticket.autoReplySent) {
            await ctx.reply(
                "✅ Ваше сообщение получено.\n" +
                "Если оператор сейчас занят, он ответит сразу, как освободится."
            );

            await Tickets.updateOne(
                { userId },
                { $set: { autoReplySent: true, updatedAt: new Date() } }
            );
        }
        // --------------------------------------------------------------

        // Копируем сообщение в тему саппорта
        await bot.telegram.callApi("copyMessage", {
            chat_id: SUPPORT_CHAT_ID,
            message_thread_id: threadId,
            from_chat_id: userId,
            message_id: ctx.message.message_id
        });

        return;
    }

    // Сообщение от оператора в AM Support Hub
    if (ctx.chat.id === SUPPORT_CHAT_ID && ctx.message.message_thread_id) {
        const threadId = ctx.message.message_thread_id;

        const t = await Tickets.findOne({ threadId });
        if (!t) return;

        // Не пересылать сообщения ботов
        if (ctx.from.is_bot) return;

        // Ответ операторов — клиенту
        await bot.telegram.callApi("copyMessage", {
            chat_id: t.userId,
            from_chat_id: SUPPORT_CHAT_ID,
            message_id: ctx.message.message_id
        });
    }
});

// ===== /close в теме саппорта =====
bot.command("close", async (ctx) => {
    if (ctx.chat.id !== SUPPORT_CHAT_ID || !ctx.message.message_thread_id) return;

    await Tickets.updateOne(
        { threadId: ctx.message.message_thread_id },
        { $set: { status: "closed", updatedAt: new Date() } }
    );

    await ctx.reply("Диалог закрыт ✅");
});

bot.launch();
console.log("Bot started…");
