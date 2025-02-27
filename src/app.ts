import "dotenv/config";
import express from "express";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import process from "process";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3008; // 🔹 Usamos solo el puerto 3008
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Evitar respuestas JSON automáticas en Express
app.use((req, res, next) => {
    res.removeHeader("Content-Length");
    res.removeHeader("Content-Type");
    next();
});

/**
 * Webhook de Twilio para recibir mensajes de WhatsApp.
 * Responde con 204 No Content para evitar respuestas automáticas.
 */
app.post("/webhook", (req, res) => {
    console.log("📩 Webhook recibido desde Twilio:", req.body);
    res.status(204).send(); // Asegura que Twilio no reciba JSON
});

/**
 * Iniciar el servidor Express en el puerto 3008
 */
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
}).on("error", (err: any) => { // 🔹 Se mantiene "any" para evitar errores de TypeScript
    if (err.code === "EADDRINUSE") {
        console.error(`❌ Error: El puerto ${PORT} ya está en uso.`);
        process.exit(1);
    }
});

/**
 * Iniciar el bot con BuilderBot y Twilio
 */
const main = async () => {
    const adapterFlow = createFlow([
        addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic }) => {
            await flowDynamic([{ body: "¡Hola! Soy tu asistente PAYSAT." }]);
        }),
    ]);

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

    httpServer(PORT); // 🔹 BuilderBot sigue usando el mismo puerto
};

main().catch((error) => console.error("❌ Error iniciando el bot:", error));
