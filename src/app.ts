import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { createBot, createProvider, createFlow, addKeyword, EVENTS, httpInject } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";

const userQueues = new Map();
const userLocks = new Map();

// 🔹 Iniciar TwilioProvider
const adapterProvider = createProvider(TwilioProvider, {
    accountSid: process.env.ACCOUNT_SID,
    authToken: process.env.AUTH_TOKEN,
    vendorNumber: process.env.VENDOR_NUMBER,
});

// 🔹 Procesar mensajes entrantes de WhatsApp
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

// 🔹 Manejo de colas de mensajes
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

// 🔹 Inicializar el bot y webhook de Twilio en el mismo servidor
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        password: process.env.POSTGRES_DB_PASSWORD,
        database: process.env.POSTGRES_DB_NAME,
        port: Number(process.env.POSTGRES_DB_PORT),
    });

    const { httpServer, app } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // 🔹 Agregar el webhook de Twilio dentro del mismo servidor de BuilderBot
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

    // 🔹 Inyectar HTTP correctamente en el servidor de BuilderBot
    httpInject(httpServer);
    httpServer(+PORT);
    console.log(`🚀 Servidor WhatsApp ejecutándose en el puerto ${PORT}`);
};

main();
