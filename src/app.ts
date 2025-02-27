import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import express from "express";
import net from "net"; // Para verificar si el puerto está en uso
import { typing } from "./utils/presence";

/** Verifica si el puerto está en uso y elige uno nuevo si es necesario */
const checkPortInUse = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(true); // Puerto en uso
            } else {
                resolve(false); // Otro error
            }
        });

        server.once("listening", () => {
            server.close();
            resolve(false); // Puerto disponible
        });

        server.listen(port);
    });
};

/** Busca un puerto disponible */
const getAvailablePort = async (): Promise<number> => {
    let port = Number(process.env.PORT) || 3008;
    while (await checkPortInUse(port)) {
        console.log(`⚠️ Puerto ${port} en uso. Buscando otro...`);
        port = Math.floor(Math.random() * (9000 - 3000) + 3000);
    }
    return port;
};

/** Procesamiento de mensajes del usuario con OpenAI */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);

    const startOpenAI = Date.now();
    const response = await toAsk(process.env.ASSISTANT_ID, ctx.body, state);
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

/** Manejador de colas para evitar respuestas simultáneas desordenadas */
const userQueues = new Map();
const userLocks = new Map();

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

/** Flujo de bienvenida optimizado */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from;

        let body;
        try {
            body = typeof ctx.body === "string" ? JSON.parse(ctx.body) : ctx.body;
        } catch (error) {
            body = ctx.body;
        }

        if (body && body.ApiVersion) {
            console.log("🔍 Mensaje automático de Twilio detectado, ignorándolo.");
            return;
        }

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });

/** Función principal */
const main = async () => {
    const PORT = await getAvailablePort(); // Obtener un puerto disponible dinámicamente
    console.log(`🚀 Iniciando servidor en el puerto ${PORT}`);

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

    /** 🔥 Solución definitiva: Interceptamos manualmente la respuesta HTTP del webhook de Twilio */
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.post("/webhook", (req, res) => {
        console.log("📩 Webhook recibido:", req.body);
        res.setHeader("Content-Type", "text/xml");
        res.status(200).send("<Response></Response>"); // Respuesta vacía para que Twilio la ignore
    });

    app.listen(PORT, () => console.log(`✅ Servidor escuchando en el puerto ${PORT}`));

    httpServer(+PORT);
};

main();
