import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { PostgreSQLAdapter } from "@builderbot/database-postgres";; // Adaptador de PostgreSQL
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
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        vendorNumber: process.env.TWILIO_PHONE_NUMBER,
    });

    // Configuración de PostgreSQL
    const adapterDB = new PostgreSQLAdapter({
        user: process.env.DB_USER,       // Usuario de la base de datos
        host: process.env.DB_HOST,       // Host de la base de datos
        database: process.env.DB_NAME,   // Nombre de la base de datos
        password: process.env.DB_PASSWORD, // Contraseña de la base de datos
        port: Number(process.env.POSTGRES_DB_PORT) // Puerto de PostgreSQL (por defecto 5432)
    });

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Endpoint para manejar las solicitudes de Twilio
    app.post('/webhook', async (req, res) => {
        try {
            const { Body, From } = req.body; // Extraer el cuerpo y el remitente del mensaje

            // Verificar que el mensaje y el remitente estén presentes
            if (!Body || !From) {
                throw new Error("Faltan campos 'Body' o 'From' en la solicitud.");
            }

            // Enviar una respuesta directa al usuario
            await adapterProvider.sendMessage(From, `Procesando tu mensaje: "${Body}"`);

            // Responder a Twilio con un 200 (éxito)
            res.status(200).end();
        } catch (error) {
            console.error("Error en el webhook:", error.message);
            res.status(500).json({ error: "Error interno del servidor" });
        }
    });

    httpServer(app); // Pasar la instancia de Express al servidor HTTP
    app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
};

main();