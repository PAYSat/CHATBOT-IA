import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import express from "express"; // ✅ Usamos import en lugar de require
import { typing } from "./utils/presence";

/** Puerto asignado por Railway */
const PORT = Number(process.env.PORT) || 3008;

/** Webhook de Twilio - Evita que se reenvíe JSON en WhatsApp */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post("/webhook", (req, res) => {
    console.log("📩 Webhook recibido:", req.body);

    // 🔥 Solución: Evitamos que Twilio devuelva JSON en WhatsApp
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send("<Response></Response>");
});

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
    });

/** Función principal */
const main = async () => {
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

    httpServer(+PORT); // 🔥 Iniciamos el servidor correctamente
};

main();
