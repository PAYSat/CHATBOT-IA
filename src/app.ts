import "dotenv/config";
import express from "express";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import process from "process";
import net from "net";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map(); // Mecanismo de bloqueo

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Deshabilitar encabezados automáticos de Express
app.use((req, res, next) => {
    res.removeHeader("Content-Length");
    res.removeHeader("Content-Type");
    next();
});

/**
 * Verificar si el puerto ya está en uso y liberarlo
 */
const checkPortInUse = (port: number, callback: () => void) => {
    const server = net.createServer();
    server.once("error", (err: any) => { // 👈 Usamos "any" para evitar error en "err.code"
        if (err.code === "EADDRINUSE") {
            console.error(`❌ Error: El puerto ${port} ya está en uso.`);
            process.exit(1); // Detener la ejecución
        }
    });

    server.once("listening", () => {
        server.close();
        callback();
    });

    server.listen(port);
};

/**
 * Procesa el mensaje del usuario y envía la respuesta de OpenAI a Twilio.
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
 * Maneja la cola de mensajes de cada usuario
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
 * Flujo de bienvenida
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;

    if (!userQueues.has(userId)) userQueues.set(userId, []);
    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });

    if (!userLocks.get(userId) && queue.length === 1) {
        await handleQueue(userId);
    }
});

/**
 * Iniciar el bot con BuilderBot y Twilio
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

    httpInject(adapterProvider.server);

    httpServer(+PORT);
};

/**
 * Webhook de Twilio para recibir mensajes de WhatsApp.
 * Asegura que no se devuelva el JSON recibido.
 */
app.post("/webhook", (req, res) => {
    console.log("📩 Webhook recibido desde Twilio:", req.body);
    res.status(204).send(); // Responde con 204 No Content para evitar respuestas automáticas
});

/**
 * Iniciar el servidor Express en Railway con control de errores
 */
checkPortInUse(PORT, () => {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    }).on("error", (err: any) => { // 👈 Usamos "any" para evitar error en "err.code"
        if (err.code === "EADDRINUSE") {
            console.error(`❌ Error: El puerto ${PORT} ya está en uso.`);
            process.exit(1);
        }
    });
});

main().catch((error) => console.error("❌ Error iniciando el bot:", error));
