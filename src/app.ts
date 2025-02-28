import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map();

const app = express();
app.use(express.urlencoded({ extended: false }));

const adapterProvider = createProvider(TwilioProvider, {
    accountSid: process.env.ACCOUNT_SID,
    authToken: process.env.AUTH_TOKEN,
    vendorNumber: process.env.VENDOR_NUMBER,
});

app.post("/webhook", async (req, res) => {
    const twiml = new twilio.twiml.MessagingResponse();
    const mensajeEntrante = req.body.Body;
    const numeroRemitente = req.body.From;

    console.log(`📩 Mensaje recibido de ${numeroRemitente}: ${mensajeEntrante}`);

    res.type("text/xml").send(twiml.toString()); // Evita devolver JSON en WhatsApp
    processUserMessage(numeroRemitente, mensajeEntrante, {});
});

const processUserMessage = async (from, body, state) => {
    console.log(`🧠 Procesando mensaje de ${from}: ${body}`);

    try {
        const response = await toAsk(ASSISTANT_ID, body, state ?? { update: () => {}, getMyState: () => {}, get: () => {}, clear: () => {} });
        const chunks = response.split(/\n\n+/);

        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");

            await adapterProvider.sendMessage(from, cleanedChunk);

            console.log(`📤 Mensaje enviado a ${from}: ${cleanedChunk}`);
        }
    } catch (error) {
        console.error(`❌ Error procesando mensaje para ${from}:`, error);
    }
};

const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;

    if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
    }

    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });

    if (!userLocks.get(userId) && queue.length === 1) {
        await handleQueue(userId);
    }
});

const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    if (userLocks.get(userId)) return;

    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);

    while (queue.length > 0) {
        userLocks.set(userId, true);
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx.from, ctx.body, state);
        } catch (error) {
            console.error(`Error procesando mensaje para el usuario ${userId}:`, error);
        } finally {
            userLocks.set(userId, false);
        }
    }

    userLocks.delete(userId);
    userQueues.delete(userId);
};

const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        password: process.env.POSTGRES_DB_PASSWORD,
        database: process.env.POSTGRES_DB_NAME,
        port: Number(process.env.POSTGRES_DB_PORT),
    });

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    app.listen(PORT, () => {
        console.log(`🚀 Servidor WhatsApp ejecutándose en el puerto ${PORT}`);
    });
};

main();
