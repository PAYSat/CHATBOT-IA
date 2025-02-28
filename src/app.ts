import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import http from "http"; // Importar el módulo http

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map();

// Crear una instancia de Express
const app = express();
app.use(express.urlencoded({ extended: false })); // Middleware para parsear el cuerpo de las solicitudes

// Configura el proveedor de Twilio
const adapterProvider = createProvider(TwilioProvider, {
    accountSid: process.env.ACCOUNT_SID,
    authToken: process.env.AUTH_TOKEN,
    vendorNumber: process.env.VENDOR_NUMBER,
});

// Configura el flujo de bienvenida
const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state, provider }) => {
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

// Función para procesar mensajes del usuario
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    
    const startOpenAI = Date.now();
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);
    const endOpenAI = Date.now();
    console.log(`⏳ OpenAI Response Time: ${(endOpenAI - startOpenAI) / 1000} segundos`);

    // Divide la respuesta en fragmentos y los envía secuencialmente
    const chunks = response.split(/\n\n+/);
    let fullResponse = "";
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
        fullResponse += cleanedChunk + "\n\n";
    }

    return fullResponse.trim();
};

// Función para manejar la cola de mensajes
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    if (userLocks.get(userId)) return;

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
    userLocks.delete(userId);
    userQueues.delete(userId);
};

// Ruta personalizada para el webhook de Twilio
app.post("/webhook", async (req, res) => {
    const twiml = new twilio.twiml.MessagingResponse();
    const mensajeEntrante = req.body.Body;
    const numeroRemitente = req.body.From;

    console.log(`📩 Mensaje recibido de ${numeroRemitente}: ${mensajeEntrante}`);

    res.type("text/xml").send(twiml.toString()); // Evita devolver JSON en WhatsApp

    // Procesar el mensaje y enviar la respuesta
    const response = await processUserMessage({ body: mensajeEntrante, from: numeroRemitente }, { flowDynamic: null, state: null, provider: adapterProvider });

    // Enviar la respuesta al usuario
    if (response) {
        await adapterProvider.sendMessage(numeroRemitente, response);
    }
});

// Otras rutas personalizadas (si las necesitas)
app.get("/status", (req, res) => {
    res.send("El servidor está en funcionamiento 🚀");
});

// Función principal
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        password: process.env.POSTGRES_DB_PASSWORD,
        database: process.env.POSTGRES_DB_NAME,
        port: Number(process.env.POSTGRES_DB_PORT),
    });

    // Crear el bot y obtener el httpServer
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Crear un servidor HTTP manualmente
    const server = http.createServer(app);

    // Integrar el servidor HTTP de createBot con Express
    server.on("request", (req, res) => {
        app(req, res); // Pasar las solicitudes a la aplicación Express
    });

    // Iniciar el servidor
    server.listen(PORT, () => {
        console.log(`🚀 Servidor WhatsApp ejecutándose en el puerto ${PORT}`);
    });
};

main();