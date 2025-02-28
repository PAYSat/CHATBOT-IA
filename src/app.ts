import "dotenv/config";
import express from "express";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import twilio from "twilio";


const MessagingResponse = twilio.twiml.MessagingResponse;
const app = express();
app.use(express.urlencoded({ extended: true })); // Manejar application/x-www-form-urlencoded
app.use(express.json());

const PORT = process.env.PORT ?? 8080;
const ASSISTANT_ID = process.env.ASSISTANT_ID || "";
const userQueues = new Map();
const userLocks = new Map();

// Verifica la firma de Twilio
const validateTwilioRequest = (req, res, next) => {
    const twilioSignature = req.headers['x-twilio-signature'];
    if (!twilioSignature) {
        console.warn("⚠️ Solicitud sin firma de Twilio. Posible acceso no autorizado.");
        return res.status(403).send("Acceso no autorizado");
    }
    next();
};

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

const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    if (userLocks.get(userId)) return;
    while (queue.length > 0) {
        userLocks.set(userId, true);
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`❌ Error procesando mensaje para ${userId}:`, error);
        } finally {
            userLocks.set(userId, false);
        }
    }
    userLocks.delete(userId);
    userQueues.delete(userId);
};

const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;
    if (!userQueues.has(userId)) userQueues.set(userId, []);
    userQueues.get(userId).push({ ctx, flowDynamic, state, provider });
    if (!userLocks.get(userId) && userQueues.get(userId).length === 1) {
        await handleQueue(userId);
    }
});

const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    app.post("/sms", validateTwilioRequest, (req, res) => {
        console.log("📩 Mensaje recibido de Twilio:", req.body);
    
        // Crear la respuesta en formato TwiML
        const response = new MessagingResponse();
        response.message("Recibimos tu mensaje, estamos procesándolo...");
    
        // Enviar la respuesta como XML
        res.Type("text/xml").send(response.toString()).status(200);
        
    });
    
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



main();
