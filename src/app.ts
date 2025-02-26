import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import express from 'express'; // Importar Express
import bodyParser from 'body-parser'; // Importar body-parser para manejar el cuerpo de las solicitudes

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008;
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map(); // Mecanismo de bloqueo

/**
 * Crear un objeto state personalizado con un método update
 */
const createState = () => {
    const data = new Map(); // Usamos un Map para almacenar los datos

    return {
        get: (key) => data.get(key),
        set: (key, value) => data.set(key, value),
        update: (key, value) => {
            if (data.has(key)) {
                data.set(key, { ...data.get(key), ...value });
            } else {
                data.set(key, value);
            }
        },
    };
};

/**
 * Procesa el mensaje del usuario enviándolo a OpenAI y devolviendo la respuesta.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    try {
        await typing(ctx, provider);

        console.log('State:', state);
        console.log('Mensaje:', ctx.body);

        const startOpenAI = Date.now();

        // Asegúrate de que el mensaje no esté vacío
        if (!ctx.body || typeof ctx.body !== 'string') {
            throw new Error('El mensaje no puede estar vacío.');
        }

        // Llama a toAsk con el mensaje directamente
        const response = await toAsk(ASSISTANT_ID, ctx.body, state);

        const endOpenAI = Date.now();
        console.log(`⏳ OpenAI Response Time: ${(endOpenAI - startOpenAI) / 1000} segundos`);

        // Divide la respuesta en fragmentos y los envía secuencialmente
        const chunks = response.split(/\n\n+/);
        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");

            const startTwilio = Date.now();
            await flowDynamic([{ body: cleanedChunk }], provider);
            const endTwilio = Date.now();
            console.log(`📤 Twilio Send Time: ${(endTwilio - startTwilio) / 1000} segundos`);
        }
    } catch (error) {
        console.error('Error en processUserMessage:', error);
        throw error; // Relanza el error para manejarlo en el webhook
    }
};

/**
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) {
        return; // Si está bloqueado, omitir procesamiento
    }

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

    userLocks.delete(userId); // Eliminar bloqueo una vez procesados todos los mensajes
    userQueues.delete(userId); // Eliminar la cola cuando se procesen todos los mensajes
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 */
const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from; // Identificador único por usuario

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        // Si este es el único mensaje en la cola, procesarlo inmediatamente
        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });

/**
 * Función principal que configura e inicia el bot
 */
const main = async () => {
    // Verifica que las credenciales de Twilio estén configuradas
    if (!process.env.ACCOUNT_SID || !process.env.AUTH_TOKEN || !process.env.VENDOR_NUMBER) {
        throw new Error('Las credenciales de Twilio no están configuradas correctamente.');
    }

    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });

    const startDB = Date.now();
    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,         // Host proporcionado por Railway
        user: process.env.POSTGRES_DB_USER,         // Usuario proporcionado por Railway
        password: process.env.POSTGRES_DB_PASSWORD, // Contraseña proporcionada por Railway
        database: process.env.POSTGRES_DB_NAME,     // Nombre de la base de datos
        port: Number(process.env.POSTGRES_DB_PORT)
    });
    const endDB = Date.now();
    console.log(`🗄️ PostgreSQL Query Time: ${(endDB - startDB) / 1000} segundos`);

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Crear una instancia de Express
    const app = express();

    // Configura el middleware para manejar application/x-www-form-urlencoded y application/json
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());

    // Webhook para manejar las solicitudes de Twilio
    app.post('/webhook', async (req, res) => {
        try {
            console.log('Headers:', req.headers);
            console.log('Body:', req.body);

            let body = req.body;

            // Si el cuerpo es un JSON, accede a la propiedad "body"
            if (body && body.body) {
                body = body.body;
            }

            const message = body.Body || body.body;
            const from = body.From || body.from;
            const to = body.To || body.to;

            console.log(`Mensaje recibido: ${message} de ${from} a ${to}`);

            // Crear un objeto state personalizado
            const state = createState();

            // Implementación de flowDynamic
            const flowDynamic = async (messages, provider) => {
                for (const msg of messages) {
                    await provider.sendMessage(from, msg.body);
                }
            };

            // Procesa el mensaje
            await processUserMessage({ body: message, from, to }, { flowDynamic, state, provider: adapterProvider });

            // Responde solo con un mensaje de éxito (no incluyas el JSON)
            res.status(200).send('Mensaje recibido');
        } catch (error) {
            console.error('Error en el webhook:', error);
            res.status(500).send('Error interno del servidor');
        }
    });

    // Iniciar el servidor
    app.listen(PORT, () => {
        console.log(`Servidor escuchando en el puerto ${PORT}`);
    });

    httpInject(adapterProvider.server);
};

main();