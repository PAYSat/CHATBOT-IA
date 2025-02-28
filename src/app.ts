import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { PostgreSQLAdapter } from "@builderbot/database-postgres";
import { TwilioProvider } from "@builderbot/provider-twilio";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map();

// Implementación simple del estado para cumplir con la interfaz BotStateStandAlone
class SimpleState {
    private state: Record<string, any>;
    
    constructor() {
        this.state = {};
    }
    
    update(key: string, value: any) {
        this.state[key] = value;
    }
    
    getMyState() {
        return this.state;
    }
    
    get(key: string) {
        return this.state[key];
    }
    
    clear() {
        this.state = {};
    }
}

// Crear cliente de Twilio para enviar mensajes directamente
const twilioClient = twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Middleware para loguear solicitudes
app.use((req, res, next) => {
  console.log(`📥 Solicitud recibida: ${req.method} ${req.path}`);
  if (req.body) {
    console.log("📦 Cuerpo de la solicitud:", JSON.stringify(req.body).substring(0, 500));
  }
  next();
});

/**
 * Webhook de Twilio - devuelve un XML vacío y procesa el mensaje de forma asincrónica
 */
app.post("/webhook", async (req, res) => {
    // Paso 1: Devolver inmediatamente un XML vacío
    const twiml = new twilio.twiml.MessagingResponse();
    res.type("text/xml").send(twiml.toString());
    
    try {
        // Paso 2: Extraer datos
        // Si el cuerpo viene anidado, obtener la versión correcta
        const requestData = req.body && req.body.body ? req.body.body : req.body;
        
        const mensajeEntrante = requestData.Body || "";
        const numeroRemitente = requestData.From || "";
        
        console.log(`📩 Mensaje recibido de ${numeroRemitente}: ${mensajeEntrante}`);
        
        if (!numeroRemitente || !mensajeEntrante) {
            console.log("⚠️ Datos incompletos en la solicitud");
            return;
        }
        
        // Paso 3: Crear un contexto para el mensaje
        const ctx = {
            from: numeroRemitente,
            body: mensajeEntrante
        };
        
        // Paso 4: Crear una función para enviar respuestas
        const sendDirectMessage = async (text) => {
            try {
                await twilioClient.messages.create({
                    body: text,
                    from: `whatsapp:${process.env.VENDOR_NUMBER}`,
                    to: numeroRemitente
                });
                return true;
            } catch (error) {
                console.error("❌ Error enviando mensaje con Twilio:", error);
                return false;
            }
        };
        
        // Paso 5: Agregar el mensaje a la cola del usuario
        if (!userQueues.has(numeroRemitente)) {
            userQueues.set(numeroRemitente, []);
            userLocks.set(numeroRemitente, false);
            console.log(`🆕 Nueva cola creada para ${numeroRemitente}`);
        }
        
        const queue = userQueues.get(numeroRemitente);
        queue.push({ 
            ctx, 
            sendMessage: sendDirectMessage
        });
        console.log(`➕ Mensaje añadido a la cola de ${numeroRemitente}, total: ${queue.length}`);
        
        // Paso 6: Procesar la cola si no hay otros mensajes en procesamiento
        if (!userLocks.get(numeroRemitente) && queue.length === 1) {
            console.log(`🔄 Iniciando procesamiento de cola para ${numeroRemitente}`);
            await handleQueue(numeroRemitente);
        }
    } catch (error) {
        console.error("❌ Error procesando mensaje:", error);
    }
});

/**
 * Procesa el mensaje del usuario y envía la respuesta.
 */
const processUserMessage = async (ctx, sendMessage) => {
    console.log(`🧠 Procesando mensaje de ${ctx.from}: "${ctx.body}"`);
    
    try {
        // Crear un objeto de estado que cumpla con la interfaz BotStateStandAlone
        const botState = new SimpleState();
        
        const startOpenAI = Date.now();
        const response = await toAsk(ASSISTANT_ID, ctx.body, botState);
        const endOpenAI = Date.now();
        console.log(`⏳ OpenAI Response Time: ${(endOpenAI - startOpenAI) / 1000} segundos`);

        // Divide la respuesta en fragmentos y los envía secuencialmente
        const chunks = response.split(/\n\n+/);
        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
            
            const startTwilio = Date.now();
            await sendMessage(cleanedChunk);
            const endTwilio = Date.now();
            
            console.log(`📤 Mensaje enviado: "${cleanedChunk.substring(0, 50)}..."`);
            console.log(`📤 Twilio Send Time: ${(endTwilio - startTwilio) / 1000} segundos`);
        }
        return true;
    } catch (error) {
        console.error("❌ Error procesando mensaje:", error);
        return false;
    }
};

/**
 * Maneja la cola de mensajes para cada usuario.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    
    if (userLocks.get(userId)) {
        console.log(`🔒 Cola bloqueada para ${userId}, omitiendo procesamiento`);
        return;
    }
    
    console.log(`📩 Mensajes en la cola de ${userId}:`, queue.length);
    
    while (queue.length > 0) {
        userLocks.set(userId, true);
        console.log(`🔒 Bloqueando cola para ${userId}`);
        
        const { ctx, sendMessage } = queue.shift();
        
        try {
            console.log(`🔄 Procesando mensaje de la cola para ${userId}`);
            await processUserMessage(ctx, sendMessage);
        } catch (error) {
            console.error(`❌ Error procesando mensaje para el usuario ${userId}:`, error);
        } finally {
            userLocks.set(userId, false);
            console.log(`🔓 Liberando bloqueo para ${userId}`);
        }
    }

    userLocks.delete(userId);
    userQueues.delete(userId);
    console.log(`🧹 Cola eliminada para ${userId}`);
};

/**
 * Función principal que configura e inicia el servidor.
 */
const main = async () => {
    console.log("⚙️ Configurando el servidor");
    
    // Inicializar BuilderBot, pero solo para la parte de base de datos
    const adapterFlow = createFlow([]);  // Sin flujos definidos
    
    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        password: process.env.POSTGRES_DB_PASSWORD,
        database: process.env.POSTGRES_DB_NAME,
        port: Number(process.env.POSTGRES_DB_PORT),
    });
    console.log("✅ Conexión a base de datos establecida");
    
    // Configuramos el proveedor pero NO lo usamos para recibir mensajes
    const adapterProvider = createProvider(TwilioProvider, {
        accountSid: process.env.ACCOUNT_SID,
        authToken: process.env.AUTH_TOKEN,
        vendorNumber: process.env.VENDOR_NUMBER,
    });
    
    // Crear el bot e integrar Express
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });
    console.log("✅ Bot creado correctamente");

    // Inyectar Express dentro del servidor de BuilderBot
    console.log("💉 Preparando inyección de Express");
    httpInject(app);
    console.log("✅ Express inyectado en el servidor BuilderBot");

    // Iniciar el servidor HTTP en el puerto definido
    httpServer(+PORT);
    console.log(`🌐 Servidor escuchando en el puerto ${PORT}`);
    
    // Configurar manejo de errores
    process.on('uncaughtException', (error) => {
        console.error('❌ Error no capturado:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Promesa rechazada no manejada:', reason);
    });
};

// Iniciar el servidor
console.log("🏁 Iniciando servidor...");
main().catch(error => {
    console.error("❌ Error al iniciar el servidor:", error);
});