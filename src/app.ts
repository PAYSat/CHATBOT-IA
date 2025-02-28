import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import express from "express";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map();

let adapterProvider = null; // Evitar que sea undefined

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
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
        try {
            await flowDynamic([{ body: cleanedChunk }]); // BuilderBot maneja el envío
            console.log("✅ Mensaje enviado correctamente a WhatsApp:", cleanedChunk);
        } catch (error) {
            console.error("❌ Error al enviar mensaje con Twilio:", error);
        }
        const endTwilio = Date.now();
        console.log(`📤 Twilio Send Time: ${(endTwilio - startTwilio) / 1000} segundos`);
    }
};

/**
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId) => {
    if (userLocks.get(userId)) {
        console.log(`⏳ Usuario ${userId} ya tiene un proceso en ejecución.`);
        return;
    }
    userLocks.set(userId, true);

    const queue = userQueues.get(userId);
    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);

    while (queue.length > 0) {
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`❌ Error procesando mensaje para el usuario ${userId}:`, error);
        }
    }

    userLocks.delete(userId);
    userQueues.delete(userId);
};

/**
 * Flujo de bienvenida.
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
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

/**
 * Webhook de Twilio.
 */
app.post("/webhook", async (req, res) => {
    const twiml = new twilio.twiml.MessagingResponse();
    const mensajeEntrante = req.body.Body;
    const numeroRemitente = req.body.From;

    console.log(`📩 Mensaje recibido de ${numeroRemitente}: ${mensajeEntrante}`);

    if (!adapterProvider) {
        console.error("❌ ERROR: `adapterProvider` no está definido aún.");
        return res.status(500).send("Error interno: `adapterProvider` no está inicializado.");
    }

    const state = {
        get: (key) => null,
        set: (key, value) => {},
        update: (data) => console.log("Actualizando estado:", data),
    };

    const flowDynamicWrapper = async (messages) => {
        for (const message of messages) {
            console.log("✅ Intentando enviar mensaje:", message.body);

            try {
                await adapterProvider.sendMessage({
                    to: numeroRemitente,
                    from: process.env.VENDOR_NUMBER,
                    body: message.body,
                });
                console.log("✅ Mensaje enviado correctamente a WhatsApp:", message.body);
            } catch (error) {
                console.error("❌ Error al enviar mensaje con Twilio:", error);
            }
        }
    };

    await processUserMessage(
        { body: mensajeEntrante, from: numeroRemitente },
        { flowDynamic: flowDynamicWrapper, state, provider: adapterProvider }
    );

    // Evita el JSON molesto respondiendo con un XML válido
    twiml.message("Gracias por tu mensaje. Estamos procesándolo.");
    res.type("text/xml").send(twiml.toString());
});

/**
 * Función principal que configura e inicia el bot.
 */
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

    console.log("✅ Twilio Provider Inicializado:", adapterProvider);

    const startDB = Date.now();
    const adapterDB = new PostgreSQLAdapter({
        host: process.env.PGHOST,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        port: Number(process.env.PGPORT),
    });
    const endDB = Date.now();
    console.log(`🗄️ PostgreSQL Query Time: ${(endDB - startDB) / 1000} segundos`);

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);
    
    app.listen(PORT, () => {
        console.log(`🚀 Servidor WhatsApp ejecutándose en el puerto ${PORT}`);
    });
};

main();
