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
const userLocks = new Map(); // Mecanismo de bloqueo

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    
    try {
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
    } catch (error) {
        console.error("❌ Error en OpenAI:", error);
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
            console.error(`❌ Error procesando mensaje para el usuario ${userId}:`, error);
            queue.unshift({ ctx, flowDynamic, state, provider }); // Volver a ponerlo en la cola para reintentar
        } finally {
            userLocks.set(userId, false); // Liberar el bloqueo
        }
    }

    if (queue.length === 0) {
        userLocks.delete(userId);
        userQueues.delete(userId);
    }
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        // Esperar hasta que Twilio y OpenAI respondan antes de enviar JSON
        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }

        // Evitar respuesta automática de Twilio en formato JSON prematuro
        return new Promise((resolve) => setTimeout(resolve, 1000));
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
        httpServer(+PORT);
    } catch (error) {
        console.error("❌ Error al conectar a PostgreSQL:", error);
        process.exit(1); // Terminar si la conexión a la base de datos falla
    }
};

main();
