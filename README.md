# Bot de Asistente IA para WhatsApp (BuilderBot.app)

<p align="center">
  <img src="https://builderbot.vercel.app/assets/thumbnail-vector.png" height="80">
</p>

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/6VbbLI?referralCode=jyd_0y)

Este proyecto crea un bot de WhatsApp que integra un asistente de IA mediante la **librería BuilderBot**.  
Se basa en el repositorio oficial de ejemplo <https://github.com/leifermendez/builderbot-openai-assistants> y utiliza:

* **Twilio** como proveedor de WhatsApp  
* **PostgreSQL** como base de datos  
* **OpenAI** Assistant para las respuestas de IA  

> **Revisa siempre** las versiones declaradas en `package.json` y compáralas con las últimas librerías oficiales de BuilderBot (<https://www.builderbot.app/es>) para evitar cambios incompatibles.

## Características
- Flujos de conversación automatizados para WhatsApp  
- Integración con OpenAI Assistant  
- Proveedor de WhatsApp configurable (por defecto Twilio)  
- Registro de interacciones en PostgreSQL  
- Respuestas automáticas a preguntas frecuentes  
- Mensajería en tiempo real  
- Ampliable mediante *triggers* y nuevos flujos

## Primeros pasos
1. Clona el repositorio  
   `git clone https://github.com/tu-usuario/whatsapp-ai-assistant-bot.git`  
   `cd whatsapp-ai-assistant-bot`
2. Instala dependencias  
   `pnpm install`
3. Crea un archivo `.env` con tus variables:
       PORT=3008

       # OpenAI
       OPENAI_API_KEY=tu_clave_openai
       ASSISTANT_ID=tu_assistant_id

       # Twilio
       TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
       TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
       TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

       # PostgreSQL
       DATABASE_URL=postgresql://usuario:password@host:5432/bd
4. Inicia el servidor de desarrollo  
   `pnpm run dev`

## Docker (opcional)
* Construir imagen  
  `docker build -t whatsapp-ai-assistant .`
* Ejecutar contenedor  
  `docker run -p 3008:3008 --env-file .env whatsapp-ai-assistant`

## Uso
Toda la lógica del bot se encuentra en `src/app.ts`, donde se definen los flujos BuilderBot y la conexión con OpenAI Assistant.

## Documentación
Documentación oficial: <https://builderbot.vercel.app/>

## Contribuciones
Se aceptan *pull requests*. Haz *fork*, crea una rama y envía tu PR.

## Licencia
MIT

## Contacto
Discord → <https://link.codigoencasa.com/DISCORD>  
Twitter → <https://twitter.com/leifermendez>

Construido con ❤️ y BuilderBot – Potenciando la IA conversacional en WhatsApp.
