import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import polka from "polka";
import bodyParser from "body-parser"; // 🔥 Agregamos body-parser

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT || 3008; // Usa el puerto asignado por Railway o 3008 si es local

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
        const userId = ctx.from;
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

    const polkaApp = polka();
    polkaApp.use(bodyParser.urlencoded({ extended: false }));
    polkaApp.use(bodyParser.json());

    polkaApp.post("/webhook", async (req, res) => {
        console.log("📥 Webhook recibido de Twilio:", JSON.stringify(req.body, null, 2));

        res.setHeader("Content-Type", "text/xml");
        res.status(200).end("<Response></Response>");

        let messageBody = req.body.Body || (req.body.body && req.body.body.Body);
        let sender = req.body.From || (req.body.body && req.body.body.From);

        if (!messageBody || !sender) {
            console.error("🚨 Error: No se pudo extraer el mensaje o el remitente.");
            return;
        }

        console.log(`📩 Mensaje recibido de ${sender}: ${messageBody}`);
    });

    polkaApp.listen(PORT, () => {
        console.log(`🚀 Servidor Polka corriendo en el puerto ${PORT}`);
    });
};

main();
