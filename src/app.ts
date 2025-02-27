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
    
    // Extraer el texto real del mensaje
    let userMessage = "";
    
    try {
        // Caso 1: ctx es el mensaje directo
        if (typeof ctx.body === 'string') {
            userMessage = ctx.body;
        } 
        // Caso 2: ctx.body es un objeto JSON con estructura Twilio
        else if (typeof ctx.body === 'object') {
            // Si ctx.body tiene directamente un campo Body
            if (ctx.body.Body) {
                userMessage = ctx.body.Body;
            } 
            // Si ctx.body tiene un objeto anidado con Body
            else if (ctx.body.body && ctx.body.body.Body) {
                userMessage = ctx.body.body.Body;
            } 
            // No se pudo extraer el texto
            else {
                console.log("⚠️ No se pudo extraer el texto del mensaje:", JSON.stringify(ctx.body).substring(0, 100) + "...");
                // En este caso, podemos enviar un mensaje genérico o ignorar
                await flowDynamic([{ body: "Lo siento, no pude entender tu mensaje. Por favor, intenta nuevamente." }]);
                return;
            }
        } else {
            console.log("⚠️ Formato de mensaje no reconocido:", typeof ctx.body);
            return;
        }
    } catch (error) {
        console.error("❌ Error al extraer el texto del mensaje:", error);
        return;
    }
    
    // Registrar el mensaje real que estamos procesando para debugging
    console.log(`🔍 Procesando mensaje: "${userMessage}"`);
    
    if (!userMessage.trim()) {
        console.log("⚠️ Mensaje vacío, no se procesará");
        return;
    }
    
    const startOpenAI = Date.now();
    const response = await toAsk(ASSISTANT_ID, userMessage, state);
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
 * 
 * @type {import('@builderbot/bot').Flow<TwilioProvider, PostgreSQLAdapter>}
 */
const welcomeFlow = addKeyword<TwilioProvider, PostgreSQLAdapter>(EVENTS.WELCOME)
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
 *  @async
 * @returns {Promise<void>}
 * 
 */
const main = async () => {
    /**
     * Flujo del bot
     * @type {import('@builderbot/bot').Flow<TwilioProvider, PostgreSQLAdapter>}
     */    

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

    /**
     * Configuración y creación del bot
     * @type {import('@builderbot/bot').Bot<TwilioProvider, PostgreSQLAdapter>}
     */

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);
    httpServer(+PORT);
};

main();