import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS, utils } from "@builderbot/bot";
import { PostgreSQLAdapter as Database } from "@builderbot/database-postgres";
import { TwilioProvider as Provider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import express from "express";
import { typing } from "./utils/presence";

/** 🔥 Configuración */
const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";

/** Manejador de mensajes con OpenAI */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    console.log(`📨 Mensaje recibido de ${ctx.from}: ${ctx.body}`);

    // Enviar estado "escribiendo..."
    typing(ctx, provider).catch((err) => console.log("⚠️ Error en typing:", err));

    let response;
    try {
        response = await toAsk(ASSISTANT_ID, ctx.body, state);
    } catch (error) {
        console.error("❌ Error en OpenAI:", error);
        response = "Lo siento, hubo un problema procesando tu mensaje.";
    }

    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        await flowDynamic([{ body: chunk.trim() }]);
    }
};

/** 🔥 Flujos */
const welcomeFlow = addKeyword([EVENTS.WELCOME])
    .addAnswer("🙌 ¡Hola! Soy tu asistente. ¿Cómo puedo ayudarte?")
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        await processUserMessage(ctx, { flowDynamic, state, provider });
    });

/** 🔥 Función principal */
const main = async () => {
    console.log(`🚀 Iniciando servidor en el puerto ${PORT}`);

    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(Provider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

    const adapterDB = new Database({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        database: process.env.POSTGRES_DB_NAME,
        password: process.env.POSTGRES_DB_PASSWORD,
        port: +process.env.POSTGRES_DB_PORT,
    });

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    /** 🔥 Configuración de Express */
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    /** ✅ Webhook de Twilio mejorado */
    adapterProvider.server.post(
        "/v1/messages",
        handleCtx(async (bot, req, res) => {
            console.log("📩 Webhook recibido:", req.body);
            const { number, message } = req.body;

            if (!number || !message) {
                console.log("⚠️ Petición incorrecta.");
                return res.status(400).json({ error: "Número o mensaje no válidos." });
            }

            await bot.sendMessage(number, message);
            console.log(`📤 Mensaje enviado a ${number}: ${message}`);
            res.setHeader("Content-Type", "text/xml");
            return res.status(200).send("<Response></Response>");
        })
    );

    /** ✅ Registrar usuario manualmente */
    adapterProvider.server.post(
        "/v1/register",
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body;
            await bot.dispatch("REGISTER_FLOW", { from: number, name });
            res.end("trigger");
        })
    );

    /** 🔥 Mantener Railway activo */
    setInterval(() => {
        console.log("💡 Mantenemos el contenedor activo...");
    }, 60000);

    httpServer(+PORT);
};

main();
