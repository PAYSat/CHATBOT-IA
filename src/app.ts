import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from '@builderbot/provider-twilio';
import { toAsk } from "@builderbot-plugins/openai-assistants";
import express from 'express';

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';

/**
 * Función para procesar el mensaje del usuario.
 */
const processUserMessage = async (ctx, { flowDynamic, state }) => {
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);

    // Dividir la respuesta en partes y enviarlas secuencialmente
    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
        await flowDynamic([{ body: cleanedChunk }]);
    }
};

/**
 * Flujo de bienvenida.
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state }) => {
        await processUserMessage(ctx, { flowDynamic, state });
    });

/**
 * Función principal.
 */
const main = async () => {
    const app = express(); // Crear una instancia de Express

    // Middleware para parsear el cuerpo de las solicitudes entrantes
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

    const adapterDB = new PostgreSQLAdapter({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: Number(process.env.POSTGRES_DB_PORT)
    });

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Endpoint para manejar las solicitudes de Twilio
    app.post('/webhook', (req, res) => {
        const { Body, From } = req.body; // Extraer el cuerpo y el remitente del mensaje

        // Llamar a la lógica de procesamiento de mensajes
        adapterProvider.sendMessage(From, `Procesando tu mensaje: "${Body}"`);

        // Responder a Twilio con un 200 (éxito)
        res.status(200).end();
    });

    httpServer(app); // Pasar la instancia de Express al servidor HTTP
    app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
};

main();