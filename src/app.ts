import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";

const userQueues = new Map();
const userLocks = new Map();

// 🔹 Inicializar TwilioProvider
const adapterProvider = createProvider(TwilioProvider, {
    accountSid: process.env.ACCOUNT_SID,
    authToken: process.env.AUTH_TOKEN,
    vendorNumber: process.env.VENDOR_NUMBER,
});

// 🔹 Crear el servidor Express
const app = express();
app.use(express.urlencoded({ extended: false }));

// 🔹 Webhook de Twilio
app.post("/webhook", async (req, res) => {
    const twiml = new twilio.twiml.MessagingResponse();
    const mensajeEntrante = req.body.Body;
    const numeroRemitente = req.body.From;

    console.log(`📩 Mensaje recibido de ${numeroRemitente}: ${mensajeEntrante}`);

    // 🔸 Responder rápido para evitar JSON en WhatsApp
    res.type("text/xml").send(twiml.toString());

    // 🔸 Agregar mensaje a la cola y procesarlo
    if (!userQueues.has(numeroRemitente)) {
        userQueues.set(numeroRemitente, []);
    }

    const queue = userQueues.get(numeroRemitente);
    queue.push({
        ctx: { from: numeroRemitente, body: mensajeEntrante },
        flowDynamic: adapterProvider.sendMessage, // Pasamos la función de envío de mensajes
        state: null,
        provider: adapterProvider,
    });

    if (!userLocks.get(numeroRemitente) && queue.length === 1) {
        await handleQueue(numeroRemitente);
    }
});

// 🔹 Manejo de colas
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    if (userLocks.get(userId)) return;

    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);

    while (queue.length > 0) {
        userLocks.set(userId, true);
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error procesando mensaje para el usuario ${userId}:`, error);
        } finally {
            userLocks.set(userId, false);
        }
    }

    userLocks.delete(userId);
    userQueues.delete(userId);
};

// 🔹 Procesar mensajes con OpenAI
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    const startOpenAI = Date.now();
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);
    const endOpenAI = Date.now();
    console.log(`⏳ OpenAI Response Time: ${(endOpenAI - startOpenAI) / 1000} segundos`);

    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
        const startTwilio = Date.now();
        await flowDynamic([{ body: cleanedChunk }]);
        const endTwilio = Date.now();
        console.log(`📤 Twilio Send Time: ${(endTwilio - startTwilio) / 1000} segundos`);
    }
};

// 🔹 Flujo de bienvenida
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

// 🔹 Inicializar el bot y unirlo con Express
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

    // 🔹 Inyectamos Express en el mismo servidor de BuilderBot
    httpInject(app); // Inyectamos Express en BuilderBot
    app.use(httpServer); // Hacemos que Express maneje las peticiones del bot

    // 🔹 Iniciar el servidor en el puerto de Railway
    app.listen(PORT, () => {
        console.log(`🚀 Servidor WhatsApp ejecutándose en el puerto ${PORT}`);
    });
};

main();
