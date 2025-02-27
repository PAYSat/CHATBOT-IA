import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008;
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map();

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);

    let maxRetries = 3;
    let retries = 0;
    let response = "";

    while (retries < maxRetries) {
        try {
            console.log(`🔄 Intento ${retries + 1} de ${maxRetries} para OpenAI...`);

            const startOpenAI = Date.now();
            response = await toAsk(ASSISTANT_ID, ctx.body, state);
            const endOpenAI = Date.now();

            console.log(`✅ OpenAI respondió en ${(endOpenAI - startOpenAI) / 1000} segundos`);
            break;
        } catch (error) {
            console.error(`❌ Error en OpenAI (Intento ${retries + 1}):`, error.message);

            if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT") {
                retries++;
                console.log("♻️ Reintentando conexión con OpenAI...");
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } else {
                break;
            }
        }
    }

    if (!response) {
        console.log("🚨 OpenAI no respondió después de varios intentos.");
        response = "Lo siento, no puedo responder en este momento. Inténtalo más tarde.";
    }

    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
        await flowDynamic([{ body: cleanedChunk }]);
    }
};

/**
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) {
        return;
    }

    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);

    while (queue.length > 0) {
        userLocks.set(userId, true);
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`❌ Error procesando mensaje para el usuario ${userId}:`, error);
            queue.unshift({ ctx, flowDynamic, state, provider });
        } finally {
            userLocks.set(userId, false);
        }
    }

    if (queue.length === 0) {
        userLocks.delete(userId);
        userQueues.delete(userId);
    }
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA.
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        // ✅ Responder inmediatamente a Twilio con una respuesta vacía antes de procesar OpenAI
        setTimeout(() => {
            if (!userLocks.get(userId) && queue.length === 1) {
                handleQueue(userId);
            }
        }, 500);

        return ""; // 🔥 Esta línea evita que Twilio envíe JSON como mensaje.
    });

/**
 * Función principal que configura e inicia el bot.
 */
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

    try {
        console.log("⏳ Conectando a la base de datos...");
        const adapterDB = new PostgreSQLAdapter({
            host: process.env.POSTGRES_DB_HOST,
            user: process.env.POSTGRES_DB_USER,
            password: process.env.POSTGRES_DB_PASSWORD,
            database: process.env.POSTGRES_DB_NAME,
            port: Number(process.env.POSTGRES_DB_PORT)
        });

        console.log("✅ PostgreSQL conectado exitosamente.");

        const { httpServer } = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        httpInject(adapterProvider.server);

        // ✅ RESPONDER INMEDIATAMENTE A TWILIO PARA EVITAR EL JSON COMO MENSAJE
        adapterProvider.server.post("/webhook", (req, res) => {
            console.log("📩 Mensaje recibido de Twilio:", req.body);
            res.status(200).send(""); // 🔥 Esta línea evita que Twilio envíe el JSON como mensaje.
        });

        httpServer(+PORT);
        console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    } catch (error) {
        console.error("❌ Error al conectar a PostgreSQL:", error);
        process.exit(1);
    }
};

main();
