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
    
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);

    // Divide la respuesta en fragmentos y los envía secuencialmente
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
        return; // Si está bloqueado, omitir procesamiento
    }
    
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
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
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
 * Interceptor del Webhook de Twilio para evitar respuestas JSON crudas
 */
const interceptWebhook = (server) => {
    server.post("/webhook", async (req, res) => {
        console.log("📩 Webhook recibido:", req.body);

        try {
            const messageData = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

            if (messageData && messageData.body) {
                res.json({ body: messageData.body }); // Solo enviar el mensaje limpio
            } else {
                res.json({ body: "Hubo un error procesando tu solicitud. Intenta de nuevo." });
            }
        } catch (error) {
            console.error("⚠️ Error procesando webhook:", error);
            res.json({ body: "No se pudo procesar tu mensaje en este momento." });
        }
    });
};

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
        port: Number(process.env.POSTGRES_DB_PORT)
    });

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server); // Inyectar el webhook de Twilio
    interceptWebhook(adapterProvider.server); // Interceptar mensajes JSON crudos antes de enviarlos
    httpServer(+PORT);
};

main();
