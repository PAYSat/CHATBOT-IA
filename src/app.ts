import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import express from "express"; // Express manual para manejar respuestas del webhook
import { typing } from "./utils/presence";

/** Configuración del puerto */
const PORT = process.env.PORT || 0; // Permite que el sistema asigne un puerto libre
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map(); // Control de concurrencia para mensajes

/**
 * Procesa los mensajes del usuario con OpenAI y Twilio
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
        await flowDynamic([{ body: cleanedChunk }]);
        const endTwilio = Date.now();
        console.log(`📤 Twilio Send Time: ${(endTwilio - startTwilio) / 1000} segundos`);
    }
};

/**
 * Manejador de colas para evitar respuestas simultáneas desordenadas
 */
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
            console.error(`❌ Error procesando mensaje para el usuario ${userId}:`, error);
        } finally {
            userLocks.set(userId, false);
        }
    }

    userLocks.delete(userId);
    userQueues.delete(userId);
};

/**
 * Flujo inicial de bienvenida
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        // 🔥 Corrección: Intentamos convertir ctx.body en JSON si es un string válido
        let body;
        try {
            body = typeof ctx.body === "string" ? JSON.parse(ctx.body) : ctx.body;
        } catch (error) {
            body = ctx.body; // Si no es un JSON válido, lo dejamos como está
        }

        // 🔥 Ignorar mensajes automáticos de Twilio
        if (body && body.ApiVersion) {
            console.log("🔍 Mensaje automático de Twilio detectado, ignorándolo.");
            return;
        }

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
 * Función principal que configura e inicia el bot
 */
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

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

    // 🔥 SOLUCIÓN FINAL: Interceptamos manualmente la respuesta HTTP del webhook de Twilio
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.post("/webhook", (req, res) => {
        console.log("📩 Webhook recibido:", req.body);
        res.setHeader("Content-Type", "text/xml");
        res.status(200).send("<Response></Response>"); // Respuesta vacía para que Twilio la ignore
    });

    // 🔥 Servimos el bot en Express
    app.listen(PORT, () => console.log(`🚀 Servidor escuchando en el puerto ${PORT}`));

    httpServer(+PORT);
};

main();
