import "dotenv/config"; // Cargar variables de entorno desde .env


import { startExpressService } from "./services/expressService";
import { startBuilderBotService } from "./services/builderBotService";

const PORT = process.env.PORT ?? 3008;

// Iniciar el servicio de BuilderBot
startBuilderBotService();

// Iniciar el servicio de Express (que incluye las rutas de BuilderBot)
startExpressService(+PORT);