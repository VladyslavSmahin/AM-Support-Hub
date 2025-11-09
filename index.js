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

// DB
const mongo = new MongoClient(MONGODB_URI);
await mongo.connect();
const db = mongo.db(); // "amsupport"
const Tickets = db.collection("tickets");

// BOT
const bot = new Telegraf(BOT_TOKEN);

// Создание темы (topic) в AM Support Hub
async function ensureTopicForUser(userId) {
    let record = await Tickets.findOne({ userId });

    if (record && record.threadId) return record.threadId;

    const topic = await bot.telegram.callApi("createForumTopic", {
        chat_id: SUPPORT_CHAT_ID,
        name: `user_${userId}`
    });

    const threadId = topic.message_thread_id;

    await Tickets.updateOne(
        { userId },
        {
            $set: {
                userId,
                threadId,
                status: "open",
                updatedAt: new Date()
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );

    return threadId;
}

// START
bot.start(async (ctx) => {
    const src = ctx.startPayload || "app";
    const userId = ctx.from.id;

    const threadId = await ensureTopicForUser(userId);

    await Tickets.updateOne({ userId }, { $set: { source: src } });

    await ctx.reply("Привет! Напишите сообщение — оператор скоро ответит.");

    await bot.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `🆕 Новый диалог: user_${userId}\nИсточник: ${src}`,
        { message_thread_id: threadId }
    );
});

// Клиент пишет боту
bot.on("message", async (ctx) => {
    if (ctx.chat.type === "private") {
        const userId = ctx.from.id;
        const threadId = await ensureTopicForUser(userId);

        // Копируем в тему саппорта
        await bot.telegram.callApi("copyMessage", {
            chat_id: SUPPORT_CHAT_ID,
            message_thread_id: threadId,
            from_chat_id: userId,
            message_id: ctx.message.message_id
        });

        return;
    }

    // Сообщение от оператора в теме
    if (ctx.chat.id === SUPPORT_CHAT_ID && ctx.message.message_thread_id) {
        const threadId = ctx.message.message_thread_id;

        const t = await Tickets.findOne({ threadId });
        if (!t) return;

        // Не пересылать сообщения ботов
        if (ctx.from.is_bot) return;

        await bot.telegram.callApi("copyMessage", {
            chat_id: t.userId,
            from_chat_id: SUPPORT_CHAT_ID,
            message_id: ctx.message.message_id
        });
    }
});

// /close
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
