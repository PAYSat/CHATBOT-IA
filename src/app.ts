import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { createBot, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import http from "http";

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map();
const userStates = new Map(); // Mapa para almacenar estados para cada usuario

// Crear instancia de Express
const app = express();
app.use(express.urlencoded({ extended: false }));

// Configurar proveedor de Twilio
const adapterProvider = new TwilioProvider({
    accountSid: process.env.ACCOUNT_SID,
    authToken: process.env.AUTH_TOKEN,
    vendorNumber: process.env.VENDOR_NUMBER,
});

// Configurar flujo de bienvenida
const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;

    if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
    }
    
    if (!userStates.has(userId)) {
        userStates.set(userId, state); // Almacenar el objeto state para este usuario
    }

    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });

    if (!userLocks.get(userId) && queue.length === 1) {
        await handleQueue(userId);
    }
});

// Procesar mensajes de usuario
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    try {
        await typing(ctx, provider);
        
        // Asegurarse de que tenemos un objeto state válido
        if (!state) {
            // Crear un nuevo objeto tipo state si no existe
            state = {
                get: (key) => {
                    const userData = userStates.get(ctx.from) || {};
                    return userData[key] || null;
                },
                set: (key, value) => {
                    const userData = userStates.get(ctx.from) || {};
                    userData[key] = value;
                    userStates.set(ctx.from, userData);
                    return value;
                }
            };
        }
        
        const startOpenAI = Date.now();
        const response = await toAsk(ASSISTANT_ID, ctx.body, state);
        const endOpenAI = Date.now();
        console.log(`⏳ Tiempo de respuesta OpenAI: ${(endOpenAI - startOpenAI) / 1000} segundos`);

        // Dividir respuesta en fragmentos y enviar secuencialmente
        const chunks = response.split(/\n\n+/);
        let fullResponse = "";
        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
            fullResponse += cleanedChunk + "\n\n";
        }

        return fullResponse.trim();
    } catch (error) {
        console.error("Error en processUserMessage:", error);
        return "Lo siento, ocurrió un error al procesar tu mensaje.";
    }
};

// Manejar cola de mensajes
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    if (userLocks.get(userId)) return;

    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);

    while (queue.length > 0) {
        userLocks.set(userId, true); // Bloquear la cola
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            const response = await processUserMessage(ctx, { flowDynamic, state, provider });
            if (response && flowDynamic) {
                await flowDynamic(response);
            }
        } catch (error) {
            console.error(`Error procesando mensaje para usuario ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Liberar el bloqueo
        }
    }
    userLocks.delete(userId);
    userQueues.delete(userId);
};

// Ruta para el webhook de Twilio
app.post("/webhook", async (req, res) => {
    // Observamos que estamos recibiendo dos solicitudes para cada mensaje
    // Vamos a filtrar la solicitud vacía
    if (!req.body.Body || !req.body.From) {
        console.log("Recibida solicitud sin cuerpo o remitente, ignorando");
        return res.status(200).send('OK');
    }

    const incomingMessage = req.body.Body;
    const senderNumber = req.body.From;
    console.log(`📩 Mensaje recibido de ${senderNumber}: ${incomingMessage}`);

    // Responder de inmediato para evitar timeout
    const twiml = new twilio.twiml.MessagingResponse();
    res.type("text/xml").send(twiml.toString());

    // Obtener o crear state para este usuario
    let userState = userStates.get(senderNumber);
    if (!userState) {
        userState = {
            get: (key) => {
                const userData = userStates.get(senderNumber) || {};
                return userData[key] || null;
            },
            set: (key, value) => {
                const userData = userStates.get(senderNumber) || {};
                userData[key] = value;
                userStates.set(senderNumber, userData);
                return value;
            }
        };
        userStates.set(senderNumber, userState);
    }

    try {
        // Procesar el mensaje y enviar la respuesta de forma asíncrona
        setTimeout(async () => {
            try {
                const response = await processUserMessage(
                    { body: incomingMessage, from: senderNumber }, 
                    { flowDynamic: null, state: userState, provider: adapterProvider }
                );

                // Enviar la respuesta al usuario
                if (response) {
                    await adapterProvider.sendMessage(senderNumber, response);
                }
            } catch (error) {
                console.error("Error procesando mensaje en webhook:", error);
                await adapterProvider.sendMessage(senderNumber, "Lo siento, ocurrió un error al procesar tu mensaje.");
            }
        }, 100); // Pequeño retraso para asegurarnos de que la respuesta HTTP ya fue enviada
    } catch (error) {
        console.error("Error en manejador de webhook:", error);
    }
});

// Otras rutas personalizadas
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
        app(req, res); // Pasar solicitudes a la aplicación Express
    });

    // Iniciar el servidor
    server.listen(PORT, () => {
        console.log(`🚀 Servidor WhatsApp ejecutándose en el puerto ${PORT}`);
    });
};

main();