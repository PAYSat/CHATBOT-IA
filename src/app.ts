import "dotenv/config";
import express, { Request, Response } from "express";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

/** Puerto del servidor */
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3008;
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";

/** Mapeo de usuarios en espera y bloqueos */
const userQueues = new Map<string, any[]>();
const userLocks = new Map<string, boolean>();

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx: any, { flowDynamic, state, provider }: any) => {
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
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId: string, bot: any) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) {
        return;
    }

    console.log(`📩 Mensajes en la cola de ${userId}: ${queue?.length}`);

    while (queue?.length) {
        userLocks.set(userId, true);
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`🚨 Error procesando mensaje para ${userId}:`, error);
        } finally {
            userLocks.set(userId, false);
        }
    }

    userLocks.delete(userId);
    userQueues.delete(userId);
};

/**
 * Flujo de bienvenida del bot
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
            await handleQueue(userId, botInstance);
        }
    });

/**
 * Express para manejar el webhook de Twilio
 */
const app = express();
app.use(express.json());

let botInstance: any; // Almacena la instancia del bot

app.post("/webhook", async (req: Request, res: Response) => {
    console.log("📥 Webhook recibido de Twilio:", req.body);

    res.status(200).send("OK");

    const { Body, From } = req.body;
    const userId = From;

    if (!botInstance) {
        console.error("🚨 Bot no inicializado");
        return;
    }

    const { flowDynamic, state, provider } = botInstance;

    if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
    }

    const queue = userQueues.get(userId);
    queue.push({ ctx: { body: Body, from: From }, flowDynamic, state, provider });

    if (!userLocks.get(userId) && queue.length === 1) {
        await handleQueue(userId, botInstance);
    }
});

/**
 * Función principal que inicia el bot
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
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        password: process.env.POSTGRES_DB_PASSWORD,
        database: process.env.POSTGRES_DB_NAME,
        port: Number(process.env.POSTGRES_DB_PORT),
    });
    const endDB = Date.now();
    console.log(`🗄️ PostgreSQL Query Time: ${(endDB - startDB) / 1000} segundos`);

    botInstance = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpInject(adapterProvider.server);

    // 🔥 Se elimina la segunda llamada a `botInstance.httpServer(PORT)`
    app.listen(PORT, () => console.log(`🚀 Webhook escuchando en el puerto ${PORT}`));
};

main();
