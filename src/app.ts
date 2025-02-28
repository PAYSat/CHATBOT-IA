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
const userStates = new Map(); // Add a map to store states for each user

// Create Express instance
const app = express();
app.use(express.urlencoded({ extended: false }));

// Configure Twilio provider
const adapterProvider = new TwilioProvider({
    accountSid: process.env.ACCOUNT_SID,
    authToken: process.env.AUTH_TOKEN,
    vendorNumber: process.env.VENDOR_NUMBER,
});

// Configure welcome flow
const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;

    if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
    }
    
    if (!userStates.has(userId)) {
        userStates.set(userId, state); // Store the state object for this user
    }

    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });

    if (!userLocks.get(userId) && queue.length === 1) {
        await handleQueue(userId);
    }
});

// Process user messages
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    
    // Make sure we have a valid state object
    if (!state) {
        // Create a new state-like object if none exists
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
    console.log(`⏳ OpenAI Response Time: ${(endOpenAI - startOpenAI) / 1000} seconds`);

    // Split response into chunks and send sequentially
    const chunks = response.split(/\n\n+/);
    let fullResponse = "";
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
        fullResponse += cleanedChunk + "\n\n";
    }

    return fullResponse.trim();
};

// Handle message queue
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    if (userLocks.get(userId)) return;

    console.log(`📩 Messages in ${userId}'s queue:`, queue.length);

    while (queue.length > 0) {
        userLocks.set(userId, true); // Lock the queue
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            const response = await processUserMessage(ctx, { flowDynamic, state, provider });
            if (response && flowDynamic) {
                await flowDynamic(response);
            }
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Release the lock
        }
    }
    userLocks.delete(userId);
    userQueues.delete(userId);
};

// Custom route for Twilio webhook
app.post("/webhook", async (req, res) => {
    const twiml = new twilio.twiml.MessagingResponse();
    const incomingMessage = req.body.Body;
    const senderNumber = req.body.From;

    console.log(`📩 Message received from ${senderNumber}: ${incomingMessage}`);

    res.type("text/xml").send(twiml.toString());

    // Get or create state for this user
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
        // Process the message and send the response
        const response = await processUserMessage(
            { body: incomingMessage, from: senderNumber }, 
            { flowDynamic: null, state: userState, provider: adapterProvider }
        );

        // Send the response to the user
        if (response) {
            await adapterProvider.sendMessage(senderNumber, response);
        }
    } catch (error) {
        console.error("Error in webhook handler:", error);
        await adapterProvider.sendMessage(senderNumber, "Sorry, I encountered an error processing your message.");
    }
});

// Other custom routes
app.get("/status", (req, res) => {
    res.send("Server is running 🚀");
});

// Main function
const main = async () => {
    const adapterFlow = createFlow([welcomeFlow]);

    const adapterDB = new PostgreSQLAdapter({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        password: process.env.POSTGRES_DB_PASSWORD,
        database: process.env.POSTGRES_DB_NAME,
        port: Number(process.env.POSTGRES_DB_PORT),
    });

    // Create the bot and get the httpServer
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Create an HTTP server manually
    const server = http.createServer(app);

    // Integrate the HTTP server from createBot with Express
    server.on("request", (req, res) => {
        app(req, res); // Pass requests to the Express application
    });

    // Start the server
    server.listen(PORT, () => {
        console.log(`🚀 WhatsApp server running on port ${PORT}`);
    });
};

main();