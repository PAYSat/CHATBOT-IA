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

// Flag para evitar procesamiento redundante
const processedMessages = new Map();

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    
    // Extraer el texto real del mensaje
    let userMessage = "";
    let messageId = "";
    
    try {
        // Extraer ID del mensaje para evitar procesamiento duplicado
        if (typeof ctx.body === 'object') {
            messageId = ctx.body.MessageSid || ctx.body.SmsSid || 
                      (ctx.body.body && (ctx.body.body.MessageSid || ctx.body.body.SmsSid)) || 
                      Date.now().toString();
        } else {
            messageId = Date.now().toString();
        }
        
        // Verificar si este mensaje ya ha sido procesado
        if (processedMessages.has(messageId)) {
            console.log(`🔄 Mensaje ya procesado, ignorando duplicado: ${messageId}`);
            return;
        }
        
        // Marcar este mensaje como procesado
        processedMessages.set(messageId, true);
        
        // Limpiar mensajes procesados antiguos (más de 1 hora)
        setTimeout(() => {
            processedMessages.delete(messageId);
        }, 3600000); // 1 hora
        
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
                return; // No procesar este mensaje
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
    console.log(`🔍 Procesando mensaje: "${userMessage}" (ID: ${messageId})`);
    
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

// Usar un keyword específico para el flujo en lugar de array vacío
const messageFlow = addKeyword<TwilioProvider, PostgreSQLAdapter>(["*"])
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        // No podemos interceptar flowDynamic directamente debido a limitaciones de TypeScript
        // En su lugar, filtramos los mensajes en el nivel de procesamiento
        
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
    // También necesitamos el flujo de bienvenida para capturar todos los eventos
    const welcomeFlow = addKeyword<TwilioProvider, PostgreSQLAdapter>(EVENTS.WELCOME)
        .addAction(async (ctx, { flowDynamic }) => {
            // Si el mensaje parece ser un JSON completo, no responder
            if (typeof ctx.body === 'object') {
                const bodyStr = JSON.stringify(ctx.body);
                if (bodyStr.includes('SmsMessageSid') || bodyStr.includes('MessageSid')) {
                    console.log("🛑 Ignorando mensaje JSON inicial");
                    return;
                }
            }
            
            // Si llegamos aquí, es un mensaje de bienvenida genuino
            console.log("👋 Procesando mensaje de bienvenida");
        });

    const adapterFlow = createFlow([welcomeFlow, messageFlow]);

    const adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

    const startDB = Date.now();
    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        password: process.env.POSTGRES_DB_PASSWORD,
        database: process.env.POSTGRES_DB_NAME,
        port: Number(process.env.POSTGRES_DB_PORT)
    });
    const endDB = Date.now();
    console.log(`🗄️ PostgreSQL Query Time: ${(endDB - startDB) / 1000} segundos`);

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Usamos el servidor Express para agregar un middleware personalizado
    if (adapterProvider.server) {
        adapterProvider.server.use((req, res, next) => {
            // Si es una petición POST al webhook
            if (req.method === 'POST' && req.url === '/webhook' && req.body) {
                // Log para debugging
                console.log("📥 Webhook recibido:", JSON.stringify(req.body).substring(0, 100) + "...");
            }
            next();
        });
    }

    httpInject(adapterProvider.server);
    httpServer(+PORT);
};

main();