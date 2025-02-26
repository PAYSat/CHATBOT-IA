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
 * Interfaz para el payload de Twilio.
 */
interface TwilioPayload {
    Body: string;
    From: string;
    To: string;
    // Otros campos que puedan estar presentes en el payload
}

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx: { body: string; from: string }, { flowDynamic, state, provider }) => {
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
        console.error(`Error procesando mensaje para el usuario ${ctx.from}:`, error);
        await flowDynamic([{ body: "Lo siento, hubo un error al procesar tu mensaje. Por favor, inténtalo de nuevo." }]);
    }
};

/**
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId: string) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) {
        return; // Si está bloqueado, omitir procesamiento
    }

    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);

    userLocks.set(userId, true); // Bloquear la cola

    try {
        while (queue.length > 0) {
            const { ctx, flowDynamic, state, provider } = queue.shift();
            try {
                await processUserMessage(ctx, { flowDynamic, state, provider });
            } catch (error) {
                console.error(`Error procesando mensaje para el usuario ${userId}:`, error);
            }
        }
    } finally {
        userLocks.delete(userId); // Eliminar bloqueo una vez procesados todos los mensajes
        userQueues.delete(userId); // Eliminar la cola cuando se procesen todos los mensajes
    }
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx: { body: TwilioPayload | string; from: string }, { flowDynamic, state, provider }) => {
        console.log("Payload recibido:", ctx.body); // Depuración del payload
        const userId = ctx.from; // Identificador único por usuario

        // Extraer el mensaje del usuario
        const userMessage = typeof ctx.body === 'string' ? ctx.body : ctx.body.Body;

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx: { ...ctx, body: userMessage }, flowDynamic, state, provider });

        // Si este es el único mensaje en la cola, procesarlo inmediatamente
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

    const startDB = Date.now();
    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,         // Host proporcionado por Railway
        user: process.env.POSTGRES_DB_USER,         // Usuario proporcionado por Railway
        password: process.env.POSTGRES_DB_PASSWORD, // Contraseña proporcionada por Railway
        database: process.env.POSTGRES_DB_NAME,     // Nombre de la base de datos
        port: Number(process.env.POSTGRES_DB_PORT)
    });
    const endDB = Date.now();
    console.log(`🗄️ PostgreSQL Query Time: ${(endDB - startDB) / 1000} segundos`);

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);
    httpServer(+PORT);
};

main();