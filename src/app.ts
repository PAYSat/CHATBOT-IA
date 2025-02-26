import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import polka from "polka"; // 🔥 Importamos Polka para evitar errores de tipo

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
    
    const startOpenAI = Date.now();
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);
    const endOpenAI = Date.now();
    console.log(`⏳ OpenAI Response Time: ${(endOpenAI - startOpenAI) / 1000} segundos`);

    // Divide la respuesta en fragmentos y los envía secuencialmente
    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");

        const startTwilio = Date.now();
        console.log(`📤 Enviando mensaje a Twilio: ${cleanedChunk}`);
        
        await flowDynamic(cleanedChunk); // Enviar solo texto limpio
        
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
        host: process.env.PGHOST,         // ✅ Corrección de variables de Railway
        user: process.env.PGUSER,         // ✅ Corrección de variables de Railway
        password: process.env.PGPASSWORD, // ✅ Corrección de variables de Railway
        database: process.env.PGDATABASE, // ✅ Corrección de variables de Railway
        port: Number(process.env.PGPORT),
    });
    const endDB = Date.now();
    console.log(`🗄️ PostgreSQL Query Time: ${(endDB - startDB) / 1000} segundos`);

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    /**
     * 🔥 ✅ Solución Final para evitar respuesta JSON y corregir error TS2345
     */
    const polkaApp = polka(); // 🔥 Creamos una instancia de Polka
    
    polkaApp.use((req, res, next) => {
        console.log("📥 Webhook recibido de Twilio:");
        
        if (!req.body || Object.keys(req.body).length === 0) {
            console.error("🚨 Error: Webhook recibido sin datos válidos.");
            return res.status(400).send("Bad Request: No data received");
        }

        // 🚀 Responder con XML vacío inmediatamente para evitar respuesta JSON antes del mensaje real
        res.setHeader("Content-Type", "text/xml");
        res.status(200).end("<Response></Response>");
        
        // Continuar con el flujo de Twilio
        next();
    });

    httpInject(polkaApp); // ✅ Inyectamos correctamente Polka como servidor
    
    httpServer(+PORT);
    console.log(`🚀 Webhook escuchando en el puerto ${PORT}`);
};

main();
