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

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008;

/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";

const userQueues = new Map();
const userLocks = new Map(); // Mecanismo de bloqueo

// Variable global para el adapterProvider
let adapterProvider;

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);

    const startOpenAI = Date.now();
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);
    const endOpenAI = Date.now();
    console.log(`⏳ OpenAI Response Time: ${(endOpenAI - startOpenAI) / 1000} segundos`);

    // Divide la respuesta en fragmentos y los envía secuencialmente
    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");

        const startTwilio = Date.now();
        await flowDynamic([{ body: cleanedChunk }]);
        const endTwilio = Date.now();
        console.log(`📤 Twilio Send Time: ${(endTwilio - startTwilio) / 1000} segundos`);
    }
};

/**
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) {
        return; // Si está bloqueado, omitir procesamiento
    }

    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);

    while (queue.length > 0) {
        userLocks.set(userId, true); // Bloquear la cola
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error procesando mensaje para el usuario ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Liberar el bloqueo
        }
    }

    userLocks.delete(userId); // Eliminar bloqueo una vez procesados todos los mensajes
    userQueues.delete(userId); // Eliminar la cola cuando se procesen todos los mensajes
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from; // Identificador único por usuario

    if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
    }

    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });

    // Si este es el único mensaje en la cola, procesarlo inmediatamente
    if (!userLocks.get(userId) && queue.length === 1) {
        await handleQueue(userId);
    }
});

/**
 * Endpoint para recibir mensajes de WhatsApp
 */
app.post("/webhook", async (req, res) => {
    const twiml = new twilio.twiml.MessagingResponse();
    const mensajeEntrante = req.body.Body;
    const numeroRemitente = req.body.From;

    console.log(`📩 Mensaje recibido de ${numeroRemitente}: ${mensajeEntrante}`);

    res.type("text/xml").send(twiml.toString()); // Respuesta vacía para Twilio

    if (!adapterProvider) {
        console.error("❌ ERROR: `adapterProvider` no está definido aún.");
        return res.status(500).send("Error interno: `adapterProvider` no está inicializado.");
    }

    if (typeof adapterProvider.sendMessage !== "function") {
        console.error("❌ ERROR: `sendMessage` no está definido en `adapterProvider`.");
        return res.status(500).send("Error interno: `sendMessage` no es una función válida.");
    }

    // Crear un objeto state con los métodos necesarios
    const state = {
        get: (key) => null, // Placeholder
        set: (key, value) => {},
        update: (data) => console.log("Actualizando estado:", data),
    };

    // Crear una función flowDynamic para enviar mensajes
    const flowDynamic = async (messages) => {
        for (const message of messages) {
            try {
                await adapterProvider.vendor.twilio.messages.create({
                    body: message.body,
                    from: process.env.VENDOR_NUMBER,
                    to: numeroRemitente,
                });
                console.log("✅ Mensaje enviado a WhatsApp:", message.body);
            } catch (error) {
                console.error("❌ Error enviando mensaje:", error);
            }
        }
    };

    // Llamar a processUserMessage con los parámetros correctos
    await processUserMessage(
        { body: mensajeEntrante, from: numeroRemitente },
        { flowDynamic, state, provider: adapterProvider }
    );
});

/**
 * Función principal que configura e inicia el bot
 */
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    // Inicializar el adapterProvider
    adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

    console.log("✅ Twilio Provider Inicializado:", adapterProvider);
    console.log("🛠 Métodos disponibles en `adapterProvider`:", Object.keys(adapterProvider));

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
