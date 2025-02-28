import "dotenv/config";
import express from "express";
import twilio from "twilio";

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

console.log("🚀 Iniciando aplicación");

// Crear la aplicación Express
console.log("📱 Creando app Express");
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Middleware para loguear todas las solicitudes
app.use((req, res, next) => {
  console.log(`📥 Solicitud recibida: ${req.method} ${req.path}`);
  console.log("📦 Cuerpo de la solicitud:", JSON.stringify(req.body).substring(0, 500)); // Limitar a 500 caracteres
  next();
});

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    console.log(`🧠 Procesando mensaje de ${ctx.from}: "${ctx.body}"`);
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
        
        // Verificar si flowDynamic es una función antes de llamarla
        if (typeof flowDynamic === 'function') {
            await flowDynamic([{ body: cleanedChunk }]);
        } else {
            // Si no hay flowDynamic, usar el cliente Twilio directamente
            console.log(`⚠️ flowDynamic no disponible, enviando mensaje directamente con Twilio`);
            const twilioClient = twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);
            await twilioClient.messages.create({
                body: cleanedChunk,
                from: `whatsapp:${process.env.VENDOR_NUMBER}`,
                to: ctx.from
            });
        }
        
        const endTwilio = Date.now();
        console.log(`📤 Mensaje enviado: "${cleanedChunk.substring(0, 50)}..."`);
        console.log(`📤 Twilio Send Time: ${(endTwilio - startTwilio) / 1000} segundos`);
    }
};

/**
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    
    if (userLocks.get(userId)) {
        console.log(`🔒 Cola bloqueada para ${userId}, omitiendo procesamiento`);
        return; // Si está bloqueado, omitir procesamiento
    }
    
    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);
    
    while (queue.length > 0) {
        userLocks.set(userId, true); // Bloquear la cola
        console.log(`🔒 Bloqueando cola para ${userId}`);
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            console.log(`🔄 Procesando mensaje de la cola para ${userId}`);
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`❌ Error procesando mensaje para el usuario ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Liberar el bloqueo
            console.log(`🔓 Liberando bloqueo para ${userId}`);
        }
    }

    userLocks.delete(userId); // Eliminar bloqueo una vez procesados todos los mensajes
    userQueues.delete(userId); // Eliminar la cola cuando se procesen todos los mensajes
    console.log(`🧹 Cola eliminada para ${userId}`);
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA.
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        console.log(`👋 Flujo de bienvenida activado para ${ctx.from}`);
        const userId = ctx.from; // Identificador único por usuario

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
            userLocks.set(userId, false);
            console.log(`🆕 Nueva cola creada para ${userId}`);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });
        console.log(`➕ Mensaje añadido a la cola de ${userId}, total: ${queue.length}`);

        // Si este es el único mensaje en la cola, procesarlo inmediatamente
        if (!userLocks.get(userId) && queue.length === 1) {
            console.log(`🔄 Iniciando procesamiento de cola para ${userId}`);
            await handleQueue(userId);
        }
    });

// Middleware para manejar el formato anidado de Twilio
const unwrapTwilioBody = (req, res, next) => {
    console.log("🔍 Verificando formato del cuerpo de la solicitud");
    // Si el cuerpo viene anidado dentro de otro objeto body
    if (req.body && req.body.body) {
        console.log("📦 Cuerpo anidado detectado, desenvolviendo");
        req.body = req.body.body;
    }
    next();
};

// Ruta de prueba para verificar que Express está funcionando
app.get('/test', (req, res) => {
  console.log("✅ Ruta de prueba accedida");
  res.send('El servidor Express está funcionando correctamente');
});

console.log("🛣️ Rutas y middleware definidos");

/**
 * Webhook de Twilio para recibir mensajes y confirmar su recepción.
 */
app.post("/webhook", unwrapTwilioBody, async (req, res) => {
    console.log("📩 Webhook de Twilio activado");
    console.log("📩 Mensaje recibido:", JSON.stringify(req.body).substring(0, 500)); // Limitar a 500 caracteres
    
    const twiml = new twilio.twiml.MessagingResponse();
    
    // Respuesta vacía para confirmar recepción
    console.log("📤 Enviando respuesta TwiML vacía");
    res.type('text/xml').send(twiml.toString());
    
    try {
        // Crear el contexto para el mensaje
        const ctx = {
            from: req.body.From,
            body: req.body.Body,
        };
        
        console.log(`📝 Contexto creado: from=${ctx.from}, body="${ctx.body}"`);
        
        // Agregar el mensaje a la cola del usuario
        const userId = ctx.from;
        
        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
            userLocks.set(userId, false);
            console.log(`🆕 Nueva cola creada para ${userId} desde webhook`);
        }
        
        // Aquí necesitarías referencias a los objetos adecuados
        // Esta es una solución temporal - lo ideal sería obtener estos objetos del bot
        const twilioClient = twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);
        let flowDynamicFunction = async (messages) => {
            console.log(`📲 Usando flowDynamic personalizado para enviar ${messages.length} mensajes`);
            // Enviar mensajes directamente usando Twilio si no tenemos acceso al flowDynamic
            for (const message of messages) {
                await twilioClient.messages.create({
                    body: message.body,
                    from: `whatsapp:${process.env.VENDOR_NUMBER}`,
                    to: userId
                });
                console.log(`📱 Mensaje enviado directamente a ${userId}: "${message.body.substring(0, 50)}..."`);
            }
        };
        
        const queue = userQueues.get(userId);
        queue.push({ 
            ctx, 
            flowDynamic: flowDynamicFunction, 
            state: {}, 
            provider: null 
        });
        console.log(`➕ Mensaje añadido a la cola de ${userId} desde webhook, total: ${queue.length}`);
        
        // Procesar la cola si no hay otros mensajes en procesamiento
        if (!userLocks.get(userId) && queue.length === 1) {
            console.log(`🔄 Iniciando procesamiento de cola para ${userId} desde webhook`);
            await handleQueue(userId);
        }
    } catch (error) {
        console.error("❌ Error procesando webhook:", error);
    }
});

/**
 * Función principal que configura e inicia el bot.
 */
const main = async () => {
    console.log("⚙️ Configurando el bot");
    
    const adapterFlow = createFlow([welcomeFlow]);
    console.log("📊 Flujo creado");

    const adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });
    console.log("🔌 Proveedor Twilio configurado");

    const startDB = Date.now();
    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,         // Host proporcionado por Railway
        user: process.env.POSTGRES_DB_USER,         // Usuario proporcionado por Railway
        password: process.env.POSTGRES_DB_PASSWORD, // Contraseña proporcionada por Railway
        database: process.env.POSTGRES_DB_NAME,     // Nombre de la base de datos
        port: Number(process.env.POSTGRES_DB_PORT)
    });
    const endDB = Date.now();
    console.log(`🗄️ Conexión a PostgreSQL establecida en ${(endDB - startDB) / 1000} segundos`);

    console.log("🤖 Creando bot...");
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });
    console.log("✅ Bot creado correctamente");

    // 🔥 Inyectar Express dentro del servidor de BuilderBot
    console.log("💉 Preparando inyección de Express");
    httpInject(app);
    console.log("✅ Express inyectado en el servidor BuilderBot");

    // Iniciar el servidor HTTP en el puerto definido
    httpServer(+PORT);
    console.log(`🌐 Servidor escuchando en el puerto ${PORT}`);
};

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});

// Iniciar el bot
console.log("🏁 Iniciando bot...");
main().catch(error => {
    console.error("❌ Error al iniciar el bot:", error);
});