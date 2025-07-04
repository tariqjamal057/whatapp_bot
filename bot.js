import pkg from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
} = pkg;

import * as fs from "fs";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import qrcode from "qrcode-terminal";
import pino from "pino";
import path from "path";
import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const logger = pino({
  level: "silent",
});

// load response messages
let response;
try {
  response = JSON.parse(fs.readFileSync("./response.json", "utf8"));
} catch (error) {
  console.error("Error al cargar response.json:", error);
  process.exit(1);
}

// Load countries data
let countriesData;
try {
  countriesData = JSON.parse(fs.readFileSync("./data/countries.json", "utf8"));
} catch (error) {
  console.error("❌ Error cargando countries.json:", error);
  process.exit(1);
}

// Load session states
let sessionStatesData;
try {
  sessionStatesData = JSON.parse(
    fs.readFileSync("./data/session-states.json", "utf8")
  );
} catch (error) {
  console.error("❌ Error cargando session-states.json:", error);
  process.exit(1);
}

let qrGenerationTime = null;
let qrRegenerationInterval = null;
let currentQRCode = null;
let qrExpirationTimeout = null;
let qrGenerated = false;
const QR_VALIDITY_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const QR_REFRESH_INTERVAL = 10 * 60 * 1000; // Check every 10 minutes

// Load daily rates based on current date
function loadDailyRates() {
  const today = new Date().toISOString().split("T")[0];
  const ratesFile = `./rates/${today}.json`;

  try {
    if (fs.existsSync(ratesFile)) {
      const rates = JSON.parse(fs.readFileSync(ratesFile, "utf8"));
      console.log(`✅ Tasas del día ${today} cargadas exitosamente`);
      return rates;
    } else {
      console.warn(
        `⚠️ Archivo de tasas para ${today} no encontrado. Usando tasas por defecto.`
      );
      return {
        date: today,
        dominican: {
          range1: { min: 0, max: 2000, rate: 2.11944 },
          range2: { min: 2001, max: 10000, rate: 2.11991 },
          range3: { min: 10001, max: 20000, rate: 2.12061 },
          range4: { min: 20001, max: 9999999, rate: 2.12085 },
        },
        peru: 35.13,
        ecuador: 128.22,
        colombia: 31.038,
        chile: 0.136,
      };
    }
  } catch (error) {
    console.error(`❌ Error cargando tasas del día ${today}:`, error);
    throw error;
  }
}

let dailyRates = loadDailyRates();

// OpenAI Setup with error handling
let openai;
try {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY no encontrada en variables de entorno");
  }
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log("✅ OpenAI inicializado exitosamente");
} catch (error) {
  console.error("❌ Error inicializando OpenAI:", error);
  process.exit(1);
}

// LowDB - Fixed initialization with default data
const defaultData = { users: {}, logs: [], userSessions: {} };
const adapter = new JSONFile("db.json");
const db = new Low(adapter, defaultData);

// Initialize database properly
async function initializeDatabase() {
  try {
    await db.read();

    if (!db.data) {
      db.data = defaultData;
    }
    if (!db.data.users) {
      db.data.users = {};
    }
    if (!db.data.logs) {
      db.data.logs = [];
    }
    if (!db.data.userSessions) {
      db.data.userSessions = {};
    }

    await db.write();
    console.log("✅ Base de datos inicializada correctamente");
  } catch (error) {
    console.error("❌ Error inicializando base de datos:", error);
    process.exit(1);
  }
}

await initializeDatabase();

let sock;
let shouldReconnect = true;

// Extract data from loaded files
const countries = countriesData.countries;
const countryDisplayNames = countriesData.displayNames;
const SESSION_STATES = sessionStatesData.SESSION_STATES;



async function detectIntentWithOpenAI(messageText, userSession) {
  try {
    const systemPrompt = `You are an AI assistant for Tecno Inversiones, a money transfer service to Venezuela.

ANALYZE the user's message and respond with a JSON object containing:
{
  "intent": "primary_intent",
  "confidence": 0.0-1.0,
  "entities": {
    "amount": number_or_null,
    "currency": "USD|DOP|PEN|COP|CLP|unknown",
    "country": "dominican|peru|ecuador|colombia|chile|unknown",
    "transfer_type": "bank_transfer|cash_deposit|physical_delivery|unknown"
  },
  "context": "brief_context_summary",
  "requires_human": boolean,
  "user_emotion": "neutral|frustrated|urgent|confused",
  "auto_transfer_type": {
    "detected": boolean,
    "type": "bank_transfer|cash_deposit|physical_delivery",
    "keywords": ["matched_keywords"],
    "confidence": 0.0-1.0
  }
}

INTENTS:
- send_money: wants to transfer money (default: bank_transfer unless specified)
- physical_delivery: wants physical dollar delivery in Venezuela
- cash_deposit: wants to deposit cash for transfer
- check_rate: wants exchange rates
- human_agent: wants human help
- greeting: hello/hi messages
- complaint: problems/issues
- account_confirmation: confirming account ownership
- beneficiary_info: providing recipient details
- receipt_submission: sending payment proof

AUTOMATIC TRANSFER TYPE DETECTION:
1. PHYSICAL DELIVERY keywords: "cash", "efectivo", "physical dollars", "dólares físicos", "delivery", "entrega física", "physical", "físico", "en persona", "cash delivery", "entregar efectivo", "dollars at home", "dólares a domicilio", "en mano", "dollars in hand"

2. CASH DEPOSIT keywords: "depósito", "deposit", "depositar", "efectivo", "cash deposit", "deposito en efectivo", "depositar efectivo"

3. BANK TRANSFER keywords (default): "transferencia", "bank transfer", "transferir", "enviar dinero", "mandar dinero", "send money", "transfer money", "online transfer"

DEFAULT BEHAVIOR:
- If no specific keywords detected, assume "bank_transfer"
- Physical delivery has highest priority if detected
- Cash deposit has medium priority
- Bank transfer is default/fallback

CURRENT SESSION:
State: ${userSession.state}
Data: ${JSON.stringify(userSession.data || {})}

USER MESSAGE: "${messageText}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageText },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });

    const response = completion.choices[0].message.content;
    console.log("🤖 OpenAI Raw Response:", response);

    const parsed = JSON.parse(response);
    console.log("🎯 Intent Detected:", parsed);

    return parsed;
  } catch (error) {
    console.error("❌ Error with OpenAI intent detection:", error);
    return {
      intent: "unknown",
      confidence: 0.1,
      entities: {},
      context: "error_occurred",
      requires_human: false,
      user_emotion: "neutral",
      auto_transfer_type: {
        detected: false,
        type: "bank_transfer",
        keywords: [],
        confidence: 0.0
      }
    };
  }
}



// Generate Contextual AI Response
async function generateContextualResponse(
  messageText,
  userSession,
  detectedIntent
) {
  try {
    const systemPrompt = `You are a helpful assistant for Tecno Inversiones money transfer service.

CONTEXT:
- Current session state: ${userSession.state}
- User data: ${JSON.stringify(userSession.data || {})}
- Detected intent: ${JSON.stringify(detectedIntent)}
- Available countries: Dominican Republic, Peru, Ecuador, Colombia, Chile
- Service: Money transfers to Venezuela
- Physical delivery available: YES (10% fee, 24-48 hours)
- Current context: ${
      userSession.data.physicalDelivery ? "PHYSICAL DELIVERY" : "BANK TRANSFER"
    }


DELIVERY OPTIONS:
1. Bank Transfer (Bolívares): Uses daily exchange rates, immediate delivery
2. Physical Delivery (USD): 10% fixed fee, 24-48 hours, cash dollars in hand

RULES:
1. Respond in Spanish naturally and conversationally
2. Use appropriate emojis
3. Be helpful and guide the user to next steps
4. If user seems frustrated, offer human assistance
5. Always acknowledge what they said before responding
6. For amounts, always clarify the currency if unclear
7. Don't repeat the same question if user already answered
8. If discussing physical delivery, mention the 10% fee and delivery time
9. If discussing bank transfer

DAILY RATES AVAILABLE:
${JSON.stringify(dailyRates)}

PHYSICAL DELIVERY CONTEXT:
- Fixed 10% commission for logistics
- 24-48 hour delivery time
- Requires: Name, ID, Phone, Address
- Secure transport included
- Cash dollars delivered in person

Generate a natural, helpful response to: "${messageText}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageText },
      ],
      temperature: 0.7,
      max_tokens: 600,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("❌ Error generating contextual response:", error);
    return null;
  }
}

// Add new function to handle delivery comparisons (continued)
async function handleDeliveryComparison(messageText, userSession) {
  const amountInfo = intelligentAmountExtraction(messageText);
  const countryInfo = intelligentCountryDetection(messageText);

  let comparisonMessage = "💰 **Comparación de Opciones de Entrega:**\n\n";

  if (amountInfo && countryInfo) {
    const country = countryInfo.country;
    let amount = amountInfo.amount;

    // Convert to local currency if needed
    if (amountInfo.currency === "USD" && country !== "ecuador") {
      amount = convertUSDToLocalCurrency(amount, country);
    }

    // Calculate bank transfer
    const rateInfo = calculateRate(amount, country);

    // Calculate physical delivery
    const physicalCalc = calculatePhysicalDeliveryEnhanced(
      amount,
      country,
      false
    );

    if (!rateInfo.error && physicalCalc.success) {
      comparisonMessage += `📊 **Para ${formatCurrency(
        amount,
        country
      )} desde ${getCountryDisplayName(country)}:**\n\n`;

      comparisonMessage += `1️⃣ **Transferencia Bancaria (Bolívares)**\n`;
      comparisonMessage += `   💰 Recibirá: ${rateInfo.receivedAmount} Bs\n`;
      comparisonMessage += `   📈 Tasa: ${rateInfo.rate} Bs\n`;
      comparisonMessage += `   ⚡ Tiempo: Inmediato\n`;
      comparisonMessage += `   🏦 Requiere: Cuenta bancaria\n\n`;

      comparisonMessage += `2️⃣ **Entrega Física (Dólares USD)**\n`;
      comparisonMessage += `   💵 Recibirá: $${physicalCalc.amountToReceive} USD\n`;
      comparisonMessage += `   💸 Comisión: $${physicalCalc.feeAmount} USD (10%)\n`;
      comparisonMessage += `   🚚 Tiempo: 24-48 horas\n`;
      comparisonMessage += `   📍 Requiere: Dirección de entrega\n\n`;

      comparisonMessage += `¿Cuál opción prefieres? Responde 1 o 2.`;

      return {
        message: comparisonMessage,
        intent: "delivery_comparison_calculated",
        newState: SESSION_STATES.AWAITING_TRANSFER_TYPE,
        sessionData: {
          amount: amount,
          country: country,
          rateInfo: rateInfo,
          physicalCalc: physicalCalc,
          comparisonShown: true,
        },
      };
    }
  }

  // Generic comparison without specific amounts
  comparisonMessage += `1️⃣ **Transferencia Bancaria (Bolívares)**\n`;
  comparisonMessage += `   📈 Tasa del día aplicable\n`;
  comparisonMessage += `   ⚡ Entrega inmediata\n`;
  comparisonMessage += `   🏦 Directo a cuenta bancaria\n`;
  comparisonMessage += `   💳 Sin comisiones adicionales\n\n`;

  comparisonMessage += `2️⃣ **Entrega Física (Dólares USD)**\n`;
  comparisonMessage += `   🔒 Comisión fija: 10%\n`;
  comparisonMessage += `   💵 Dólares físicos en mano\n`;
  comparisonMessage += `   🚚 Entrega en 24-48 horas\n`;
  comparisonMessage += `   📍 Entrega a domicilio\n`;
  comparisonMessage += `   🛡️ Transporte asegurado\n\n`;

  comparisonMessage += `Para un cálculo exacto, dime el monto y país.\nEjemplo: "5000 pesos desde República Dominicana"`;

  return {
    message: comparisonMessage,
    intent: "delivery_comparison_generic",
    newState: SESSION_STATES.AWAITING_COUNTRY,
  };
}

// Intelligent Amount and Currency Detection
// Replace the existing intelligentAmountExtraction function
function intelligentAmountExtraction(messageText) {
  const text = messageText.toLowerCase().replace(/,/g, "");

  // Enhanced currency patterns
  const patterns = {
    usd: [
      /\$(\d+(?:\.\d{2})?)/i,
      /(\d+(?:\.\d{2})?)\s*(?:usd|dollars?|dólares?)/i,
      /(\d+(?:\.\d{2})?)\s*(?:dollar|dólar)/i,
    ],
    peru: [
      /(\d+(?:\.\d{2})?)\s*(?:soles?|pen|sol)/i,
      /(\d+(?:\.\d{2})?)\s*pesos?\s*(?:peru|peruano)/i, // This should map to soles
    ],
    dominican: [
      /rd\$?(\d+(?:\.\d{2})?)/i,
      /(\d+(?:\.\d{2})?)\s*(?:pesos?\s*dominican|rd)/i,
    ],
    colombia: [
      /(\d+(?:\.\d{2})?)\s*(?:cop|pesos?\s*colombian)/i,
      /(\d+(?:\.\d{2})?)\s*pesos?\s*colombian/i,
    ],
    chile: [
      /(\d+(?:\.\d{2})?)\s*(?:clp|pesos?\s*chilen)/i,
      /(\d+(?:\.\d{2})?)\s*pesos?\s*chilen/i,
    ],
  };

  // Check each currency pattern
  for (const [currency, patternList] of Object.entries(patterns)) {
    for (const pattern of patternList) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        if (!isNaN(amount) && amount > 0) {
          return {
            amount,
            currency: currency.toUpperCase(),
            confidence: 0.9,
            originalText: match[0],
          };
        }
      }
    }
  }

  // Generic number extraction with higher confidence for context
  const genericMatch = text.match(/(\d+(?:,\d{3})*(?:\.\d{2})?)/);
  if (genericMatch) {
    const amount = parseFloat(genericMatch[1].replace(/,/g, ""));
    if (!isNaN(amount) && amount > 0) {
      return {
        amount,
        currency: "UNKNOWN",
        confidence: 0.7, // Increased confidence
        originalText: genericMatch[0],
      };
    }
  }

  return null;
}

// Enhanced Country Detection
function intelligentCountryDetection(messageText) {
  const text = messageText.toLowerCase();

  const countryPatterns = {
    dominican: [
      "dominican",
      "república dominicana",
      "rd",
      "santo domingo",
      "dominicana",
      "rep dom",
      "rep. dom",
      "dominican republic",
      "republica dominicana", // Added without accent
    ],
    peru: ["peru", "perú", "lima", "peruano", "peruana"],
    ecuador: ["ecuador", "quito", "ecuatoriano", "ecuatoriana"],
    colombia: ["colombia", "bogotá", "bogota", "colombiano", "colombiana"],
    chile: ["chile", "santiago", "chileno", "chilena"],
  };

  for (const [country, patterns] of Object.entries(countryPatterns)) {
    for (const pattern of patterns) {
      if (text.includes(pattern)) {
        return {
          country,
          confidence: 0.9,
          matchedPattern: pattern,
        };
      }
    }
  }

  return null;
}


// Inside MultipleFiles/bot.js

async function handleDirectPatterns(messageText, userSession) {
  const text = messageText.toLowerCase().trim();
  const currentState = userSession.state;

  const physicalKeywords = [
    "dólares físicos",
    "physical dollars",
    "efectivo",
    "cash delivery",
    "entrega en efectivo",
    "dólares en mano",
    "dollars in hand",
    "entrega física",
    "physical delivery",
    "cash",
    "entregar efectivo",
  ];

  const digitalKeywords = [
    "enviar dinero",
    "transferir",
    "mandar dinero",
    "send money",
    "transfer",
    "digital",
    "online",
  ];

  const hasPhysicalKeyword = physicalKeywords.some((keyword) =>
    text.includes(keyword)
  );

  const hasDigitalKeyword = digitalKeywords.some((keyword) =>
    text.includes(keyword)
  );

  // Handle menu selections (1, 2, 3) when awaiting transfer type
  if (currentState === SESSION_STATES.AWAITING_TRANSFER_TYPE) {
    if (text === "1" || text === "2" || text === "3") {
      return handleTransferTypeOriginal(messageText, userSession);
    }
  }

  // If digital keyword is detected and we are in INITIAL state,
  // directly proceed to handle digital transfer.
  if (hasDigitalKeyword && currentState === SESSION_STATES.INITIAL) {
    return {
      message: "¡Perfecto! 🙌 Te ayudo a enviar dinero a Venezuela.\n\n¿Desde qué país estás enviando y cuál es el monto aproximado?\n\nEjemplo: 'Desde República Dominicana, 5000 pesos' o 'Desde Perú, $300 USD'",
      newState: SESSION_STATES.SEND_MONEY_STARTED,
      sessionData: { requestType: "send_money" },
    };
  }

  // If physical keyword is detected and we are in INITIAL state,
  // directly call handlePhysicalDeliveryRequest to start that flow.
  if (hasPhysicalKeyword && currentState === SESSION_STATES.INITIAL) {
    // Set physicalDelivery flag early
    userSession.data.deliveryType = "physical_dollars";
    userSession.data.physicalDelivery = true;
    userSession.data.requestType = "physical_delivery";

    // Now, let handlePhysicalDeliveryRequest manage the rest
    return await handlePhysicalDeliveryRequest(messageText, userSession, {
      wantsPhysicalDelivery: true,
      confidence: 1.0, // High confidence as keyword was found
      deliveryKeywords: physicalKeywords.filter(k => text.includes(k)),
      context: "User  explicitly requested physical delivery in initial message"
    });
  }

  // Handle country + amount in one message
  const countryInfo = intelligentCountryDetection(messageText);
  const amountInfo = intelligentAmountExtraction(messageText);

  if (
    countryInfo &&
    amountInfo &&
    (currentState === SESSION_STATES.SEND_MONEY_STARTED ||
      currentState === SESSION_STATES.INITIAL ||
      currentState === SESSION_STATES.AWAITING_COUNTRY || // Added for robustness
      currentState === SESSION_STATES.AWAITING_AMOUNT) // Added for robustness
  ) {
    // Store detected info in session data immediately
    userSession.data.country = countryInfo.country;
    userSession.data.amount = amountInfo.amount;
    userSession.data.currency = amountInfo.currency;

    // Check if user wants physical delivery based on context or previous session
    const wantsPhysical =
      hasPhysicalKeyword ||
      userSession.data.physicalDelivery ||
      userSession.data.deliveryType === "physical_dollars";

    if (wantsPhysical) {
      // If physical delivery is intended, delegate to handlePhysicalDeliveryRequest
      return await handlePhysicalDeliveryRequest(messageText, userSession, {
        wantsPhysicalDelivery: true,
        confidence: 1.0,
        deliveryKeywords: [],
        context: "Combined amount/country with physical intent"
      });
    } else {
      // Regular bank transfer calculation (existing logic)
      const country = countryInfo.country;
      let amount = amountInfo.amount;

      // Handle currency conversion if needed
      if (amountInfo.currency === "USD" && country !== "ecuador") {
        amount = convertUSDToLocalCurrency(amount, country);
      }

      const rateInfo = calculateRate(amount, country);

      if (rateInfo.error) {
        return {
          message:
            "😓 Lo siento, las tasas de hoy aún no han sido cargadas. Un asesor te ayudará con el cálculo exacto.",
          newState: SESSION_STATES.INITIAL,
        };
      }

      return {
        message: `✅ Perfecto, quieres enviar ${formatCurrency(
          amount,
          country
        )} desde ${getCountryDisplayName(
          country
        )} a Venezuela.\n\n💰 **Cálculo:**\n📊 Monto: ${formatCurrency(
          amount,
          country
        )}\n📈 Tasa: ${rateInfo.rate} Bs\n💵 El beneficiario recibirá: **${
          rateInfo.receivedAmount
        } Bs**\n\n¿Confirmas que eres el titular de la cuenta desde la cual harás la transferencia?`,
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
        sessionData: {
          amount: amount,
          country: country,
          currency: amountInfo.currency || "DOP",
          rateInfo: rateInfo,
        },
      };
    }
  }

  // Handle just country (if amount is missing)
  if (
    countryInfo &&
    (currentState === SESSION_STATES.SEND_MONEY_STARTED ||
      currentState === SESSION_STATES.AWAITING_COUNTRY)
  ) {
    // Store country in session
    userSession.data.country = countryInfo.country;

    // If physical delivery is already set, delegate to handlePhysicalDeliveryRequest
    if (userSession.data.physicalDelivery) {
        return await handlePhysicalDeliveryRequest(messageText, userSession, {
            wantsPhysicalDelivery: true,
            confidence: 1.0,
            deliveryKeywords: [],
            context: "Country provided for existing physical intent"
        });
    }

    return {
      message: `¡Excelente! Desde ${getCountryDisplayName(
        countryInfo.country
      )} 🌎\n\n💰 ¿Cuál es el monto que deseas enviar? Por favor especifica la moneda (ej: $500 USD, 10000 pesos, etc.)`,
      newState: SESSION_STATES.AWAITING_AMOUNT,
      sessionData: { country: countryInfo.country },
    };
  }

  // Handle just amount (if country is missing)
  if (
    amountInfo &&
    (currentState === SESSION_STATES.AWAITING_AMOUNT ||
      (currentState === SESSION_STATES.SEND_MONEY_STARTED &&
        userSession.data.country))
  ) {
    // Store amount and currency in session
    userSession.data.amount = amountInfo.amount;
    userSession.data.currency = amountInfo.currency;

    const country = userSession.data.country; // Get country from session

    if (country) { // If country is now available from session
      // If physical delivery is already set, delegate to handlePhysicalDeliveryRequest
      if (userSession.data.physicalDelivery) {
          return await handlePhysicalDeliveryRequest(messageText, userSession, {
              wantsPhysicalDelivery: true,
              confidence: 1.0,
              deliveryKeywords: [],
              context: "Amount provided for existing physical intent with country in session"
          });
      }

      // Existing bank transfer logic if not physical delivery
      let amount = amountInfo.amount;

      // Handle currency conversion if needed
      if (amountInfo.currency === "USD" && country !== "ecuador") {
        amount = convertUSDToLocalCurrency(amount, country);
      }

      const rateInfo = calculateRate(amount, country);

      if (rateInfo.error) {
        return {
          message:
            "😓 Lo siento, las tasas de hoy aún no han sido cargadas. Un asesor te ayudará con el cálculo exacto.",
          newState: SESSION_STATES.INITIAL,
        };
      }

      return {
        message: `✅ Perfecto, ${formatCurrency(
          amount,
          country
        )} desde ${getCountryDisplayName(
          country
        )}.\n\n💰 **Cálculo:**\n📊 Monto: ${formatCurrency(
          amount,
          country
        )}\n📈 Tasa: ${rateInfo.rate} Bs\n💵 El beneficiario recibirá: **${
          rateInfo.receivedAmount
        } Bs**\n\n¿Confirmas que eres el titular de la cuenta desde la cual harás la transferencia?`,
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
        sessionData: {
          amount: amount,
          country: country,
          currency: amountInfo.currency || "DOP",
          rateInfo: rateInfo,
        },
      };
    } else { // If country is still missing after amount is provided
        return {
            message: `Perfecto, quieres enviar ${amountInfo.amount} ${
                amountInfo.currency !== "UNKNOWN" ? amountInfo.currency : ""
            }.\n\n🌎 ¿Desde qué país estás enviando?\n\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile`,
            intent: "amount_detected_need_country",
            newState: SESSION_STATES.AWAITING_COUNTRY,
            sessionData: {
                amount: amountInfo.amount,
                currency: amountInfo.currency,
            },
        };
    }
  }

  return null; // No direct pattern matched
}



// ==================== AI-POWERED HUMAN ASSISTANCE MANAGEMENT ====================

// AI-powered detection of human assistance requests
async function detectHumanAssistanceWithAI(
  messageText,
  userSession,
  detectedIntent
) {
  try {
    const systemPrompt = `You are an AI assistant that detects when users need human assistance in a customer service context for Tecno Inversiones (money transfer service).

ANALYZE the user's message and respond with a JSON object:
{
  "needsHuman": boolean,
  "confidence": 0.0-1.0,
  "reason": "specific_reason",
  "urgency": "low|medium|high",
  "category": "technical|complaint|complex_query|frustrated|confused|escalation",
  "context": "brief_explanation"
}

DETECT HUMAN ASSISTANCE NEEDS FOR:
1. Explicit requests for human help
2. Frustration or emotional distress
3. Complex technical issues
4. Complaints or dissatisfaction
5. Repeated confusion or misunderstanding
6. Requests for supervisors/managers
7. Issues the bot cannot resolve
8. User expressing they don't understand bot responses
9. Requests for personalized attention
10. Problems with transactions or processes

CURRENT CONTEXT:
- User session state: ${userSession.state}
- Previous interactions: ${userSession.data.loopCount || 0} loops
- Bot detected intent: ${detectedIntent?.intent || "unknown"}
- User emotion: ${detectedIntent?.user_emotion || "neutral"}

USER MESSAGE: "${messageText}"

Consider the context, tone, and specific needs expressed in the message.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageText },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const response = completion.choices[0].message.content;
    console.log("🤖 AI Human Detection Response:", response);

    const parsed = JSON.parse(response);
    console.log("👨‍💼 Human Assistance Analysis:", parsed);

    return parsed;
  } catch (error) {
    console.error("❌ Error with AI human assistance detection:", error);
    // Fallback to basic detection
    return {
      needsHuman: false,
      confidence: 0.1,
      reason: "ai_error",
      urgency: "low",
      category: "technical",
      context: "AI detection failed, using fallback",
    };
  }
}

// AI-powered detection of advisor resolution messages
async function detectAdvisorResolutionWithAI(messageText) {
  try {
    const systemPrompt = `You are an AI that detects when an advisor/agent is marking a customer service issue as resolved.

ANALYZE the message and respond with JSON:
{
  "isResolution": boolean,
  "confidence": 0.0-1.0,
  "resolutionType": "issue_resolved|case_closed|problem_solved|consultation_completed|service_finished",
  "context": "brief_explanation"
}

DETECT RESOLUTION MESSAGES that indicate:
1. Issue has been resolved
2. Case is closed
3. Problem is solved
4. Consultation is complete
5. Service has been finished
6. Customer's query has been addressed

Look for phrases in Spanish or English that indicate completion or resolution.

MESSAGE: "${messageText}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageText },
      ],
      temperature: 0.1,
      max_tokens: 200,
    });

    const response = completion.choices[0].message.content;
    const parsed = JSON.parse(response);

    console.log("🔍 AI Resolution Detection:", parsed);
    return parsed;
  } catch (error) {
    console.error("❌ Error with AI resolution detection:", error);
    return {
      isResolution: false,
      confidence: 0.0,
      resolutionType: "unknown",
      context: "AI detection failed",
    };
  }
}

// Check if user is waiting for human assistance
function isUserWaitingForHuman(userSession) {
  return (
    userSession.state === SESSION_STATES.HUMAN_ASSISTANCE ||
    userSession.state === SESSION_STATES.WAITING_FOR_RESOLUTION ||
    userSession.data.botPaused === true // Assuming botPaused is a flag for human intervention
  );
}

// Enhanced human assistance transfer with AI reasoning
async function transferToHumanAssistance(
  sender,
  userSession,
  aiAnalysis,
  originalMessage
) {
  try {
    const userId = sender.split("@")[0];
    console.log(`👨‍💼 Transfiriendo usuario ${userId} a asistencia humana`);
    console.log(`📊 Análisis AI:`, aiAnalysis);

    // Update user session with AI analysis
    userSession.state = SESSION_STATES.HUMAN_ASSISTANCE; // Set to human assistance state
    userSession.data.humanTransferReason = aiAnalysis.reason;
    userSession.data.humanTransferCategory = aiAnalysis.category;
    userSession.data.humanTransferUrgency = aiAnalysis.urgency;
    userSession.data.humanTransferTime = new Date().toISOString();
    userSession.data.botPaused = true; // Crucial: pause bot replies
    userSession.data.originalMessage = originalMessage;
    userSession.data.aiAnalysis = aiAnalysis;

    // Generate personalized transfer message based on AI analysis
    let transferMessage = response.human; // Use the generic human message from response.json

    // Customize message based on category and urgency
    if (aiAnalysis.urgency === "high") {
      transferMessage =
        "🚨 Entiendo que necesitas atención urgente. Un supervisor se hará cargo de tu caso inmediatamente.\n\n🔕 El bot automático está pausado hasta que se resuelva tu consulta.";
    } else if (aiAnalysis.category === "complaint") {
      transferMessage =
        "😔 Lamento que hayas tenido una experiencia no satisfactoria. Un supervisor especializado se hará cargo de tu caso.\n\n🔕 El bot automático está pausado hasta que se resuelva tu consulta.";
    } else if (aiAnalysis.category === "complex_query") {
      transferMessage =
        "🤔 Tu consulta requiere atención especializada. Un asesor experto se hará cargo de tu caso.\n\n🔕 El bot automático está pausado hasta que se resuelva tu consulta.";
    }

    // Send confirmation message
    await sock.sendMessage(sender, { text: transferMessage });

    // Log the transfer with AI analysis
    db.data.logs.push({
      sender,
      message: originalMessage,
      action: "human_transfer_ai",
      aiAnalysis: aiAnalysis,
      timestamp: new Date().toISOString(),
      sessionState: userSession.state,
      method: "ai_detection",
    });

    // Enhanced admin notification (you might want to send this to an admin group)
    console.log(`🚨 ALERTA HUMANA - Usuario: ${userId}`);
    console.log(`📝 Razón: ${aiAnalysis.reason}`);
    console.log(`📊 Categoría: ${aiAnalysis.category}`);
    console.log(`⚡ Urgencia: ${aiAnalysis.urgency}`);
    console.log(`💬 Mensaje: ${originalMessage}`);
    console.log(`🎯 Confianza AI: ${aiAnalysis.confidence}`);

    await db.write();
    return true;
  } catch (error) {
    console.error("❌ Error transfiriendo a asistencia humana:", error);
    return false;
  }
}

// AI-powered resolution with context understanding
async function resolveHumanAssistance(
  sender,
  userSession,
  resolutionMessage = ""
) {
  try {
    const userId = sender.split("@")[0];
    console.log(`✅ Resolviendo asistencia humana para usuario ${userId}`);

    // Update user session
    const previousState = userSession.state;
    const transferData = {
      reason: userSession.data.humanTransferReason,
      category: userSession.data.humanTransferCategory,
      urgency: userSession.data.humanTransferUrgency,
      transferTime: userSession.data.humanTransferTime,
      originalMessage: userSession.data.originalMessage,
    };

    userSession.state = SESSION_STATES.INITIAL; // Reset to initial state
    userSession.data.botPaused = false; // Unpause the bot
    userSession.data.humanResolved = true;
    userSession.data.humanResolvedTime = new Date().toISOString();
    userSession.data.resolutionMessage = resolutionMessage;
    userSession.data.loopCount = 0; // Reset loop count

    // Generate personalized resolution message
    let confirmationMessage =
      "✅ Tu caso ha sido resuelto. El bot automático ha sido reactivado y está listo para ayudarte con futuras consultas.\n\n¿Hay algo más en lo que pueda asistirte?";

    if (transferData.category === "complaint") {
      confirmationMessage =
        "✅ Tu consulta y reclamo han sido atendidos por nuestro supervisor.\n\n🤖 El bot automático ha sido reactivado y está listo para ayudarte con futuras consultas.\n\n¿Hay algo más en lo que pueda asistirte?";
    } else if (transferData.urgency === "high") {
      confirmationMessage =
        "✅ Tu caso urgente ha sido resuelto por nuestro equipo especializado.\n\n🤖 El bot automático ha sido reactivado y está listo para ayudarte.\n\n¿Necesitas alguna otra asistencia?";
    }

    // Send resolution confirmation
    await sock.sendMessage(sender, { text: confirmationMessage });

    // Calculate resolution time
    const resolutionTime = transferData.transferTime
      ? Math.round(
          (Date.now() - new Date(transferData.transferTime).getTime()) /
            (1000 * 60)
        )
      : 0;

    // Log the resolution with analytics
    db.data.logs.push({
      sender,
      action: "human_resolved_ai",
      previousState: previousState,
      transferData: transferData,
      resolutionMessage: resolutionMessage,
      resolutionTimeMinutes: resolutionTime,
      timestamp: new Date().toISOString(),
      sessionState: userSession.state,
      method: "ai_enhanced",
    });

    console.log(
      `✅ Bot reactivado para usuario ${userId} (Tiempo de resolución: ${resolutionTime} min)`
    );

    await db.write();
    return true;
  } catch (error) {
    console.error("❌ Error resolviendo asistencia humana:", error);
    return false;
  }
}

// Enhanced analytics for human assistance
function getHumanAssistanceAnalytics() {
  const waitingUsers = [];
  const resolvedCases = [];

  if (db.data.userSessions) {
    Object.entries(db.data.userSessions).forEach(([userId, session]) => {
      if (isUserWaitingForHuman(session)) {
        const waitingTime = session.data.humanTransferTime
          ? Math.round(
              (Date.now() -
                new Date(session.data.humanTransferTime).getTime()) /
                (1000 * 60)
            )
          : 0;

        waitingUsers.push({
          userId: userId.split("@")[0],
          fullId: userId,
          reason: session.data.humanTransferReason || "unknown",
          category: session.data.humanTransferCategory || "unknown",
          urgency: session.data.humanTransferUrgency || "medium",
          transferTime: session.data.humanTransferTime,
          waitingTime: waitingTime,
          originalMessage: session.data.originalMessage,
          aiAnalysis: session.data.aiAnalysis,
        });
      }

      if (session.data.humanResolved) {
        resolvedCases.push({
          userId: userId.split("@")[0],
          resolvedTime: session.data.humanResolvedTime,
          category: session.data.humanTransferCategory,
          urgency: session.data.humanTransferUrgency,
        });
      }
    });
  }

  // Calculate statistics
  const categoryStats = {};
  const urgencyStats = {};

  [...waitingUsers, ...resolvedCases].forEach((case_) => {
    categoryStats[case_.category] = (categoryStats[case_.category] || 0) + 1;
    urgencyStats[case_.urgency] = (urgencyStats[case_.urgency] || 0) + 1;
  });

  return {
    waiting: waitingUsers,
    resolved: resolvedCases.length,
    totalCases: waitingUsers.length + resolvedCases.length,
    categoryBreakdown: categoryStats,
    urgencyBreakdown: urgencyStats,
    averageWaitTime:
      waitingUsers.length > 0
        ? Math.round(
            waitingUsers.reduce((sum, user) => sum + user.waitingTime, 0) /
              waitingUsers.length
          )
        : 0,
  };
}

// Enhanced Human Transfer Detection
// Enhanced Human Transfer Detection using AI
async function shouldTransferToHuman(messageText, detectedIntent, userSession) {
  try {
    // Use AI detection first
    const aiAnalysis = await detectHumanAssistanceWithAI(
      messageText,
      userSession,
      detectedIntent
    );

    if (aiAnalysis.needsHuman && aiAnalysis.confidence > 0.6) {
      console.log("🤖 AI recomienda transferir a humano:", aiAnalysis);
      return {
        shouldTransfer: true,
        analysis: aiAnalysis,
        method: "ai_detection",
      };
    }

    // Fallback checks for edge cases
    const text = messageText.toLowerCase();

    // Check for repetitive loops (user stuck)
    const isStuck = userSession.data && userSession.data.loopCount > 3;
    if (isStuck) {
      return {
        shouldTransfer: true,
        analysis: {
          needsHuman: true,
          confidence: 0.9,
          reason: "user_stuck_in_loop",
          urgency: "medium",
          category: "confused",
          context: "User appears to be stuck in conversation loop",
        },
        method: "loop_detection",
      };
    }

    // Check for explicit escalation words that AI might miss
    const escalationWords = [
      "supervisor",
      "manager",
      "gerente",
      "jefe",
      "director",
    ];
    const hasEscalation = escalationWords.some((word) => text.includes(word));

    if (hasEscalation) {
      return {
        shouldTransfer: true,
        analysis: {
          needsHuman: true,
          confidence: 0.8,
          reason: "escalation_requested",
          urgency: "high",
          category: "escalation",
          context: "User explicitly requested escalation to supervisor/manager",
        },
        method: "escalation_detection",
      };
    }

    return {
      shouldTransfer: false,
      analysis: aiAnalysis,
      method: "ai_detection",
    };
  } catch (error) {
    console.error("❌ Error en shouldTransferToHuman:", error);
    return {
      shouldTransfer: false,
      analysis: null,
      method: "error",
    };
  }
}

// ==================== ENHANCED MESSAGE HANDLING ====================

// Add this function for debugging
function debugUserFlow(sender, messageText, userSession, detectedIntent) {
  console.log("\n🔍 DEBUG USER FLOW");
  console.log("==================");
  console.log("Usuario:", sender.split("@")[0]);
  console.log("Mensaje:", messageText);
  console.log("Estado actual:", userSession.state);
  console.log("Datos de sesión:", JSON.stringify(userSession.data, null, 2));
  console.log("Intent detectado:", detectedIntent?.intent);
  console.log("Confianza:", detectedIntent?.confidence);
  console.log("Entidades:", JSON.stringify(detectedIntent?.entities, null, 2));
  console.log("==================\n");
}

// Get users waiting for human assistance (used by admin commands)
function getUsersWaitingForHuman() {
  const waitingUsers = [];

  if (db.data.userSessions) {
    Object.entries(db.data.userSessions).forEach(([userId, session]) => {
      if (isUserWaitingForHuman(session)) {
        const waitingTime = session.data.humanTransferTime
          ? Math.round(
              (Date.now() -
                new Date(session.data.humanTransferTime).getTime()) /
                (1000 * 60)
            )
          : 0;

        waitingUsers.push({
          userId: userId.split("@")[0],
          fullId: userId,
          reason: session.data.humanTransferReason || "unknown",
          category: session.data.humanTransferCategory || "unknown",
          urgency: session.data.humanTransferUrgency || "medium",
          transferTime: session.data.humanTransferTime,
          waitingTime: waitingTime,
          originalMessage: session.data.originalMessage,
          aiAnalysis: session.data.aiAnalysis,
        });
      }
    });
  }

  return waitingUsers;
}

// Inside MultipleFiles/bot.js

// Inside MultipleFiles/bot.js

async function handlePhysicalDeliveryRequest(
  messageText,
  userSession,
  physicalAnalysis // This parameter is useful if AI already detected physical delivery
) {
  try {
    // Always try to extract amount and country from the current message
    const amountInfo = intelligentAmountExtraction(messageText);
    const countryInfo = intelligentCountryDetection(messageText);

    console.log("💵 Procesando solicitud de entrega física:", {
      amountInfo,
      countryInfo,
      userSessionData: userSession.data // Debugging: see what's in session
    });

    // Update session data with newly extracted info if available
    if (amountInfo && amountInfo.confidence > 0.6) {
      userSession.data.amount = amountInfo.amount;
      userSession.data.currency = amountInfo.currency;
    }
    if (countryInfo && countryInfo.confidence > 0.8) {
      userSession.data.country = countryInfo.country;
    }

    // Now, check if we have ALL necessary information (amount AND country)
    // from either the current message or previous session data.
    const finalAmount = userSession.data.amount;
    const finalCountry = userSession.data.country;
    const finalCurrency = userSession.data.currency; // Keep track of currency

    // Ensure physicalDelivery flag is set for this flow
    userSession.data.physicalDelivery = true;
    userSession.data.deliveryType = "physical_dollars";

    if (finalAmount && finalCountry) {
      let amountForCalculation = finalAmount;

      const isNetAmount = isNetAmountIntent(messageText); // Check if they want to receive exact amount

      const calculation = calculatePhysicalDeliveryEnhanced(
        amountForCalculation, // Use the amount from session or current message
        finalCountry,
        isNetAmount
      );

      if (calculation.success) {
        userSession.state = SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION;
        userSession.data.loopCount = 0; // Reset loop count

        return {
          message: `✅ Perfecto, entrega de dólares físicos en Venezuela desde ${getCountryDisplayName(
            finalCountry
          )}.\n\n${
            calculation.message
          }\n\n¿Confirmas que eres el titular de la cuenta desde la cual harás la transferencia?`,
          intent: "physical_delivery_calculated",
          newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION, // Explicitly set state
          sessionData: {
            country: finalCountry,
            amount: finalAmount, // Store original amount
            currency: finalCurrency, // Store original currency
            deliveryType: "physical_dollars",
            calculation: calculation,
            physicalDelivery: true, // Crucial flag
          },
        };
      } else {
        // If calculation failed, reset relevant session data
        delete userSession.data.amount;
        delete userSession.data.currency;
        delete userSession.data.country;
        return {
          message: calculation.message,
          intent: "physical_delivery_error",
          newState: SESSION_STATES.INITIAL, // Go back to initial state on error
        };
      }
    }

    // If we don't have both, determine what's missing and ask for it.
    // Prioritize asking for country if amount is known, or vice-versa.
    if (finalAmount && !finalCountry) {
      // This is the block that needs to ensure the amount is correctly passed
      // and the state is set to AWAITING_COUNTRY.
      return {
        message: `💵 Perfecto, entrega de dólares físicos por ${
          finalCurrency !== "UNKNOWN" ? "$" + finalAmount + " USD" : finalAmount
        }.\n\n🔒 **Comisión fija: 10%** para logística de entrega física.\n\n🌎 ¿Desde qué país estás enviando?\n\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile`,
        intent: "physical_delivery_amount_detected",
        newState: SESSION_STATES.AWAITING_COUNTRY, // Explicitly set state
        sessionData: {
          amount: finalAmount, // Ensure amount is explicitly in sessionData for next turn
          currency: finalCurrency,
          deliveryType: "physical_dollars",
          physicalDelivery: true, // Crucial flag
        },
      };
    }

    if (finalCountry && !finalAmount) {
      return {
        message: `✅ Perfecto, entrega de dólares físicos en Venezuela desde ${getCountryDisplayName(
          finalCountry
        )}.\n\n🔒 **Comisión fija: 10%** para cubrir la logística de entrega física.\n\n💰 ¿Cuál es el monto que deseas enviar? Por favor especifica la moneda (ej: "$500 USD" o "${formatCurrency(
          1000,
          finalCountry
        )}" si es moneda local)`,
        intent: "physical_delivery_country_detected",
        newState: SESSION_STATES.AWAITING_AMOUNT, // Explicitly set state
        sessionData: {
          country: finalCountry,
          deliveryType: "physical_dollars",
          physicalDelivery: true, // Crucial flag
        },
      };
    }

    // If neither amount nor country is known, provide generic info and ask for both.
    return {
      message: `💵 **Entrega de Dólares Físicos en Venezuela**\n\n✅ Disponible desde cualquier país\n🔒 Comisión fija: **10%** del monto\n⏱️ Tiempo de entrega: 24-48 horas\n🚚 Incluye logística de transporte seguro\n\n¿Desde qué país y por cuánto deseas enviar?\n\nEjemplo: "Desde República Dominicana, $500 USD"`,
      intent: "physical_delivery_generic",
      newState: SESSION_STATES.CASH_DELIVERY, // Or AWAITING_COUNTRY if you prefer to start there
      sessionData: {
        deliveryType: "physical_dollars",
        physicalDelivery: true, // Crucial flag
      },
    };
  } catch (error) {
    console.error("❌ Error handling physical delivery request:", error);
    // Reset session data on error to avoid persistent bad state
    delete userSession.data.amount;
    delete userSession.data.currency;
    delete userSession.data.country;
    return {
      message:
        "❌ Error procesando solicitud de entrega física. Por favor intenta nuevamente.",
      intent: "physical_delivery_error",
      newState: SESSION_STATES.INITIAL,
    };
  }
}



function isAgentMessage(sender) {
  const rawNumber = process.env.WHATSAPP_NUMBER || "";
  const cleanedNumber = rawNumber.replace(/\D/g, ""); // Removes +, spaces, dashes
  const agentJID = `${cleanedNumber}@s.whatsapp.net`;

  return sender === agentJID;
}

// Inside MultipleFiles/bot.js

// Inside MultipleFiles/bot.js

async function handleAIAccountConfirmation(messageText, userSession) {
  try {
    const systemPrompt = `You are a smart AI assistant helping confirm account ownership for a money transfer.

Your job is to analyze the user's response and decide whether they have confirmed being the owner of the bank account.

Return a JSON like this:
{
  "confirmation": "yes" | "no" | "unclear",
  "confidence": 0.0-1.0,
  "explanation": "brief reason for decision"
}

Examples of confirmation:
- "Yes, it's my account"
- "I’m the owner"
- "Yes I will use my account"

Examples of denial:
- "No, it's my friend’s account"
- "Someone else will send it"
- "It's not mine"

USER RESPONSE: "${messageText}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageText },
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const parsed = JSON.parse(completion.choices[0].message.content.trim());
    console.log("🤖 AI Account Confirmation Analysis:", parsed);

    if (parsed.confirmation === "yes") {
      // Check if physical delivery was already established in the session
      if (userSession.data.physicalDelivery) {
        return {
          message:
            "¡Perfecto! 🙌 Confirmado que eres el titular de la cuenta y que deseas entrega física.\n\n📝 Ahora, por favor, proporciona la información del beneficiario para la entrega de los dólares físicos:\n\n📌 **Nombre y Apellido del beneficiario**\n📌 **Cédula**\n📌 **Teléfono de contacto**\n📌 **Dirección completa de entrega**",
          intent: "account_confirmed_physical_delivery",
          newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        };
      } else {
        // Original flow for other transfer types (bank transfer, cash deposit)
        return {
          message:
            "¡Perfecto! 🙌 Confirmado que eres el titular de la cuenta.\n\n📝 Ahora, ¿cómo prefieres realizar el pago?\n\n1️⃣ **Transferencia bancaria** (Bolívares)\n2️⃣ **Depósito en efectivo** (Bolívares)\n3️⃣ **Entrega física** (Dólares USD - Comisión 10%)\n\nResponde con el número de tu opción preferida.",
          intent: "account_confirmed",
          newState: SESSION_STATES.AWAITING_TRANSFER_TYPE,
        };
      }
    } else if (parsed.confirmation === "no") {
      return {
        message:
          "⚠️ Por razones de seguridad, solo aceptamos pagos desde cuentas a nombre del cliente que nos contacta.\n\n✅ Es indispensable que seas el titular de la cuenta o que el titular se comunique directamente con nosotros.\n\n¿Tienes una cuenta personal desde la cual puedas hacer la transferencia?",
        intent: "account_not_confirmed",
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
      };
    } else {
      return {
        message:
          "No estoy seguro de tu respuesta. Por favor, ¿podrías confirmar si eres el titular de la cuenta con un 'Sí' o un 'No'?",
        intent: "account_confirmation_unclear",
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
      };
    }
  } catch (error) {
    console.error("❌ Error in AI account confirmation:", error);
    return {
      message:
        "Disculpa, no entendí tu respuesta. ¿Eres el titular de la cuenta? Responde con 'Sí' o 'No'.",
      intent: "account_confirmation_error",
      newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
    };
  }
}




// Inside MultipleFiles/bot.js

async function handleUserMessage(sender, messageText) {
  try {
    console.log("🔄 Procesando mensaje de:", sender, "Texto:", messageText);

    // Initialize user session
    if (!db.data.userSessions[sender]) {
      db.data.userSessions[sender] = {
        state: SESSION_STATES.INITIAL,
        data: {},
        lastActivity: new Date().toISOString(),
      };
    }

    const userSession = db.data.userSessions[sender];
    userSession.lastActivity = new Date().toISOString();

    // Check for continue responses first (existing logic) - Keep this early
    const continueResponse = handleContinueResponse(messageText, userSession);
    if (continueResponse) {
      await sock.sendMessage(sender, { text: continueResponse.message });

      if (continueResponse.newState) {
        userSession.state = continueResponse.newState;
        userSession.data.loopCount = 0;
      }
      if (continueResponse.sessionData) {
        userSession.data = {
          ...userSession.data,
          ...continueResponse.sessionData,
        };
      }

      await db.write();
      return;
    }

    // Initialize user in database (existing logic)
    if (!db.data.users[sender]) {
      db.data.users[sender] = {
        firstContact: new Date().toISOString(),
        messageCount: 0,
        lastMessage: new Date().toISOString(),
      };
    }
    db.data.users[sender].messageCount++;
    db.data.users[sender].lastMessage = new Date().toISOString();

    // CHECK 2: Is user currently waiting for human assistance? - Keep this early
    if (isUserWaitingForHuman(userSession)) {
      console.log(
        `🔕 Usuario ${
          sender.split("@")[0]
        } está esperando asistencia humana - Bot pausado`
      );

      // Log the ignored message
      db.data.logs.push({
        sender,
        message: messageText,
        action: "message_ignored_waiting_human",
        timestamp: new Date().toISOString(),
        sessionState: userSession.state,
      });

      // Optionally send a reminder (but not too frequently)
      const lastReminder = userSession.data.lastHumanReminder;
      const now = Date.now();
      const reminderInterval = 30 * 60 * 1000; // 30 minutes

      if (
        !lastReminder ||
        now - new Date(lastReminder).getTime() > reminderInterval
      ) {
        await sock.sendMessage(sender, {
          text: "⏳ Tu consulta está siendo atendida por un asesor humano. Por favor espera su respuesta.\n\n🔕 El bot automático permanece pausado hasta que se resuelva tu caso.",
        });
        userSession.data.lastHumanReminder = new Date().toISOString();
        await db.write();
      }

      return; // Stop processing - bot is paused for this user
    }

    // Track loop count for stuck detection (existing logic)
    if (!userSession.data.loopCount) {
      userSession.data.loopCount = 0;
    }

    // --- AI-FIRST INTENT DETECTION ---
    console.log("🤖 Enviando mensaje a OpenAI para análisis de INTENT...");
    const detectedIntent = await detectIntentWithOpenAI(
      messageText,
      userSession
    );

    if (!detectedIntent) {
      console.log("❌ OpenAI no pudo procesar el mensaje, usando fallback");
      return await handleFallbackResponse(sender, messageText, userSession);
    }

    console.log(
      "🎯 Intent detectado:",
      detectedIntent.intent,
      "Confianza:",
      detectedIntent.confidence
    );

    // CHECK 3: AI-powered human assistance detection (always check this early)
    const humanAssistanceAnalysis = await detectHumanAssistanceWithAI(
      messageText,
      userSession,
      detectedIntent
    );

    if (
      humanAssistanceAnalysis.needsHuman &&
      humanAssistanceAnalysis.confidence > 0.6
    ) {
      console.log(
        "🚨 AI detectó necesidad de asistencia humana:",
        humanAssistanceAnalysis
      );

      const transferred = await transferToHumanAssistance(
        sender,
        userSession,
        humanAssistanceAnalysis,
        messageText
      );

      if (transferred) {
        return; // Stop processing - user transferred to human
      }
    }

    // --- STATE-SPECIFIC HANDLING (Conditional based on AI intent) ---
    // Only call state-specific handlers if the AI's detected intent matches the expected state.
    // This prevents the bot from getting stuck or misinterpreting input.

    let handledByState = false;

    if (userSession.state === SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION && detectedIntent.intent === "account_confirmation") {
      const confirmationResponse = await handleAIAccountConfirmation(messageText, userSession);
      if (confirmationResponse) {
        await sock.sendMessage(sender, { text: confirmationResponse.message });
        if (confirmationResponse.newState) {
          userSession.state = confirmationResponse.newState;
          userSession.data.loopCount = 0;
        }
        await db.write();
        handledByState = true;
      }
    } else if (userSession.state === SESSION_STATES.AWAITING_BENEFICIARY_INFO && detectedIntent.intent === "beneficiary_info") {
      const beneficiaryResponse = await handleAIBeneficiaryInfo(messageText, userSession);
      if (beneficiaryResponse) {
        await sock.sendMessage(sender, { text: beneficiaryResponse.message });
        if (beneficiaryResponse.newState) {
          userSession.state = beneficiaryResponse.newState;
          userSession.data.loopCount = 0;
        }
        if (beneficiaryResponse.sessionData) {
          userSession.data = { ...userSession.data, ...beneficiaryResponse.sessionData };
        }
        if (beneficiaryResponse.requiresHumanTransfer) {
          await transferToHumanAssistance(sender, userSession, {
            needsHuman: true, confidence: 0.9, reason: beneficiaryResponse.intent,
            urgency: "medium", category: "complex_query", context: "Beneficiary info extraction failed or was unclear"
          }, messageText);
        }
        await db.write();
        handledByState = true;
      }
    } else if (userSession.state === SESSION_STATES.AWAITING_TRANSFER_TYPE && detectedIntent.intent === "send_money") {
        // Allow user to select transfer type or re-state intent
        const transferTypeResponse = handleTransferTypeOriginal(messageText, userSession);
        if (transferTypeResponse) {
            await sock.sendMessage(sender, { text: transferTypeResponse.message });
            if (transferTypeResponse.newState) {
                userSession.state = transferTypeResponse.newState;
                userSession.data.loopCount = 0;
            }
            if (transferTypeResponse.sessionData) {
                userSession.data = { ...userSession.data, ...transferTypeResponse.sessionData };
            }
            await db.write();
            handledByState = true;
        }
    } else if (userSession.state === SESSION_STATES.AWAITING_COUNTRY && detectedIntent.intent === "send_money") {
        const countryResponse = handleCountryInputOriginal(messageText, userSession);
        if (countryResponse) {
            await sock.sendMessage(sender, { text: countryResponse.message });
            if (countryResponse.newState) {
                userSession.state = countryResponse.newState;
                userSession.data.loopCount = 0;
            }
            if (countryResponse.sessionData) {
                userSession.data = { ...userSession.data, ...countryResponse.sessionData };
            }
            await db.write();
            handledByState = true;
        }
    } else if (userSession.state === SESSION_STATES.AWAITING_AMOUNT && detectedIntent.intent === "send_money") {
        const amountResponse = handleAmountInputOriginal(messageText, userSession);
        if (amountResponse) {
            await sock.sendMessage(sender, { text: amountResponse.message });
            if (amountResponse.newState) {
                userSession.state = amountResponse.newState;
                userSession.data.loopCount = 0;
            }
            if (amountResponse.sessionData) {
                userSession.data = { ...userSession.data, ...amountResponse.sessionData };
            }
            await db.write();
            handledByState = true;
        }
    }

    if (handledByState) {
        return; // If a state-specific handler took action, we're done.
    }

    // --- GENERAL INTENT HANDLING (if not handled by specific state) ---
    // This is where the AI drives the conversation for new intents or topic changes.

    // First, try direct pattern matching for common initial phrases (e.g., "send money", "physical delivery")
    // This can be faster than full AI processing for very common, clear cases.
    const directResponse = await handleDirectPatterns(messageText, userSession);
    if (directResponse) {
      await sock.sendMessage(sender, { text: directResponse.message });
      if (directResponse.newState) {
        userSession.state = directResponse.newState;
        userSession.data.loopCount = 0; // Reset loop count on state change
      }
      if (directResponse.sessionData) {
        userSession.data = { ...userSession.data, ...directResponse.sessionData };
      }
      await db.write();
      return;
    }

    // Then, use the AI's detected intent to route to the appropriate intelligent handler
    if (detectedIntent.confidence > 0.6) { // Only proceed if AI is reasonably confident
      const response = await handleIntelligentIntent(
        detectedIntent,
        userSession,
        messageText
      );

      if (response) {
        await sock.sendMessage(sender, { text: response.message });

        // Update session state
        if (response.newState) {
          userSession.state = response.newState;
          userSession.data.loopCount = 0; // Reset loop count on state change
        }
        if (response.sessionData) {
          userSession.data = { ...userSession.data, ...response.sessionData };
        }

        // Log interaction
        db.data.logs.push({
          sender,
          message: messageText,
          response: response.message,
          intent: detectedIntent.intent,
          confidence: detectedIntent.confidence,
          method: "ai_intent_handler",
          sessionState: userSession.state,
          timestamp: new Date().toISOString(),
        });
        await db.write();
        return;
      }
    }

    // --- CONTEXTUAL FALLBACK / AI GENERATED RESPONSE ---
    // If no specific intent or state handler took action, generate a contextual response.
    console.log("🤖 Generando respuesta contextual con OpenAI...");
    const contextualResponse = await generateContextualResponse(
      messageText,
      userSession,
      detectedIntent
    );

    if (contextualResponse) {
      await sock.sendMessage(sender, { text: contextualResponse });

      // Try to extract state changes from AI response
      const stateUpdate = await extractStateFromAIResponse(
        contextualResponse,
        detectedIntent,
        userSession
      );
      if (stateUpdate.newState) {
        userSession.state = stateUpdate.newState;
        userSession.data.loopCount = 0;
      }
      if (stateUpdate.sessionData) {
        userSession.data = { ...userSession.data, ...stateUpdate.sessionData };
      }

      db.data.logs.push({
        sender,
        message: messageText,
        response: contextualResponse,
        intent: detectedIntent.intent,
        confidence: detectedIntent.confidence,
        method: "ai_contextual",
        sessionState: userSession.state,
        timestamp: new Date().toISOString(),
      });
      await db.write();
    } else {
      // Final fallback to original logic if AI also fails to generate a coherent response
      console.log("🔄 Usando lógica de fallback original");
      await handleFallbackResponse(sender, messageText, userSession);
    }
  } catch (error) {
    console.error("❌ Error en handleUser Message:", error);
    try {
      await sock.sendMessage(sender, {
        text: "Disculpa, hubo un error temporal. Un asesor humano te atenderá en breve.",
      });
    } catch (sendError) {
      console.error("❌ Error enviando mensaje de respaldo:", sendError);
    }
  }
}








// Inside MultipleFiles/bot.js

// Inside MultipleFiles/bot.js

async function handleIntelligentIntent(
  detectedIntent,
  userSession,
  originalMessage
) {
  const { intent, entities, confidence } = detectedIntent;

  try {
    switch (intent) {
      case "send_money":
        // If AI detects "send_money", explicitly set for bank transfer
        userSession.data.physicalDelivery = false;
        userSession.data.deliveryType = "bank_transfer";
        return await handleAISendMoney(entities, userSession, originalMessage);

      case "physical_delivery":
      case "cash_delivery": // Treat cash_delivery as physical_delivery
        // If AI detects physical delivery, explicitly set flags
        userSession.data.physicalDelivery = true;
        userSession.data.deliveryType = "physical_dollars";
        return await handlePhysicalDeliveryRequest(
          originalMessage,
          userSession,
          {
            wantsPhysicalDelivery: true,
            confidence: confidence,
            deliveryKeywords:
              detectedIntent.delivery_preference?.delivery_keywords || [],
          }
        );

      case "delivery_comparison":
        // For comparison, clear physical delivery flag if it was set, as user is exploring options
        userSession.data.physicalDelivery = false;
        return await handleDeliveryComparison(originalMessage, userSession);

      case "check_rate":
        // Rate check doesn't imply delivery type, so clear if set
        userSession.data.physicalDelivery = false;
        return await handleAIRateCheck(entities, userSession, originalMessage);

      case "account_confirmation":
        // This intent is usually handled by state-specific logic, but if AI detects it out of sequence,
        // it might be a confirmation for a previous flow. Let the handler decide.
        return handleAIAccountConfirmation(originalMessage, userSession);

      case "beneficiary_info":
        // Similar to account_confirmation, let the handler decide based on session context.
        return await handleAIBeneficiaryInfo(originalMessage, userSession);

      case "receipt_submission":
        return handleAIReceiptSubmission(originalMessage, userSession);

      case "greeting":
        // Clear any previous context on a new greeting
        userSession.data = {}; // Reset all session data
        return {
          message: response.greeting,
          intent: "greeting",
          newState: SESSION_STATES.INITIAL,
        };

      case "business_hours":
        return {
          message: response.business_hours,
          intent: "business_hours",
        };

      case "promo_inquiry":
        return {
          message: response.promo,
          intent: "promo",
        };

      case "human_agent":
        return {
          message: response.human,
          intent: "human_transfer_requested",
          requiresHumanTransfer: true,
        };

      case "complaint":
        return {
          message:
            "😔 Lamento escuchar que has tenido una experiencia no satisfactoria. Te conectaré inmediatamente con un supervisor que podrá ayudarte.",
          intent: "complaint_escalation",
          requiresHumanTransfer: true,
        };

      case "unknown":
        // If AI is unsure, return null to let contextual response or fallback handle it
        return null;

      default:
        return null;
    }
  } catch (error) {
    console.error("❌ Error en handleIntelligentIntent:", error);
    return null;
  }
}


// Inside MultipleFiles/bot.js

async function handleAISendMoney(entities, userSession, originalMessage) {
  // Explicitly clear physicalDelivery flag when send_money intent is handled
  userSession.data.physicalDelivery = false;
  userSession.data.deliveryType = "bank_transfer"; // Default to bank transfer for send_money

  const amountInfo = intelligentAmountExtraction(originalMessage);
  const countryInfo = intelligentCountryDetection(originalMessage);

  console.log("🔍 Análisis de envío:", {
    amountInfo,
    countryInfo,
    originalMessage,
  });

  // If we have both amount and country with good confidence
  if (
    amountInfo &&
    amountInfo.confidence > 0.6 &&
    countryInfo &&
    countryInfo.confidence > 0.8
  ) {
    const country = countryInfo.country;
    let amount = amountInfo.amount;

    // Fix currency handling for Peru
    if (country === "peru" && amountInfo.currency === "UNKNOWN") {
      // Assume Peruvian soles for Peru
      amountInfo.currency = "PEN";
    }

    console.log(`✅ Detectados: ${amount} desde ${country}`);

    // Handle currency conversion if needed
    if (amountInfo.currency === "USD" && country !== "ecuador") {
      amount = convertUSDToLocalCurrency(amount, country);
    } else if (amountInfo.currency === "UNKNOWN" && country === "dominican") {
      // Assume Dominican pesos for Dominican Republic
      amountInfo.currency = "DOP";
    }

    const rateInfo = calculateRate(amount, country);

    if (rateInfo.error) {
      return {
        message:
          "😓 Lo siento, las tasas de hoy aún no han sido cargadas. Un asesor te ayudará con el cálculo exacto.",
        intent: "rate_not_available",
      };
    }

    return {
      message: `✅ Perfecto, quieres enviar ${formatCurrency(
        amount,
        country
      )} desde ${getCountryDisplayName(
        country
      )} a Venezuela.\n\n💰 **Cálculo:**\n📊 Monto: ${formatCurrency(
        amount,
        country
      )}\n📈 Tasa: ${rateInfo.rate} Bs\n💵 El beneficiario recibirá: **${
        rateInfo.receivedAmount
      } Bs**\n\n¿Confirmas que eres el titular de la cuenta desde la cual harás la transferencia?`,
      intent: "send_money_calculated",
      newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
      sessionData: {
        amount: amount,
        country: country,
        currency: amountInfo.currency || "DOP",
        rateInfo: rateInfo,
      },
    };
  }

  // If we have country but need to clarify amount
  if (countryInfo && countryInfo.confidence > 0.8) {
    // Check if amount was mentioned but unclear
    if (amountInfo && amountInfo.confidence < 0.6) {
      return {
        message: `¡Excelente! Desde ${getCountryDisplayName(
          countryInfo.country
        )} 🌎\n\nVeo que mencionaste ${
          amountInfo.amount
        }, pero necesito confirmar: ¿son ${
          amountInfo.amount
        } pesos dominicanos?\n\n💰 Por favor confirma el monto exacto.`,
        intent: "country_detected_amount_unclear",
        newState: SESSION_STATES.AWAITING_AMOUNT,
        sessionData: {
          country: countryInfo.country,
          suggestedAmount: amountInfo.amount,
        },
      };
    } else {
      return {
        message: `¡Excelente! Desde ${getCountryDisplayName(
          countryInfo.country
        )} 🌎\n\n💰 ¿Cuál es el monto que deseas enviar? Por favor especifica la moneda (ej: $500 USD, 10000 pesos, etc.)`,
        intent: "country_detected_need_amount",
        newState: SESSION_STATES.AWAITING_AMOUNT,
        sessionData: { country: countryInfo.country },
      };
    }
  }

  // If we have amount but no country
  if (amountInfo && amountInfo.confidence > 0.6) {
    return {
      message: `Perfecto, quieres enviar ${amountInfo.amount} ${
        amountInfo.currency !== "UNKNOWN" ? amountInfo.currency : ""
      }.\n\n🌎 ¿Desde qué país estás enviando?\n\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile`,
      intent: "amount_detected_need_country",
      newState: SESSION_STATES.AWAITING_COUNTRY,
      sessionData: {
        amount: amountInfo.amount,
        currency: amountInfo.currency,
      },
    };
  }

  // Generic send money response
  return {
    message:
      "¡Perfecto! Te ayudo a enviar dinero a Venezuela. 🇻🇪\n\n¿Desde qué país estás enviando y cuál es el monto aproximado?\n\nEjemplo: 'Desde República Dominicana, 5000 pesos' o 'Desde Perú, $300 USD'",
    intent: "send_money_generic",
    newState: SESSION_STATES.AWAITING_COUNTRY,
  };
}




// AI-powered rate check handler
async function handleAIRateCheck(entities, userSession, originalMessage) {
  const amountInfo = intelligentAmountExtraction(originalMessage);
  const countryInfo = intelligentCountryDetection(originalMessage);

  if (amountInfo && countryInfo) {
    const country = countryInfo.country;
    let amount = amountInfo.amount;

    // Handle currency conversion
    if (amountInfo.currency === "USD" && country !== "ecuador") {
      amount = convertUSDToLocalCurrency(amount, country);
    }

    const rateInfo = calculateRate(amount, country);

    if (rateInfo.error) {
      return {
        message:
          "😓 Lo siento, las tasas de hoy aún no han sido cargadas. Un asesor te proporcionará la tasa actualizada.",
        intent: "rate_not_available",
      };
    }

    return {
      message: `💰 **Cálculo de tasa para ${getCountryDisplayName(
        country
      )}:**\n\n📊 Monto: ${formatCurrency(
        amount,
        country
      )}\n📈 Tasa aplicable: ${rateInfo.rate} Bs\n💵 Recibirás: **${
        rateInfo.receivedAmount
      } Bs**\n\n✅ Tasa válida para hoy (${
        dailyRates.date
      })\n\n¿Deseas proceder con esta transferencia?`,
      intent: "rate_calculated",
      sessionData: { amount: amount, country: country, rateInfo: rateInfo },
    };
  }

  if (countryInfo) {
    return handleCountrySpecificRate(countryInfo.country);
  }

  if (amountInfo) {
    return {
      message: `Para calcular exactamente cuánto recibirás por ${formatCurrency(
        amountInfo.amount,
        "generic"
      )}, necesito saber desde qué país estás enviando.\n\n¿Desde cuál de estos países?\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile`,
      intent: "rate_needs_country",
      newState: SESSION_STATES.AWAITING_COUNTRY,
      sessionData: {
        amount: amountInfo.amount,
        requestType: "rate_calculation",
      },
    };
  }

  // Generic rate response
  return {
    message: response.daily_rate,
    intent: "daily_rate",
  };
}

// AI-powered account confirmation handler
// function handleAIAccountConfirmation(messageText, userSession) {
//   const text = messageText.toLowerCase().trim();

//   // Enhanced yes/no detection
//   const yesPatterns = [
//     "sí",
//     "si",
//     "yes",
//     "claro",
//     "correcto",
//     "exacto",
//     "afirmativo",
//     "por supuesto",
//     "obvio",
//     "desde luego",
//     "soy el titular", // Added to handle "I'm the owner"
//     "soy la titular",
//     "soy el dueño",
//     "soy la dueña",
//     "soy el propietario",
//     "soy la propietaria",
//   ];
//   const noPatterns = [
//     "no",
//     "nope",
//     "negativo",
//     "incorrecto",
//     "falso",
//     "para nada",
//   ];

//   const isYes = yesPatterns.some((pattern) => text.includes(pattern));
//   const isNo = noPatterns.some((pattern) => text.includes(pattern));

//   if (isYes) {
//     return {
//       message:
//         "¡Perfecto! 🙌 Confirmado que eres el titular de la cuenta.\n\n📝 Ahora, ¿cómo prefieres realizar el pago?\n\n1️⃣ **Transferencia bancaria** (Bolívares)\n2️⃣ **Depósito en efectivo** (Bolívares)\n3️⃣ **Entrega física** (Dólares USD - Comisión 10%)\n\nResponde con el número de tu opción preferida.",
//       intent: "account_confirmed",
//       newState: SESSION_STATES.AWAITING_TRANSFER_TYPE,
//     };
//   } else if (isNo) {
//     return {
//       message:
//         "⚠️ Por razones de seguridad, solo aceptamos pagos desde cuentas a nombre del cliente que nos contacta.\n\n✅ Es indispensable que seas el titular de la cuenta o que el titular se comunique directamente con nosotros.\n\n¿Tienes una cuenta personal desde la cual puedas hacer la transferencia?",
//       intent: "account_not_confirmed",
//       newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
//     };
//   }

//   // If the response is not a clear yes/no, prompt for clarification
//   return {
//     message:
//       "No estoy seguro de tu respuesta. Por favor, ¿podrías confirmar si eres el titular de la cuenta con un 'Sí' o un 'No'?",
//     intent: "account_confirmation_unclear",
//     newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
//   };
// }

// AI-powered beneficiary info handler
// Inside MultipleFiles/bot.js

async function handleAIBeneficiaryInfo(messageText, userSession) {
  try {
    const isPhysicalDelivery = userSession.data.physicalDelivery;

    let extractionPrompt;
    if (isPhysicalDelivery) {
      extractionPrompt = `Extract beneficiary information for PHYSICAL DOLLAR DELIVERY from this message and respond with JSON:
{
  "hasName": boolean,
  "hasCedula": boolean,
  "hasPhone": boolean,
  "hasAddress": boolean,
  "extractedInfo": {
    "name": "string or null",
    "cedula": "string or null",
    "phone": "string or null",
    "address": "string or null"
  },
  "isComplete": boolean,
  "missingFields": ["array of missing fields: name, cedula, phone, address"]
}

Message: "${messageText}"`;
    } else {
      // Original prompt for bank transfers
      extractionPrompt = `Extract beneficiary information from this message and respond with JSON:
{
  "hasName": boolean,
  "hasCedula": boolean,
  "hasAccount": boolean,
  "hasAmount": boolean,
  "extractedInfo": {
    "name": "string or null",
    "cedula": "string or null",
    "account": "string or null",
    "amount": "string or null"
  },
  "isComplete": boolean,
  "missingFields": ["array of missing fields: name, cedula, account, amount"]
}

Message: "${messageText}"`;
    }


    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: extractionPrompt },
        { role: "user", content: messageText },
      ],
      temperature: 0.1,
      max_tokens: 300,
    });

    const extraction = JSON.parse(completion.choices[0].message.content);
    console.log("Beneficiary Info Extraction AI Analysis:", extraction);

    if (extraction.isComplete) {
      // Store extracted info in session
      userSession.data.beneficiaryDetails = extraction.extractedInfo;
      userSession.data.beneficiaryComplete = true; // Mark as complete

      const hasReceipt = userSession.data && userSession.data.receiptReceived;

      if (hasReceipt) {
        // This path is for when receipt was sent BEFORE beneficiary info
        // This might be less common, but handles the state.
        if (isPhysicalDelivery) {
            const trackingNumber = schedulePhysicalDelivery(userSession, extraction.extractedInfo);
            return {
                message: `✅ ¡Perfecto! Comprobante verificado e información del beneficiario completa para entrega física.\n\n🚚 **Entrega Física Programada:**\n📋 Número de seguimiento: **${trackingNumber}**\n⏱️ Tiempo estimado: 24-48 horas\n\n📱 **Próximos pasos:**\n1️⃣ Validaremos tu pago (15-30 min)\n2️⃣ Coordinaremos con el repartidor\n3️⃣ Te enviaremos datos de contacto\n4️⃣ Entrega de dólares físicos\n\n🔔 Te mantendremos informado del progreso.`,
                intent: "physical_delivery_scheduled",
                newState: SESSION_STATES.DELIVERY_SCHEDULED, // New state for physical delivery scheduled
                sessionData: { processComplete: true, deliveryScheduled: true, trackingNumber: trackingNumber },
            };
        } else {
            return {
                message:
                    "✅ Perfecto, he recibido toda la información del beneficiario y el comprobante firmado.\n\n📋 Procederemos a validar tu pago y comenzar el proceso de transferencia.\n\n⏱️ Te notificaremos cuando esté listo. Normalmente toma entre 15-30 minutos.\n\n¿Hay algo más en lo que pueda ayudarte?",
                intent: "beneficiary_complete_with_receipt",
                newState: SESSION_STATES.INITIAL, // Reset to initial after completion
                sessionData: { processComplete: true },
            };
        }
      } else {
        // This is the more common path: beneficiary info is complete, now ask for receipt
        if (isPhysicalDelivery) {
            return {
                message:
                    "✅ Excelente, información del beneficiario para entrega física recibida correctamente.\n\nAhora necesito que envíes el comprobante de pago firmado con:\n✍️ Tu nombre completo + últimos 4 dígitos de tu WhatsApp\n\n📸 Por favor envía la foto del comprobante firmado.",
                intent: "physical_beneficiary_complete_need_receipt",
                newState: SESSION_STATES.AWAITING_RECEIPT, // New state for awaiting receipt
            };
        } else {
            return {
                message:
                    "✅ Excelente, información del beneficiario recibida correctamente.\n\nAhora necesito que envíes el comprobante de pago firmado con:\n✍️ Tu nombre completo + últimos 4 dígitos de tu WhatsApp\n\n📸 Por favor envía la foto del comprobante firmado.",
                intent: "beneficiary_complete_need_receipt",
                newState: SESSION_STATES.AWAITING_RECEIPT, // New state for awaiting receipt
            };
        }
      }
    } else {
      // Incomplete data, prompt user for missing fields
      let responseMessage = "📋 He recibido tu información, pero necesito que completes algunos datos:\n\n";

      extraction.missingFields.forEach((field, index) => {
        responseMessage += `${index + 1}️⃣ **${field.charAt(0).toUpperCase() + field.slice(1)}**\n`;
      });

      if (isPhysicalDelivery) {
        responseMessage += "\n📌 **Formato requerido para Entrega Física:**\n";
        responseMessage += "**Nombre y Apellido:** [Nombre completo del beneficiario]\n";
        responseMessage += "**Cédula:** [Número de cédula sin puntos ni guiones]\n";
        responseMessage += "**Teléfono de contacto:** [Número de contacto en Venezuela]\n";
        responseMessage += "**Dirección completa de entrega:** [Dirección completa para entrega]\n\n";
      } else {
        responseMessage += "\n📌 **Formato requerido para Transferencia Bancaria:**\n";
        responseMessage += "**Nombre y Apellido:** [Nombre completo del beneficiario]\n";
        responseMessage += "**Cédula:** [Número de cédula sin puntos ni guiones]\n";
        responseMessage += "**Número de Cuenta:** [20 dígitos de la cuenta bancaria]\n";
        responseMessage += "**Monto a Entregar:** [Cantidad en bolívares]\n\n";
      }
      responseMessage += "Por favor envía la información completa.";

      return {
        message: responseMessage,
        intent: "incomplete_beneficiary_data",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        sessionData: { partialBeneficiaryInfo: messageText },
      };
    }
  } catch (error) {
    console.error("❌ Error extracting beneficiary info:", error);
    // Fallback to human assistance if AI extraction fails
    return {
      message: "Disculpa, no pude procesar la información del beneficiario. Un asesor te ayudará con esto.",
      intent: "beneficiary_extraction_error",
      requiresHumanTransfer: true, // Trigger human transfer
    };
  }
}


// AI-powered receipt submission handler
function handleAIReceiptSubmission(messageText, userSession) {
  const text = messageText.toLowerCase();
  const isPhysicalDelivery =
    userSession.data.deliveryType === "physical_dollars" ||
    userSession.data.transferType === "physical_delivery";

  // Check if it's a receipt message
  const receiptKeywords = [
    "comprobante",
    "recibo",
    "receipt",
    "voucher",
    "transferencia",
    "depósito",
    "deposito",
    "pago",
    "payment",
    "transacción",
    "transferí",
    "deposité",
    "pagué",
    "sent",
    "transferred",
    "firmado",
    "signed",
  ];

  const hasReceiptKeyword = receiptKeywords.some((keyword) =>
    text.includes(keyword)
  );

  if (!hasReceiptKeyword) {
    return null; // Not a receipt message
  }

  // Check if properly signed
  const hasName = /[a-záéíóúñ]+\s+[a-záéíóúñ]+/i.test(messageText);
  const hasDigits = /\d{4}/.test(messageText);
  const signatureKeywords = ["firmado", "signed", "firma", "signature"];
  const hasSignatureKeyword = signatureKeywords.some((keyword) =>
    text.includes(keyword)
  );

  const isProperlySignedText = (hasName && hasDigits) || hasSignatureKeyword;

  if (!isProperlySignedText) {
    return {
      message:
        "📋 Gracias por el comprobante. 🙌 Solo necesito que lo firmes con tu nombre completo y los últimos 4 dígitos del número de WhatsApp desde el que me escribes.\n\n✍️ **Ejemplo:** Juan Pérez 1234\n\nEsto garantiza mayor seguridad. Por favor envía el comprobante firmado.",
      intent: "receipt_unsigned",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
    };
  }

  // Receipt is properly signed
  const hasBeneficiary =
    userSession.data && userSession.data.beneficiaryComplete;

  if (hasBeneficiary) {
    if (isPhysicalDelivery) {
      // Create tracking number for physical delivery
      const trackingNumber = schedulePhysicalDelivery(
        userSession,
        userSession.data.beneficiaryInfo
      );

      return {
        message: `✅ ¡Perfecto! Comprobante verificado e información del beneficiario completa.\n\n🚚 **Entrega Física Programada:**\n📋 Número de seguimiento: **${trackingNumber}**\n⏱️ Tiempo estimado: 24-48 horas\n\n📱 **Próximos pasos:**\n1️⃣ Validaremos tu pago (15-30 min)\n2️⃣ Coordinaremos con el repartidor\n3️⃣ Te enviaremos datos de contacto\n4️⃣ Entrega de dólares físicos\n\n🔔 Te mantendremos informado del progreso.`,
        intent: "physical_delivery_scheduled",
        newState: SESSION_STATES.INITIAL,
        sessionData: {
          receiptReceived: true,
          receiptSigned: true,
          processComplete: true,
          deliveryScheduled: true,
          trackingNumber: trackingNumber,
        },
      };
    } else {
      return {
        message:
          "✅ Perfecto, comprobante firmado recibido y la información del beneficiario está completa.\n\n📋 Procederemos a validar tu pago y comenzar el proceso de transferencia.\n\n⏱️ Te notificaremos cuando esté listo. Normalmente toma entre 15-30 minutos.\n\n¿Hay algo más en lo que pueda ayudarte?",
        intent: "receipt_and_beneficiary_complete",
        newState: SESSION_STATES.INITIAL,
        sessionData: {
          receiptReceived: true,
          receiptSigned: true,
          processComplete: true,
        },
      };
    }
  } else {
    if (isPhysicalDelivery) {
      return {
        message:
          "✅ Comprobante firmado recibido correctamente.\n\n📋 **Para entrega física necesito:**\n📌 **Nombre y Apellido del beneficiario**\n📌 **Cédula**\n📌 **Teléfono de contacto**\n📌 **Dirección completa de entrega**\n\n🚚 Esta información es necesaria para coordinar la entrega de los dólares físicos.",
        intent: "receipt_signed_need_physical_beneficiary",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        sessionData: { receiptReceived: true, receiptSigned: true },
      };
    } else {
      return {
        message:
          "✅ Comprobante firmado recibido correctamente.\n\nAhora necesito la información del beneficiario:\n\n📌 **Nombre y Apellido:**\n📌 **Cédula:**\n📌 **Número de Cuenta:**\n📌 **Monto a Entregar:**",
        intent: "receipt_signed_need_beneficiary",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        sessionData: { receiptReceived: true, receiptSigned: true },
      };
    }
  }
}

// AI-powered cash delivery handler
// Inside MultipleFiles/bot.js

async function handleAICashDelivery(entities, userSession, originalMessage) {
  const physicalAnalysis = await detectPhysicalDeliveryWithAI(
    originalMessage,
    userSession
  );

  if (
    physicalAnalysis.wantsPhysicalDelivery &&
    physicalAnalysis.confidence > 0.7
  ) {
    // Delegate to the unified physical delivery handler
    return await handlePhysicalDeliveryRequest(
      originalMessage,
      userSession,
      physicalAnalysis
    );
  }

  // The rest of the original handleAICashDelivery logic remains if it handles
  // a different type of "cash delivery" (e.g., cash deposit for bank transfer)
  // or if the AI's physical delivery detection was low confidence.
  // Based on your context, "cash delivery" seems to be synonymous with "physical delivery".
  // So, this part might become redundant if physicalAnalysis is always high confidence.

  const amountInfo = intelligentAmountExtraction(originalMessage);
  const countryInfo = intelligentCountryDetection(originalMessage);

  if (amountInfo && countryInfo) {
    const calculation = calculateCashDeliveryEnhanced(
      amountInfo.amount,
      isNetAmountIntent(originalMessage),
      countryInfo.country
    );

    if (calculation.success) {
      return {
        message: `✅ Perfecto, entrega en efectivo desde ${getCountryDisplayName(
          countryInfo.country
        )}.\n\n${
          calculation.message
        }\n\n📝 ¿Deseas proceder con esta transacción?`,
        intent: "cash_calculation_complete",
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
        sessionData: {
          country: countryInfo.country,
          deliveryType: "cash",
          calculation: calculation,
        },
      };
    }
  }

  if (countryInfo) {
    return {
      message: `✅ Perfecto, desde ${getCountryDisplayName(
        countryInfo.country
      )} con entrega en efectivo.\n\n💰 ¿Cuál es el monto que deseas enviar? (Recuerda que aplicamos una comisión del 10% por la entrega física)`,
      intent: "cash_country_detected",
      newState: SESSION_STATES.AWAITING_AMOUNT,
      sessionData: { country: countryInfo.country, deliveryType: "cash" },
    };
  }

  return {
    message:
      "✅ Perfecto, puedes enviar dólares en efectivo a Venezuela. 🔒 Ten en cuenta que este tipo de entrega tiene una comisión del 10% para cubrir la logística de entrega física en destino.",
    intent: "cash_delivery_generic",
    newState: SESSION_STATES.CASH_DELIVERY,
    sessionData: { deliveryType: "cash" },
  };
}



// Extract state changes from AI responses
async function extractStateFromAIResponse(
  aiResponse,
  detectedIntent,
  userSession
) {
  // Simple state extraction based on response content
  const response = aiResponse.toLowerCase();

  if (response.includes("desde qué país") || response.includes("cuál país")) {
    return { newState: SESSION_STATES.AWAITING_COUNTRY };
  }

  if (
    response.includes("cuál es el monto") ||
    response.includes("monto que deseas")
  ) {
    return { newState: SESSION_STATES.AWAITING_AMOUNT };
  }

  if (response.includes("información del beneficiario")) {
    return { newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO };
  }

  if (response.includes("comprobante") && response.includes("firmado")) {
    return { newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO };
  }

  return {};
}

// Fallback response handler
async function handleFallbackResponse(sender, messageText, userSession) {
  try {
    // Increment loop count
    userSession.data.loopCount = (userSession.data.loopCount || 0) + 1;

    // If stuck in loop, transfer to human
    if (userSession.data.loopCount > 3) {
      const message =
        "🤔 Veo que podríamos estar en un bucle. Te conectaré con un asesor humano que podrá ayudarte mejor. Un momento por favor...";
      await sock.sendMessage(sender, { text: message });
      return;
    }

    // Use original logic as fallback
    const response = await processUserMessageOriginal(
      sender,
      messageText,
      userSession
    );

    if (response && response.message) {
      await sock.sendMessage(sender, { text: response.message });

      if (response.newState) {
        userSession.state = response.newState;
      }
      if (response.sessionData) {
        userSession.data = { ...userSession.data, ...response.sessionData };
      }

      db.data.logs.push({
        sender,
        message: messageText,
        response: response.message,
        intent: response.intent || "fallback",
        method: "original_logic",
        sessionState: userSession.state,
        timestamp: new Date().toISOString(),
      });
      await db.write();
    }
  } catch (error) {
    console.error("❌ Error en fallback:", error);
    await sock.sendMessage(sender, {
      text: "Disculpa, hubo un error. Un asesor humano te atenderá en breve.",
    });
  }
}

// ==================== UTILITY FUNCTIONS ====================

function convertUSDToLocalCurrency(usdAmount, country) {
  const conversionRates = {
    dominican: 58.5, // Approximate USD to DOP
    peru: 3.7, // Approximate USD to PEN
    colombia: 4200, // Approximate USD to COP
    chile: 900, // Approximate USD to CLP
  };

  return usdAmount * (conversionRates[country] || 1);
}

// function getLocalCurrencyName(country) {
//   const currencyNames = {
//     dominican: 'pesos dominicanos',
//     peru: 'soles peruanos',
//     ecuador: 'dólares americanos',
//     colombia: 'pesos colombianos',
//     chile: 'pesos chilenos'
//   };

//   return currencyNames[country] || 'moneda local';
// }

function isNetAmountIntent(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("reciba") ||
    lower.includes("receive") ||
    lower.includes("exacto") ||
    lower.includes("exactly") ||
    lower.includes("en mano") ||
    lower.includes("que le llegue") ||
    lower.includes("que reciba")
  );
}

// ==================== ORIGINAL LOGIC (PRESERVED AS FALLBACK) ====================

async function processUserMessageOriginal(sender, messageText, userSession) {
  try {
    const lower = messageText.toLowerCase().trim();
    const currentState = userSession.state;

    switch (currentState) {
      case SESSION_STATES.INITIAL:
        return handleInitialStateOriginal(messageText, userSession);

      case SESSION_STATES.AWAITING_COUNTRY:
        return handleCountryInputOriginal(messageText, userSession);

      case SESSION_STATES.AWAITING_AMOUNT:
        return handleAmountInputOriginal(messageText, userSession);

      case SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION:
        return handleAccountConfirmationOriginal(messageText, userSession);

      case SESSION_STATES.AWAITING_TRANSFER_TYPE:
        return handleTransferTypeOriginal(messageText, userSession);

      case SESSION_STATES.CASH_DELIVERY:
        return handleCashDeliveryOriginal(messageText, userSession);

      case SESSION_STATES.AWAITING_BENEFICIARY_INFO:
        return handleBeneficiaryInfoOriginal(messageText, userSession);

      case SESSION_STATES.KYC_REQUIRED:
        return handleKYCRequiredOriginal(messageText, userSession);

      default:
        return handleInitialStateOriginal(messageText, userSession);
    }
  } catch (error) {
    console.error("❌ Error en processUserMessageOriginal:", error);
    return {
      message:
        "Disculpa, hubo un error temporal. Por favor intenta nuevamente.",
      intent: "error",
      newState: SESSION_STATES.INITIAL,
    };
  }
}

function handleInitialStateOriginal(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  console.log("🔍 Analizando mensaje inicial:", lower);

  // Enhanced rate calculation handling
  if (isRateCalculationRequest(lower)) {
    return handleRateCalculationRequest(messageText, userSession);
  }

  // Greeting
  if (
    lower.includes("hola") ||
    lower.includes("hi") ||
    lower.includes("hello") ||
    lower.includes("buenos días") ||
    lower.includes("buenas tardes") ||
    lower.includes("buenas noches") ||
    lower === "hey"
  ) {
    return {
      message: response.greeting,
      intent: "greeting",
      newState: SESSION_STATES.INITIAL,
    };
  }

  // Business hours
  if (
    lower.includes("horario") ||
    lower.includes("business hours") ||
    lower.includes("working hours") ||
    lower.includes("disponible") ||
    lower.includes("abierto") ||
    lower.includes("hours") ||
    lower.includes("available") ||
    lower.includes("open")
  ) {
    return {
      message: response.business_hours,
      intent: "business_hours",
      newState: SESSION_STATES.INITIAL,
    };
  }

  // Send money intent
  if (
    lower.includes("enviar dinero") ||
    lower.includes("quiero enviar") ||
    lower.includes("send money") ||
    lower.includes("transferir") ||
    lower.includes("mandar dinero") ||
    lower.includes("remesa")
  ) {
    return {
      message:
        "¡Perfecto! 🙌 Antes de continuar, necesito confirmar algo importante:\n\n📌 ¿Eres el titular de la cuenta bancaria desde la cual se realizará la transferencia?",
      intent: "send_money",
      newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
    };
  }

  // Daily rate
  if (
    lower.includes("tipo de cambio") ||
    lower.includes("tasa") ||
    lower.includes("rate") ||
    lower.includes("cambio del día") ||
    lower.includes("tasa del día") ||
    lower.includes("daily rate") ||
    lower.includes("exchange rate")
  ) {
    return {
      message: response.daily_rate,
      intent: "daily_rate",
    };
  }

  // Fallback
  return {
    message: response.fallback,
    intent: "fallback",
  };
}

function handleCountryInputOriginal(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();
  const country = detectCountry(lower);

  if (country) {
    return {
      message: `¡Excelente! Desde ${getCountryDisplayName(
        country
      )} 🌎\n\n📝 **Paso 2** - ¿Cuál es el monto aproximado que deseas enviar?`,
      intent: "country_detected",
      newState: SESSION_STATES.AWAITING_AMOUNT,
      sessionData: { country: country },
    };
  } else {
    return {
      message:
        "No pude identificar el país. Por favor especifica desde cuál de estos países estás enviando:\n\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile",
      intent: "country_not_detected",
      newState: SESSION_STATES.AWAITING_COUNTRY,
    };
  }
}

function handleAmountInputOriginal(messageText, userSession) {
  const amount = extractAmount(messageText);
  const country = userSession.data.country;
  const isPhysicalDelivery =
    userSession.data.physicalDelivery ||
    userSession.data.deliveryType === "physical_dollars";

  if (!amount) {
    return {
      message:
        "Por favor especifica el monto que deseas enviar. Ejemplo: 500, $300, 15000 pesos",
      intent: "amount_not_detected",
      newState: SESSION_STATES.AWAITING_AMOUNT,
    };
  }

  // Handle physical delivery calculation
  if (isPhysicalDelivery) {
    const calculation = calculatePhysicalDeliveryEnhanced(
      amount,
      country,
      false
    );

    if (calculation.success) {
      return {
        message: `${calculation.message}\n\n¿Confirmas que eres el titular de la cuenta desde la cual harás la transferencia?`,
        intent: "physical_delivery_calculated",
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
        sessionData: {
          amount: amount,
          calculation: calculation,
          deliveryType: "physical_dollars",
        },
      };
    } else {
      return {
        message: calculation.message,
        intent: "physical_delivery_error",
        newState: SESSION_STATES.INITIAL,
      };
    }
  }

  const rateInfo = calculateRate(amount, country);

  if (rateInfo.error === "rate_not_loaded" || !rateInfo.rate) {
    return {
      message:
        "😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.",
      intent: "rate_not_loaded",
      newState: SESSION_STATES.INITIAL,
    };
  }

  const needsKYC = checkKYCRequirement(amount, country);

  if (needsKYC) {
    return {
      message:
        "🚨 Veo que tu transferencia supera los $300 USD. 🔐 Por razones de seguridad, debemos verificar que eres el titular de la cuenta.\n\nPor favor verifica en este enlace:\n🔗 https://signup.metamap.com/?merchantToken=68221bbbcdc3bb0c6a37635a&flowId=68221bbb70559e84e01b01a1\n\nUna vez completada la verificación, podremos proceder con tu transferencia.",
      intent: "kyc_required",
      newState: SESSION_STATES.KYC_REQUIRED,
      sessionData: { amount: amount, rateInfo: rateInfo, kycRequired: true },
    };
  }

  return {
    message: `📊 **Resumen de tu transferencia:**\n\n💰 Monto: ${formatCurrency(
      amount,
      country
    )}\n🌎 Desde: ${getCountryDisplayName(country)}\n📈 Tasa aplicable: ${
      rateInfo.rate
    }\n💵 Recibirá aproximadamente: ${
      rateInfo.receivedAmount
    } Bs\n\n📝 **Paso 3** - ¿Cómo prefieres realizar el pago?\n\n1️⃣ **Transferencia bancaria**\n2️⃣ **Depósito en efectivo**\n\nResponde con el número de tu opción preferida.`,
    intent: "amount_processed",
    newState: SESSION_STATES.AWAITING_TRANSFER_TYPE,
    sessionData: { amount: amount, rateInfo: rateInfo },
  };
}

function handleAccountConfirmationOriginal(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  if (
    lower === "sí" ||
    lower === "si" ||
    lower === "yes" ||
    lower === "claro" ||
    lower === "por supuesto" ||
    lower === "correcto"
  ) {
    return {
      message:
        "¡Perfecto! 🙌 Entonces sigamos con estos pasos:\n\n📝 **Paso 1** - Dime desde qué país estás enviando el dinero:",
      intent: "account_confirmed",
      newState: SESSION_STATES.AWAITING_COUNTRY,
    };
  } else if (lower === "no" || lower === "nope") {
    return {
      message:
        "⚠️ Por favor recuerda que solo aceptamos pagos realizados desde cuentas a nombre del cliente que nos contacta. Esto es por razones de seguridad.\n\n¿Deseas continuar desde una cuenta personal?",
      intent: "account_not_confirmed",
      newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
    };
  } else {
    return {
      message:
        "Por favor responde con 'Sí' o 'No':\n\n📌 ¿Eres el titular de la cuenta bancaria desde la cual se realizará la transferencia?",
      intent: "account_confirmation_unclear",
      newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
    };
  }
}

// Inside MultipleFiles/bot.js

function handleTransferTypeOriginal(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  // If the user explicitly selects "1" for bank transfer here,
  // we should ensure the physicalDelivery flag is set and then
  // delegate to the handlePhysicalDeliveryRequest to continue the flow.
  if (lower === "1" || lower.includes("transferencia")) {
    // Proceed with bank transfer instructions
    return {
      message:
        "📝 **Instrucciones para Transferencia Bancaria:**\n\n**Paso 1** - Solicita las cuentas bancarias actualizadas aquí.\n\n**Paso 2** - En el concepto de la transferencia, escribe:\n📌 ENTREGAR: Nombre y apellido del destinatario + los últimos 5 dígitos de tu WhatsApp.\n\n**Paso 3** - Después de transferir, envíame:\n1️⃣ Una foto del comprobante\n2️⃣ La información del beneficiario",
      intent: "transfer_instructions",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: { transferType: "bank_transfer" },
    };
  } else if (
    lower === "2" ||
    lower.includes("depósito") ||
    lower.includes("efectivo")
  ) {
    // Proceed with cash deposit instructions
    return {
      message:
        "📝 **Instrucciones para Depósito en Efectivo:**\n\n**Paso 1** - Solicita las cuentas bancarias actualizadas aquí.\n\n**Paso 2** - Debes escribir en la boleta de depósito:\n📌 Nombre y apellido del destinatario + últimos 5 dígitos de tu WhatsApp.\n\n**Paso 3** - Después de depositar, envíame:\n1️⃣ Una foto del comprobante\n2️⃣ La información del beneficiario",
      intent: "deposit_instructions",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: { transferType: "cash_deposit" },
    };
  } else if (
    lower === "3" ||
    lower.includes("físico") ||
    lower.includes("dólares físicos") ||
    lower.includes("physical")
  ) {
    // If the user explicitly selects "3" for physical delivery here,
    // we should ensure the physicalDelivery flag is set and then
    // delegate to the handlePhysicalDeliveryRequest to continue the flow.
    userSession.data.physicalDelivery = true;
    userSession.data.deliveryType = "physical_dollars";

    const amount = userSession.data.amount;
    const country = userSession.data.country;

    // If we have amount and country, proceed to calculation
    if (amount && country) {
      // Delegate to the main physical delivery handler
      return handlePhysicalDeliveryRequest(messageText, userSession, {
        wantsPhysicalDelivery: true,
        confidence: 1.0,
        deliveryKeywords: ["físico"],
        context: "User  selected physical delivery option 3"
      });
    }

    // If amount or country is missing, ask for it via the physical delivery flow
    return {
      message:
        "💵 **Entrega de Dólares Físicos**\n\n🔒 Comisión fija: 10%\n⏱️ Tiempo: 24-48 horas\n🚚 Entrega segura a domicilio\n\nPor favor proporciona el monto y país para calcular el costo exacto.",
      intent: "physical_delivery_info_needed",
      newState: SESSION_STATES.AWAITING_AMOUNT, // Or AWAITING_COUNTRY, depending on what's missing
      sessionData: {
        physicalDelivery: true,
        deliveryType: "physical_dollars"
      }
    };
  } else {
    return {
      message:
        "Por favor selecciona una opción válida:\n\n1️⃣ **Transferencia bancaria** (Bolívares)\n2️⃣ **Depósito en efectivo** (Bolívares)\n3️⃣ **Entrega física** (Dólares USD - Comisión 10%)\n\nResponde con el número de tu opción preferida.",
      intent: "transfer_type_unclear",
      newState: SESSION_STATES.AWAITING_TRANSFER_TYPE,
    };
  }
}






// Add new function for physical delivery beneficiary info (continued)
function handlePhysicalDeliveryBeneficiaryInfo(messageText, userSession) {
  // For physical delivery, we need different information
  const hasName = messageText.toLowerCase().includes("nombre");
  const hasCedula =
    messageText.toLowerCase().includes("cédula") ||
    messageText.toLowerCase().includes("cedula");
  const hasPhone =
    messageText.toLowerCase().includes("teléfono") ||
    messageText.toLowerCase().includes("telefono") ||
    messageText.toLowerCase().includes("celular");
  const hasAddress =
    messageText.toLowerCase().includes("dirección") ||
    messageText.toLowerCase().includes("direccion") ||
    messageText.toLowerCase().includes("domicilio");

  if (hasName && hasCedula && hasPhone && hasAddress) {
    const hasReceipt = userSession.data && userSession.data.receiptReceived;

    if (hasReceipt) {
      return {
        message:
          "✅ Perfecto, información del beneficiario y comprobante recibidos.\n\n🚚 **Próximos pasos para entrega física:**\n\n1️⃣ Validaremos tu pago (15-30 min)\n2️⃣ Coordinaremos la entrega\n3️⃣ Te enviaremos datos del repartidor\n4️⃣ Entrega en 24-48 horas\n\n📱 Te mantendremos informado del proceso.",
        intent: "physical_delivery_complete",
        newState: SESSION_STATES.INITIAL,
        sessionData: {
          beneficiaryInfo: messageText,
          processComplete: true,
          deliveryScheduled: true,
        },
      };
    } else {
      return {
        message:
          "✅ Información del beneficiario recibida.\n\n📸 Ahora envía el comprobante de pago firmado con:\n✍️ Tu nombre completo + últimos 4 dígitos de tu WhatsApp\n\nEjemplo: Juan Pérez 1234",
        intent: "physical_delivery_need_receipt",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        sessionData: {
          beneficiaryInfo: messageText,
          beneficiaryComplete: true,
          physicalDeliveryInfo: true,
        },
      };
    }
  } else {
    let missingFields = [];
    if (!hasName) missingFields.push("Nombre y Apellido");
    if (!hasCedula) missingFields.push("Cédula");
    if (!hasPhone) missingFields.push("Teléfono de contacto");
    if (!hasAddress) missingFields.push("Dirección de entrega");

    return {
      message: `📋 **Para entrega física necesito:**\n\n${missingFields
        .map((field, i) => `${i + 1}️⃣ **${field}**`)
        .join(
          "\n"
        )}\n\n📌 **Formato requerido:**\n**Nombre:** [Nombre completo del beneficiario]\n**Cédula:** [Número sin puntos ni guiones]\n**Teléfono:** [Número de contacto en Venezuela]\n**Dirección:** [Dirección completa para entrega]\n\n🚚 Esta información es necesaria para coordinar la entrega física de los dólares.`,
      intent: "incomplete_physical_delivery_data",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: { partialBeneficiaryInfo: messageText },
    };
  }
}

// Update handleCashDeliveryOriginal to better handle physical delivery
function handleCashDeliveryOriginal(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();
  const country = detectCountry(lower);
  const amountInfo = intelligentAmountExtraction(messageText);

  // If both country and amount are detected
  if (country && amountInfo) {
    const calculation = calculatePhysicalDeliveryEnhanced(
      amountInfo.amount,
      country,
      false
    );

    if (calculation.success) {
      return {
        message: `✅ Perfecto, desde ${getCountryDisplayName(
          country
        )} con entrega física.\n\n${
          calculation.message
        }\n\n¿Confirmas que eres el titular de la cuenta desde la cual harás la transferencia?`,
        intent: "physical_delivery_calculated",
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
        sessionData: {
          country: country,
          amount: amountInfo.amount,
          deliveryType: "physical_dollars",
          physicalDelivery: true,
          calculation: calculation,
        },
      };
    }
  }

  if (country) {
    return {
      message: `✅ Perfecto, desde ${getCountryDisplayName(
        country
      )} con entrega de dólares físicos.\n\n🔒 **Recordatorio:** Comisión fija del 10% para logística de entrega física.\n\n💰 ¿Cuál es el monto que deseas enviar?\n\nEjemplo: "$500 USD" o "${formatCurrency(
        1000,
        country
      )}"`,
      intent: "physical_country_detected",
      newState: SESSION_STATES.AWAITING_AMOUNT,
      sessionData: {
        country: country,
        deliveryType: "physical_dollars",
        physicalDelivery: true,
      },
    };
  } else {
    return {
      message:
        "🌎 **Entrega de Dólares Físicos disponible desde:**\n\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile\n\n💵 **Características:**\n• Comisión fija: 10%\n• Tiempo: 24-48 horas\n• Entrega segura a domicilio\n\n¿Desde cuál país estás enviando?",
      intent: "physical_country_needed",
      newState: SESSION_STATES.CASH_DELIVERY,
    };
  }
}

function handleBeneficiaryInfoOriginal(messageText, userSession) {
  const isPhysicalDelivery =
    userSession.data.deliveryType === "physical_dollars" ||
    userSession.data.transferType === "physical_delivery";

  if (isPhysicalDelivery) {
    return handlePhysicalDeliveryBeneficiaryInfo(messageText, userSession);
  }

  // Simple validation for original logic
  const hasName = messageText.toLowerCase().includes("nombre");
  const hasCedula =
    messageText.toLowerCase().includes("cédula") ||
    messageText.toLowerCase().includes("cedula");
  const hasAccount = messageText.toLowerCase().includes("cuenta");
  const hasAmount =
    messageText.toLowerCase().includes("monto") ||
    messageText.toLowerCase().includes("entregar");

  if (hasName && hasCedula && hasAccount && hasAmount) {
    return {
      message:
        "✅ Información del beneficiario recibida correctamente.\n\n📋 Procederemos a validar tu pago y comenzar el proceso de transferencia.\n\n⏱️ Te notificaremos cuando esté listo.",
      intent: "beneficiary_info_complete",
      newState: SESSION_STATES.INITIAL,
      sessionData: { beneficiaryInfo: messageText, processComplete: true },
    };
  } else {
    return {
      message:
        "📋 Necesito la información completa del beneficiario:\n\n📌 **Nombre y Apellido:**\n📌 **Cédula:**\n📌 **Número de Cuenta:**\n📌 **Monto a Entregar:**\n\nPor favor envía toda la información.",
      intent: "incomplete_beneficiary_data",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
    };
  }
}

function handleKYCRequiredOriginal(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  if (
    lower.includes("completado") ||
    lower.includes("verificado") ||
    lower.includes("listo") ||
    lower.includes("done") ||
    lower.includes("terminado")
  ) {
    return {
      message:
        "✅ Excelente, hemos recibido tu verificación.\n\n📝 Ahora continuemos con el proceso de transferencia.",
      intent: "kyc_completed",
      newState: SESSION_STATES.AWAITING_TRANSFER_TYPE,
      sessionData: { kycCompleted: true },
    };
  } else {
    return {
      message:
        "Para proceder con transferencias mayores a $300 USD, necesitas completar la verificación de identidad.\n\n🔗 Por favor completa el proceso en: https://signup.metamap.com/?merchantToken=68221bbbcdc3bb0c6a37635a&flowId=68221bbb70559e84e01b01a1\n\nUna vez completado, escribe 'Completado' para continuar.",
      intent: "kyc_reminder",
      newState: SESSION_STATES.KYC_REQUIRED,
    };
  }
}

// ==================== HELPER FUNCTIONS ====================

// function convertUSDToLocalCurrency(usdAmount, country) {
//   const conversionRates = {
//     dominican: 58.5, // Approximate USD to DOP
//     peru: 3.7,       // Approximate USD to PEN
//     colombia: 4200,  // Approximate USD to COP
//     chile: 900       // Approximate USD to CLP
//   };

//   return usdAmount * (conversionRates[country] || 1);
// }

function getLocalCurrencyName(country) {
  const currencyNames = {
    dominican: "pesos dominicanos",
    peru: "soles peruanos",
    ecuador: "dólares americanos",
    colombia: "pesos colombianos",
    chile: "pesos chilenos",
  };

  return currencyNames[country] || "moneda local";
}

// function isNetAmountIntent(text) {
//   const lower = text.toLowerCase();
//   return (
//     lower.includes("reciba") ||
//     lower.includes("receive") ||
//     lower.includes("exacto") ||
//     lower.includes("exactly") ||
//     lower.includes("en mano") ||
//     lower.includes("que le llegue") ||
//     lower.includes("que reciba")
//   );
// }

// Dummy function for rate calculation request in original logic
function isRateCalculationRequest(text) {
  return text.includes("calcular tasa") || text.includes("cuanto recibo");
}

// Dummy function for handleRateCalculationRequest in original logic
function handleRateCalculationRequest(messageText, userSession) {
  return {
    message:
      "Para calcular la tasa, por favor dime el monto y el país desde donde envías. Ejemplo: '5000 pesos desde República Dominicana'.",
    intent: "rate_calculation_request",
    newState: SESSION_STATES.AWAITING_COUNTRY, // Or a more specific state if needed
    sessionData: { requestType: "rate_calculation" },
  };
}

// Add this function after the existing AI functions
async function detectPhysicalDeliveryWithAI(messageText, userSession) {
  try {
    const systemPrompt = `You are an AI assistant for Tecno Inversiones that detects when users want physical dollar delivery in Venezuela.

ANALYZE the user's message and respond with JSON:
{
  "wantsPhysicalDelivery": boolean,
  "confidence": 0.0-1.0,
  "deliveryKeywords": ["array_of_matched_keywords"],
  "context": "brief_explanation",
  "suggestedResponse": "what_to_tell_user"
}

PHYSICAL DELIVERY KEYWORDS TO DETECT:
- "cash", "efectivo", "physical dollars", "dólares físicos"
- "delivery in $", "entrega en $", "dollars in hand", "dólares en mano"
- "cash delivery", "entrega en efectivo"
- "physical", "físico", "en persona"
- "deliver cash", "entregar efectivo"
- "dollars at home", "dólares a domicilio"
- "cash pickup", "recoger efectivo"

CONTEXT CLUES:
- User mentions wanting recipient to receive actual dollars
- User asks about cash delivery options
- User mentions physical pickup or delivery
- User wants to avoid bank transfers

CURRENT SESSION: ${JSON.stringify(userSession.data || {})}
USER MESSAGE: "${messageText}"

Be precise in detection - only return true if user clearly wants physical dollar delivery.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageText },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const response = completion.choices[0].message.content;
    const parsed = JSON.parse(response);

    console.log("💵 Physical Delivery Detection:", parsed);
    return parsed;
  } catch (error) {
    console.error("❌ Error detecting physical delivery:", error);
    return {
      wantsPhysicalDelivery: false,
      confidence: 0.0,
      deliveryKeywords: [],
      context: "AI detection failed",
      suggestedResponse: "",
    };
  }
}

// Replace the existing calculateCashDeliveryEnhanced function
function calculatePhysicalDeliveryEnhanced(
  amount,
  country,
  isNetAmount = false
) {
  try {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return {
        success: false,
        message: "❌ Monto inválido. Por favor ingresa un número válido.",
      };
    }

    const PHYSICAL_DELIVERY_FEE = 0.1; // 10% fixed fee
    const countryName = getCountryDisplayName(country);

    if (isNetAmount) {
      // User wants recipient to receive exact amount
      const totalToSend = numAmount / (1 - PHYSICAL_DELIVERY_FEE);
      const feeAmount = totalToSend - numAmount;

      return {
        success: true,
        message:
          `💵 **Entrega de Dólares Físicos en Venezuela**\n\n` +
          `🎯 Para que reciban exactamente: **$${numAmount.toFixed(
            2
          )} USD**\n` +
          `📤 Debes enviar desde ${countryName}: **${formatCurrency(
            totalToSend,
            country
          )}**\n` +
          `💸 Comisión fija (10%): **$${feeAmount.toFixed(2)} USD**\n\n` +
          `🔒 **Incluye:**\n` +
          `✅ Entrega física de dólares en Venezuela\n` +
          `✅ Logística de transporte seguro\n` +
          `✅ Entrega a domicilio o punto de encuentro\n\n` +
          `⏱️ Tiempo de entrega: 24-48 horas`,
        amountToSend: totalToSend.toFixed(2),
        amountToReceive: numAmount.toFixed(2),
        feeAmount: feeAmount.toFixed(2),
        feePercentage: "10%",
        deliveryType: "physical_dollars",
        deliveryTime: "24-48 hours",
      };
    } else {
      // User specifies amount to send
      const feeAmount = numAmount * PHYSICAL_DELIVERY_FEE;
      const amountToReceive = numAmount - feeAmount;

      return {
        success: true,
        message:
          `💵 **Entrega de Dólares Físicos en Venezuela**\n\n` +
          `📤 Monto a enviar desde ${countryName}: **${formatCurrency(
            numAmount,
            country
          )}**\n` +
          `💰 Recibirán en dólares físicos: **$${amountToReceive.toFixed(
            2
          )} USD**\n` +
          `💸 Comisión fija (10%): **$${feeAmount.toFixed(2)} USD**\n\n` +
          `🔒 **Incluye:**\n` +
          `✅ Entrega física de dólares en Venezuela\n` +
          `✅ Logística de transporte seguro\n` +
          `✅ Entrega a domicilio o punto de encuentro\n\n` +
          `⏱️ Tiempo de entrega: 24-48 horas`,
        amountToSend: numAmount.toFixed(2),
        amountToReceive: amountToReceive.toFixed(2),
        feeAmount: feeAmount.toFixed(2),
        feePercentage: "10%",
        deliveryType: "physical_dollars",
        deliveryTime: "24-48 hours",
      };
    }
  } catch (error) {
    console.error("❌ Error calculating physical delivery:", error);
    return {
      success: false,
      message:
        "❌ Error calculando la entrega física. Por favor intenta nuevamente.",
    };
  }
}

// Add this function to better handle "continue" responses
function handleContinueResponse(messageText, userSession) {
  const text = messageText.toLowerCase().trim();

  // Enhanced continue detection
  const continuePatterns = [
    "yes, continue",
    "continue",
    "continuar",
    "seguir",
    "sí, continuar",
    "yes continue",
    "go ahead",
    "proceed",
    "next",
    "siguiente",
  ];

  const isContinue = continuePatterns.some(
    (pattern) =>
      text.includes(pattern) || text === "yes" || text === "sí" || text === "si"
  );

  if (
    isContinue &&
    userSession.state === SESSION_STATES.AWAITING_TRANSFER_TYPE
  ) {
    return {
      message:
        "📝 **Instrucciones para continuar:**\n\n**Paso 1** - Solicita las cuentas bancarias actualizadas aquí.\n\n**Paso 2** - En el concepto de la transferencia, escribe:\n📌 ENTREGAR: Nombre y apellido del destinatario + los últimos 5 dígitos de tu WhatsApp.\n\n**Paso 3** - Después de transferir, envíame:\n1️⃣ Una foto del comprobante firmado\n2️⃣ La información del beneficiario",
      intent: "continue_process",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: { transferType: "bank_transfer" },
    };
  }

  return null;
}

function detectCountry(text) {
  for (const [key, value] of Object.entries(countries)) {
    if (text.includes(key)) {
      return value;
    }
  }
  return null;
}

function getCountryDisplayName(countryCode) {
  return countryDisplayNames[countryCode] || countryCode;
}

function extractAmount(text) {
  const amountRegex = /\$?(\d+(?:,\d{3})*(?:\.\d{2})?)/;
  const match = text.match(amountRegex);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ""));
  }
  return null;
}

function checkKYCRequirement(amount, country) {
  if (country === "dominican") {
    return amount > 20000; // Dominican pesos
  }
  return amount > 300; // USD for other countries
}

function calculateRate(amount, country) {
  try {
    if (country === "dominican") {
      if (
        !dailyRates.dominican ||
        Object.keys(dailyRates.dominican).length === 0
      ) {
        return {
          rate: null,
          receivedAmount: null,
          error: "rate_not_loaded",
        };
      }

      for (const range of Object.values(dailyRates.dominican)) {
        if (amount >= range.min && amount <= range.max) {
          return {
            rate: range.rate,
            receivedAmount: (amount * range.rate).toFixed(2),
          };
        }
      }
      const highestRange = Object.values(dailyRates.dominican).pop();
      return {
        rate: highestRange.rate,
        receivedAmount: (amount * highestRange.rate).toFixed(2),
      };
    } else {
      const rate = dailyRates[country];
      if (!rate || rate === 0) {
        return {
          rate: null,
          receivedAmount: null,
          error: "rate_not_loaded",
        };
      }
      return {
        rate: rate,
        receivedAmount: (amount * rate).toFixed(2),
      };
    }
  } catch (error) {
    console.error("❌ Error en calculateRate:", error);
    return {
      rate: null,
      receivedAmount: null,
      error: "rate_not_loaded",
    };
  }
}

// Add function to provide rate context for physical delivery (continued)
function getDeliveryRateComparison(amount, country) {
  try {
    const rateInfo = calculateRate(amount, country);
    const physicalCalc = calculatePhysicalDeliveryEnhanced(
      amount,
      country,
      false
    );

    if (rateInfo.error || !physicalCalc.success) {
      return null;
    }

    // Convert bolivars to USD for comparison
    const usdRate = 36.5; // Approximate USD to VES rate (this should be dynamic)
    const bankTransferUSDEquivalent =
      parseFloat(rateInfo.receivedAmount) / usdRate;
    const physicalDeliveryUSD = parseFloat(physicalCalc.amountToReceive);

    return {
      bankTransfer: {
        amount: rateInfo.receivedAmount + " Bs",
        usdEquivalent: bankTransferUSDEquivalent.toFixed(2) + " USD",
        rate: rateInfo.rate,
        deliveryTime: "Inmediato",
      },
      physicalDelivery: {
        amount: physicalCalc.amountToReceive + " USD",
        fee: physicalCalc.feeAmount + " USD",
        feePercentage: "10%",
        deliveryTime: "24-48 horas",
      },
      recommendation:
        physicalDeliveryUSD > bankTransferUSDEquivalent ? "physical" : "bank",
      difference:
        Math.abs(physicalDeliveryUSD - bankTransferUSDEquivalent).toFixed(2) +
        " USD",
    };
  } catch (error) {
    console.error("❌ Error en getDeliveryRateComparison:", error);
    return null;
  }
}

// Add delivery tracking functionality
function createDeliveryTrackingNumber() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `TI-${timestamp}-${random}`.toUpperCase();
}

function schedulePhysicalDelivery(userSession, beneficiaryInfo) {
  const trackingNumber = createDeliveryTrackingNumber();
  const scheduledTime = new Date();
  scheduledTime.setHours(scheduledTime.getHours() + 24); // Schedule for 24 hours later

  userSession.data.deliveryTracking = {
    trackingNumber: trackingNumber,
    status: "scheduled",
    scheduledTime: scheduledTime.toISOString(),
    beneficiaryInfo: beneficiaryInfo,
    createdAt: new Date().toISOString(),
    estimatedDelivery: "24-48 horas",
  };

  return trackingNumber;
}

function updateDeliveryStatus(userSession, newStatus, notes = "") {
  if (userSession.data.deliveryTracking) {
    userSession.data.deliveryTracking.status = newStatus;
    userSession.data.deliveryTracking.lastUpdate = new Date().toISOString();
    userSession.data.deliveryTracking.notes = notes;

    // Log status change
    if (!userSession.data.deliveryTracking.statusHistory) {
      userSession.data.deliveryTracking.statusHistory = [];
    }

    userSession.data.deliveryTracking.statusHistory.push({
      status: newStatus,
      timestamp: new Date().toISOString(),
      notes: notes,
    });
  }
}

function formatCurrency(amount, country) {
  switch (country) {
    case "dominican":
      return `RD$${amount.toLocaleString()}`;
    case "peru":
      return `${amount.toLocaleString()} soles`;
    case "colombia":
      return `$${amount.toLocaleString()} COP`;
    case "chile":
      return `$${amount.toLocaleString()} CLP`;
    case "ecuador":
      return `$${amount.toLocaleString()} USD`;
    default:
      return `${amount.toLocaleString()}`;
  }
}

// Add this function after the existing OpenAI functions
async function analyzeReceiptImageWithAI(
  imageBuffer,
  expectedName,
  expectedDigits
) {
  try {
    // Convert image buffer to base64
    const base64Image = imageBuffer.toString("base64");

    const systemPrompt = `You are an AI assistant that analyzes receipt images to verify if they are properly signed.

ANALYZE the receipt image and respond with JSON:
{
  "isReceipt": boolean,
  "isSigned": boolean,
  "hasName": boolean,
  "hasDigits": boolean,
  "extractedText": "visible_text_on_image",
  "signatureLocation": "where_signature_appears",
  "confidence": 0.0-1.0,
  "issues": ["array_of_issues_found"],
  "recommendation": "what_user_should_do"
}

VERIFICATION CRITERIA:
1. Image must be a payment receipt/voucher
2. Must contain handwritten signature or text
3. Should have a name (preferably matching: ${expectedName || "any name"})
4. Should have 4 digits (preferably: ${expectedDigits || "any 4 digits"})
5. Signature should be clearly visible and legible

COMMON ISSUES TO DETECT:
- Blurry or unclear image
- No visible signature
- Receipt without payment details
- Missing name or digits
- Signature in wrong location

Be thorough but practical in your analysis.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please analyze this receipt image for proper signature verification.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });

    const response = completion.choices[0].message.content;
    console.log("🔍 AI Image Analysis Response:", response);

    const analysis = JSON.parse(response);
    console.log("📋 Receipt Analysis:", analysis);

    return analysis;
  } catch (error) {
    console.error("❌ Error analyzing receipt image:", error);
    return {
      isReceipt: false,
      isSigned: false,
      hasName: false,
      hasDigits: false,
      extractedText: "",
      signatureLocation: "unknown",
      confidence: 0.0,
      issues: ["AI analysis failed"],
      recommendation: "Please try again or contact support",
    };
  }
}

function handleCountrySpecificRate(country) {
  const countryName = getCountryDisplayName(country);
  let responseMessage;

  if (country === "dominican") {
    if (
      !dailyRates.dominican ||
      Object.keys(dailyRates.dominican).length === 0
    ) {
      return {
        message:
          "😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.",
        intent: "rate_not_loaded",
      };
    }

    const ranges = dailyRates.dominican;
    responseMessage = `📈 **Tasas para ${countryName} (${dailyRates.date}):**\n\n`;

    Object.entries(ranges).forEach(([key, range], index) => {
      const rangeText =
        range.max === 9999999
          ? `Más de RD$${range.min.toLocaleString()}`
          : `RD$${range.min.toLocaleString()} - RD$${range.max.toLocaleString()}`;
      responseMessage += `${index + 1}️⃣ ${rangeText}: **${range.rate} Bs**\n`;
    });

    responseMessage += `\n💡 *La tasa aplicable depende del monto que envíes*\n\n`;
    responseMessage += `¿Quieres calcular cuánto recibirás por un monto específico?`;
  } else {
    const rate = dailyRates[country];
    if (!rate || rate === 0) {
      return {
        message:
          "😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.",
        intent: "rate_not_loaded",
      };
    }
    responseMessage = `📈 **Tasa para ${countryName} (${dailyRates.date}):**\n\n`;
    responseMessage += `💵 **${rate} Bs** por cada dólar enviado\n\n`;
    responseMessage += `¿Quieres calcular cuánto recibirás por un monto específico?`;
  }

  return {
    message: responseMessage,
    intent: "country_rate_shown",
    sessionData: { country: country },
  };
}

// Add this function after the other handler functions
// Replace the existing handleImageMessage function
async function handleImageMessage(sender, imageMessage) {
  try {
    console.log("🖼️ Imagen recibida de:", sender);

    // Initialize user session if needed
    if (!db.data.userSessions[sender]) {
      db.data.userSessions[sender] = {
        state: SESSION_STATES.INITIAL,
        data: {},
        lastActivity: new Date().toISOString(),
      };
    }

    const userSession = db.data.userSessions[sender];

    // Download the image
    const imageBuffer = await downloadMedia(imageMessage);
    if (!imageBuffer) {
      await sock.sendMessage(sender, {
        text: "❌ No pude procesar la imagen. Por favor intenta enviarla nuevamente.",
      });
      return;
    }

    // Get expected user info for verification
    const expectedName = userSession.data.userName || null;
    const expectedDigits =
      userSession.data.phoneDigits || sender.split("@")[0].slice(-4);

    // Analyze image with AI
    console.log("🤖 Analizando imagen con IA...");
    await sock.sendMessage(sender, {
      text: "🔍 Analizando tu comprobante... Un momento por favor.",
    });

    const analysis = await analyzeReceiptImageWithAI(
      imageBuffer,
      expectedName,
      expectedDigits
    );

    // Process analysis results
    if (!analysis.isReceipt) {
      await sock.sendMessage(sender, {
        text: "❌ La imagen no parece ser un comprobante de pago válido.\n\n📸 Por favor envía una foto clara del comprobante de transferencia o depósito.",
      });
      return;
    }

    if (!analysis.isSigned || (!analysis.hasName && !analysis.hasDigits)) {
      let responseMessage =
        "📋 He recibido tu comprobante, pero necesito que lo firmes correctamente:\n\n";

      if (!analysis.hasName) {
        responseMessage += "❌ No veo tu nombre completo\n";
      }
      if (!analysis.hasDigits) {
        responseMessage += "❌ No veo los últimos 4 dígitos de tu WhatsApp\n";
      }

      responseMessage += `\n✍️ **Por favor firma con:** Tu Nombre Completo ${expectedDigits}\n`;
      responseMessage += `📌 **Ejemplo:** Juan Pérez ${expectedDigits}\n\n`;
      responseMessage +=
        "📸 Envía nuevamente el comprobante firmado correctamente.";

      if (analysis.recommendation) {
        responseMessage += `\n\n💡 **Sugerencia:** ${analysis.recommendation}`;
      }

      await sock.sendMessage(sender, { text: responseMessage });
      return;
    }

    // Receipt is properly signed
    console.log("✅ Comprobante verificado correctamente");

    // Update session to indicate receipt received and verified
    userSession.data.receiptReceived = true;
    userSession.data.receiptVerified = true;
    userSession.data.receiptAnalysis = analysis;
    userSession.lastActivity = new Date().toISOString();

    // Check if we already have beneficiary info
    const hasBeneficiary = userSession.data.beneficiaryComplete;

    if (hasBeneficiary) {
      await sock.sendMessage(sender, {
        text: "✅ ¡Excelente! Comprobante verificado correctamente y la información del beneficiario está completa.\n\n📋 Procederemos a validar tu pago y comenzar el proceso de transferencia.\n\n⏱️ Te notificaremos cuando esté listo. Normalmente toma entre 15-30 minutos.\n\n¿Hay algo más en lo que pueda ayudarte?",
      });

      userSession.state = SESSION_STATES.INITIAL;
      userSession.data.processComplete = true;
    } else {
      await sock.sendMessage(sender, {
        text: "✅ ¡Perfecto! Comprobante verificado correctamente.\n\nAhora necesito la información del beneficiario:\n\n📌 **Nombre y Apellido:**\n📌 **Cédula:**\n📌 **Número de Cuenta:**\n📌 **Monto a Entregar:**\n\nPor favor envía toda la información completa.",
      });

      userSession.state = SESSION_STATES.AWAITING_BENEFICIARY_INFO;
    }

    // Log the successful verification
    db.data.logs.push({
      sender,
      action: "receipt_verified_ai",
      analysis: analysis,
      timestamp: new Date().toISOString(),
      sessionState: userSession.state,
      method: "ai_vision",
    });

    await db.write();
  } catch (error) {
    console.error("❌ Error manejando imagen:", error);
    await sock.sendMessage(sender, {
      text: "❌ Hubo un error procesando la imagen. Por favor intenta nuevamente o contacta a un asesor.",
    });
  }
}

function calculateCashDeliveryEnhanced(
  amount,
  isNetAmount = false,
  country = null
) {
  try {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return {
        success: false,
        message: "❌ Monto inválido. Por favor ingresa un número válido.",
      };
    }

    const commission = 0.1; // 10% commission

    if (isNetAmount) {
      const totalToSend = numAmount / (1 - commission);
      const commissionAmount = totalToSend - numAmount;

      return {
        success: true,
        message: `🧮 **Cálculo de Entrega en Efectivo:**\n\n💰 Para que reciban exactamente: **${formatCurrency(
          numAmount,
          country
        )}**\n📤 Debes enviar: **${formatCurrency(
          totalToSend,
          country
        )}**\n💸 Comisión (10%): **${formatCurrency(
          commissionAmount,
          country
        )}**\n\n✅ Confirmado con comisión del 10% para logística de entrega física.`,
        amountToSend: totalToSend.toFixed(2),
        amountToReceive: numAmount.toFixed(2),
        commission: commissionAmount.toFixed(2),
        commissionPercentage: "10%",
      };
    } else {
      const commissionAmount = numAmount * commission;
      const amountToReceive = numAmount - commissionAmount;

      return {
        success: true,
        message: `🧮 **Cálculo de Entrega en Efectivo:**\n\n📤 Monto a enviar: **${formatCurrency(
          numAmount,
          country
        )}**\n💰 Recibirán: **${formatCurrency(
          amountToReceive,
          country
        )}**\n💸 Comisión (10%): **${formatCurrency(
          commissionAmount,
          country
        )}**\n\n✅ Después de aplicar la comisión del 10% para logística de entrega física.`,
        amountToSend: numAmount.toFixed(2),
        amountToReceive: amountToReceive.toFixed(2),
        commission: commissionAmount.toFixed(2),
        commissionPercentage: "10%",
      };
    }
  } catch (error) {
    console.error("❌ Error en calculateCashDeliveryEnhanced:", error);
    return {
      success: false,
      message:
        "❌ Error calculando la entrega en efectivo. Por favor intenta nuevamente.",
    };
  }
}

// Add this function to download media from WhatsApp
async function downloadMedia(messageMedia) {
  try {
    const buffer = await downloadMediaMessage(
      { message: { imageMessage: messageMedia } },
      "buffer",
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      }
    );
    return buffer;
  } catch (error) {
    console.error("❌ Error downloading media:", error);
    return null;
  }
}

// ==================== QR CODE MANAGEMENT ====================

async function forceQRRegeneration() {
  try {
    console.log(
      "🔄 Forzando regeneración de QR para mantener validez de 24 horas..."
    );

    if (qrExpirationTimeout) {
      clearTimeout(qrExpirationTimeout);
      qrExpirationTimeout = null;
    }

    if (global.currentQRPublicId) {
      try {
        await cloudinary.uploader.destroy(global.currentQRPublicId);
        console.log("🗑️ QR anterior eliminado de Cloudinary");
      } catch (error) {
        console.log("⚠️ No se pudo eliminar el QR anterior:", error.message);
      }
    }

    currentQRCode = null;
    qrGenerationTime = null;
    qrGenerated = false;

    if (sock) {
      sock.end();
    }

    setTimeout(() => {
      connectToWhatsApp();
    }, 3000);
  } catch (error) {
    console.error("❌ Error forzando regeneración de QR:", error);
    qrGenerated = false;
  }
}

function checkQRValidityAndRefresh() {
  if (qrGenerationTime && currentQRCode && qrGenerated) {
    const now = Date.now();
    const timeSinceGeneration = now - qrGenerationTime;
    const timeUntilExpiry = QR_VALIDITY_DURATION - timeSinceGeneration;
    const hoursLeft = Math.round(timeUntilExpiry / (1000 * 60 * 60));
    const minutesLeft = Math.round(timeUntilExpiry / (1000 * 60));

    console.log(
      `⏰ QR válido por ${
        hoursLeft > 0 ? hoursLeft + " horas" : minutesLeft + " minutos"
      } más`
    );

    if (timeUntilExpiry <= 60 * 60 * 1000) {
      console.log(
        "🔄 QR próximo a expirar en 1 hora, preparando renovación..."
      );
      setTimeout(() => {
        forceQRRegeneration();
      }, 5000);
    }

    if (timeUntilExpiry <= 0) {
      console.log("⚠️ QR expirado, regenerando inmediatamente...");
      forceQRRegeneration();
    }
  }
}

// ==================== WHATSAPP CONNECTION ====================

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      browser: ["Ubuntu", "Chrome", "22.04"],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, qr }) => {
        if (qr && !qrGenerated) {
          console.log("📲 Generando código QR válido por 24 horas...");
          qrGenerated = true;
          currentQRCode = qr;
          qrGenerationTime = Date.now();

          try {
            const qrBuffer = await QRCode.toBuffer(qr, {
              color: {
                dark: "#000000",
                light: "#FFFFFF",
              },
              width: 512,
              type: "png",
            });

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const expirationTime = new Date(Date.now() + QR_VALIDITY_DURATION);

            const uploadResult = await new Promise((resolve, reject) => {
              cloudinary.uploader
                .upload_stream(
                  {
                    resource_type: "image",
                    public_id: `whatsapp-qr-${timestamp}`,
                    folder: "whatsapp-qr",
                    overwrite: true,
                    context: {
                      generated_at: new Date().toISOString(),
                      expires_at: expirationTime.toISOString(),
                      validity_hours: "24",
                    },
                  },
                  (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                  }
                )
                .end(qrBuffer);
            });

            console.log(`✅ Código QR subido exitosamente a Cloudinary`);
            console.log(`🔗 URL del QR: ${uploadResult.secure_url}`);
            console.log(
              `⏰ QR válido hasta: ${expirationTime.toLocaleString()}`
            );

            global.currentQRPublicId = uploadResult.public_id;
            global.currentQRUrl = uploadResult.secure_url;

            if (qrExpirationTimeout) {
              clearTimeout(qrExpirationTimeout);
            }

            qrExpirationTimeout = setTimeout(() => {
              console.log(
                "⏰ QR expirado después de 24 horas, generando nuevo QR..."
              );
              qrGenerated = false;
              forceQRRegeneration();
            }, QR_VALIDITY_DURATION);

            if (!qrRegenerationInterval) {
              qrRegenerationInterval = setInterval(
                checkQRValidityAndRefresh,
                QR_REFRESH_INTERVAL
              );
              console.log(
                "⏰ Sistema de monitoreo de QR iniciado (cada 10 minutos)"
              );
            }
          } catch (error) {
            console.error(
              "❌ Error generando/subiendo QR a Cloudinary:",
              error
            );
            qrGenerated = false;
            try {
              qrcode.generate(qr, { small: true });
            } catch (terminalError) {
              console.error(
                "❌ Error mostrando QR en terminal:",
                terminalError
              );
            }
          }
        } else if (qr && qrGenerated) {
          console.log(
            "⏭️ QR ya generado, ignorando nueva generación automática"
          );
        }

        if (connection === "open") {
          console.log("✅ ¡Conexión de WhatsApp establecida!");

          if (qrRegenerationInterval) {
            clearInterval(qrRegenerationInterval);
            qrRegenerationInterval = null;
            console.log("⏰ Sistema de monitoreo de QR detenido");
          }

          if (qrExpirationTimeout) {
            clearTimeout(qrExpirationTimeout);
            qrExpirationTimeout = null;
          }

          qrGenerationTime = null;
          currentQRCode = null;
          qrGenerated = false;

          printShareableLink();
        } else if (connection === "close") {
          console.log("❌ Conexión de WhatsApp cerrada");
          qrGenerated = false;

          const shouldRestart =
            lastDisconnect?.error?.output?.statusCode !==
            DisconnectReason.loggedOut;

          if (shouldRestart && shouldReconnect) {
            console.log("🔄 Intentando reconectar en 5 segundos...");
            setTimeout(() => {
              connectToWhatsApp();
            }, 5000);
          } else {
            console.log(
              "🛑 Bot detenido. Reinicia manualmente si es necesario."
            );

            if (qrRegenerationInterval) {
              clearInterval(qrRegenerationInterval);
              qrRegenerationInterval = null;
            }
            if (qrExpirationTimeout) {
              clearTimeout(qrExpirationTimeout);
              qrExpirationTimeout = null;
            }
          }
        } else if (connection === "connecting") {
          console.log("🔄 Conectando a WhatsApp...");
        }
      }
    );

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log("📨 Evento de mensaje recibido:", {
        type,
        messageCount: messages.length,
      });

      if (type !== "notify") {
        console.log("⏭️ Omitiendo tipo de mensaje no-notify:", type);
        return;
      }

      for (const msg of messages) {
        try {
          const sender = msg.key.remoteJid;
          if (!msg.message || msg.key.fromMe) {
            continue;
          }

          const messageText =
            msg.message?.conversation || msg.message?.extendedTextMessage?.text;
          const imageMessage = msg.message?.imageMessage;

          if (messageText) {
            console.log(
              "🚀 Manejando mensaje de texto del usuario desde:",
              sender
            );
            await handleUserMessage(sender, messageText);
          } else if (imageMessage) {
            console.log("🖼️ Manejando imagen del usuario desde:", sender);
            await handleImageMessage(sender, imageMessage);
          }
        } catch (error) {
          console.error("❌ Error manejando mensaje:", error);
        }
      }
    });
  } catch (error) {
    console.error("Error conectando a WhatsApp:", error);
    if (shouldReconnect) {
      console.log("🔄 Reintentando conexión en 10 segundos...");
      setTimeout(() => {
        connectToWhatsApp();
      }, 10000);
    }
  }
}

// ==================== ADMIN COMMANDS ====================

process.stdin.on("data", async (data) => {
  const cmd = data.toString().trim();

  if (cmd === "rate" || cmd === "tasa") {
    // ... existing code ...
  } else if (cmd === "stats" || cmd === "estadisticas") {
    // ... existing code ...
  } else if (cmd === "human-queue" || cmd === "cola-humana") {
    try {
      const analytics = getHumanAssistanceAnalytics();

      console.log("\n👥 COLA DE ASISTENCIA HUMANA");
      console.log("============================");
      console.log(`⏳ Usuarios esperando: ${analytics.waiting.length}`);
      console.log(`✅ Casos resueltos: ${analytics.resolved}`);
      console.log(`📊 Total casos: ${analytics.totalCases}`);
      console.log(
        `⏱️ Tiempo promedio espera: ${analytics.averageWaitTime} min`
      );

      if (analytics.waiting.length > 0) {
        console.log("\n🔍 USUARIOS ESPERANDO:");
        analytics.waiting.forEach((user, index) => {
          console.log(`${index + 1}. 📱 ${user.userId}`);
          console.log(`   ⏰ Esperando: ${user.waitingTime} min`);
          console.log(`   📝 Razón: ${user.reason}`);
          console.log(`   📊 Categoría: ${user.category}`);
          console.log(`   ⚡ Urgencia: ${user.urgency}`);
          console.log(
            `   💬 Mensaje: "${user.originalMessage?.substring(0, 50)}..."`
          );
          console.log("");
        });
      }

      console.log("\n📈 ESTADÍSTICAS POR CATEGORÍA:");
      Object.entries(analytics.categoryBreakdown).forEach(
        ([category, count]) => {
          console.log(`   ${category}: ${count}`);
        }
      );

      console.log("\n⚡ ESTADÍSTICAS POR URGENCIA:");
      Object.entries(analytics.urgencyBreakdown).forEach(([urgency, count]) => {
        console.log(`   ${urgency}: ${count}`);
      });

      console.log("============================\n");
    } catch (error) {
      console.error("Error mostrando cola humana:", error);
    }
  } else if (cmd.startsWith("resolve ") || cmd.startsWith("resolver ")) {
    try {
      const parts = cmd.split(" ");
      const userId = parts[1];
      const message = parts.slice(2).join(" ") || "Issue resolved by admin";

      if (!userId) {
        console.log("❌ Uso: resolve <userId> [mensaje]");
        return;
      }

      // Find user session
      const fullUserId = Object.keys(db.data.userSessions || {}).find((id) =>
        id.includes(userId)
      );

      if (!fullUserId) {
        console.log(`❌ Usuario ${userId} no encontrado`);
        return;
      }

      const userSession = db.data.userSessions[fullUserId];
      if (!isUserWaitingForHuman(userSession)) {
        console.log(`❌ Usuario ${userId} no está esperando asistencia humana`);
        return;
      }

      const resolved = await resolveHumanAssistance(
        fullUserId,
        userSession,
        message
      );
      if (resolved) {
        console.log(`✅ Caso resuelto para usuario ${userId}`);
      } else {
        console.log(`❌ Error resolviendo caso para usuario ${userId}`);
      }
    } catch (error) {
      console.error("Error resolviendo caso:", error);
    }
  } else if (cmd === "resolve-all" || cmd === "resolver-todos") {
    try {
      const analytics = getHumanAssistanceAnalytics();
      let resolved = 0;

      for (const user of analytics.waiting) {
        const userSession = db.data.userSessions[user.fullId];
        if (userSession && isUserWaitingForHuman(userSession)) {
          const success = await resolveHumanAssistance(
            user.fullId,
            userSession,
            "Bulk resolution by admin"
          );
          if (success) resolved++;

          // Small delay to avoid overwhelming
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      console.log(`✅ ${resolved} casos resueltos en lote`);
    } catch (error) {
      console.error("Error resolviendo casos en lote:", error);
    }
  } else if (cmd === "human-stats" || cmd === "estadisticas-humanas") {
    try {
      const analytics = getHumanAssistanceAnalytics();
      const humanLogs = db.data.logs.filter(
        (log) => log.action && log.action.includes("human")
      );

      console.log("\n📊 ESTADÍSTICAS DETALLADAS DE ASISTENCIA HUMANA");
      console.log("===============================================");
      console.log(
        `👥 Total transferencias a humanos: ${
          humanLogs.filter((l) => l.action.includes("transfer")).length
        }`
      );
      console.log(
        `✅ Total resoluciones: ${
          humanLogs.filter((l) => l.action.includes("resolved")).length
        }`
      );
      console.log(
        `⏳ Usuarios actualmente esperando: ${analytics.waiting.length}`
      );
      console.log(
        `⏱️ Tiempo promedio de espera: ${analytics.averageWaitTime} min`
      );

      // Calculate resolution rate
      const transfers = humanLogs.filter((l) =>
        l.action.includes("transfer")
      ).length;
      const resolutions = humanLogs.filter((l) =>
        l.action.includes("resolved")
      ).length;
      const resolutionRate =
        transfers > 0 ? ((resolutions / transfers) * 100).toFixed(1) : 0;
      console.log(`📈 Tasa de resolución: ${resolutionRate}%`);

      console.log("\n🏷️ RAZONES MÁS COMUNES:");
      const reasons = {};
      humanLogs.forEach((log) => {
        if (log.aiAnalysis && log.aiAnalysis.reason) {
          reasons[log.aiAnalysis.reason] =
            (reasons[log.aiAnalysis.reason] || 0) + 1;
        }
      });

      Object.entries(reasons)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([reason, count]) => {
          console.log(`   ${reason}: ${count}`);
        });

      console.log("===============================================\n");
    } catch (error) {
      console.error("Error mostrando estadísticas humanas:", error);
    }
  } else if (cmd === "help" || cmd === "ayuda") {
    console.log("\n🤖 COMANDOS DISPONIBLES");
    console.log("=======================");
    console.log("rate/tasa - Enviar tasa a todos los usuarios");
    console.log("stats/estadisticas - Mostrar estadísticas");
    console.log("sessions/sesiones - Mostrar sesiones activas");
    console.log("reset/reiniciar - Reiniciar todas las sesiones");
    console.log("reload-rates/recargar-tasas - Recargar tasas del día");
    console.log("qr-status/estado-qr - Ver estado del QR actual");
    console.log("regenerate-qr/regenerar-qr - Forzar regeneración de QR");
    console.log("ai-stats/estadisticas-ai - Estadísticas de IA");
    console.log("human-queue/cola-humana - Ver cola de asistencia humana");
    console.log("resolve <userId> [mensaje] - Resolver caso específico");
    console.log(
      "resolve-all/resolver-todos - Resolver todos los casos pendientes"
    );
    console.log(
      "human-stats/estadisticas-humanas - Estadísticas detalladas de asistencia humana"
    );
    console.log("help/ayuda - Mostrar esta ayuda");
    console.log("=======================\n");
  } else if (cmd === "ai-stats" || cmd === "estadisticas-ai") {
    try {
      const aiLogs = db.data.logs.filter(
        (log) => log.method && log.method.includes("ai")
      );
      const totalAIInteractions = aiLogs.length;
      const aiMethods = {};
      const aiIntents = {};

      aiLogs.forEach((log) => {
        aiMethods[log.method] = (aiMethods[log.method] || 0) + 1;
        aiIntents[log.intent] = (aiIntents[log.intent] || 0) + 1;
      });

      console.log("\n🤖 ESTADÍSTICAS DE IA");
      console.log("=====================");
      console.log(`🔢 Total interacciones con IA: ${totalAIInteractions}`);
      console.log(`📊 Métodos más usados:`);
      Object.entries(aiMethods)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([method, count]) => {
          console.log(`   ${method}: ${count}`);
        });
      console.log(`🎯 Intents más detectados:`);
      Object.entries(aiIntents)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([intent, count]) => {
          console.log(`   ${intent}: ${count}`);
        });
      console.log("=====================\n");
    } catch (error) {
      console.error("Error mostrando estadísticas de IA:", error);
    }
  } else if (cmd === "delivery-stats" || cmd === "estadisticas-entrega") {
    try {
      const physicalDeliveries = db.data.logs.filter(
        (log) =>
          log.sessionData &&
          (log.sessionData.deliveryType === "physical_dollars" ||
            log.sessionData.transferType === "physical_delivery")
      );

      const bankTransfers = db.data.logs.filter(
        (log) =>
          log.sessionData &&
          (log.sessionData.transferType === "bank_transfer" ||
            log.sessionData.deliveryType === "bank_transfer")
      );

      console.log("\n📊 ESTADÍSTICAS DE ENTREGA");
      console.log("==========================");
      console.log(`🚚 Entregas físicas: ${physicalDeliveries.length}`);
      console.log(`🏦 Transferencias bancarias: ${bankTransfers.length}`);
      console.log(
        `📈 Total transacciones: ${
          physicalDeliveries.length + bankTransfers.length
        }`
      );

      if (physicalDeliveries.length > 0) {
        const physicalPercentage = (
          (physicalDeliveries.length /
            (physicalDeliveries.length + bankTransfers.length)) *
          100
        ).toFixed(1);
        console.log(`💵 % Entregas físicas: ${physicalPercentage}%`);

        // Calculate average amounts for physical deliveries
        const physicalAmounts = physicalDeliveries
          .filter((log) => log.sessionData && log.sessionData.amount)
          .map((log) => parseFloat(log.sessionData.amount));

        if (physicalAmounts.length > 0) {
          const avgPhysical = (
            physicalAmounts.reduce((a, b) => a + b, 0) / physicalAmounts.length
          ).toFixed(2);
          console.log(`💰 Monto promedio físico: $${avgPhysical}`);
        }
      }

      console.log("==========================\n");
    } catch (error) {
      console.error("Error mostrando estadísticas de entrega:", error);
    }
  } else if (cmd === "physical-queue" || cmd === "cola-fisica") {
    try {
      const physicalDeliveries = [];

      if (db.data.userSessions) {
        Object.entries(db.data.userSessions).forEach(([userId, session]) => {
          if (
            session.data &&
            (session.data.deliveryType === "physical_dollars" ||
              session.data.transferType === "physical_delivery" ||
              session.data.physicalDelivery === true)
          ) {
            physicalDeliveries.push({
              userId: userId.split("@")[0],
              fullId: userId,
              state: session.state,
              amount: session.data.amount,
              country: session.data.country,
              deliveryScheduled: session.data.deliveryScheduled || false,
              processComplete: session.data.processComplete || false,
              lastActivity: session.lastActivity,
            });
          }
        });
      }

      console.log("\n🚚 COLA DE ENTREGAS FÍSICAS");
      console.log("============================");
      console.log(`📦 Total entregas físicas: ${physicalDeliveries.length}`);

      if (physicalDeliveries.length > 0) {
        const pending = physicalDeliveries.filter((d) => !d.processComplete);
        const completed = physicalDeliveries.filter((d) => d.processComplete);

        console.log(`⏳ Pendientes: ${pending.length}`);
        console.log(`✅ Completadas: ${completed.length}`);

        if (pending.length > 0) {
          console.log("\n🔍 ENTREGAS PENDIENTES:");
          pending.forEach((delivery, index) => {
            console.log(`${index + 1}. 📱 ${delivery.userId}`);
            console.log(
              `   💰 Monto: ${
                delivery.amount
                  ? formatCurrency(delivery.amount, delivery.country)
                  : "N/A"
              }`
            );
            console.log(
              `   🌎 País: ${
                delivery.country
                  ? getCountryDisplayName(delivery.country)
                  : "N/A"
              }`
            );
            console.log(`   📊 Estado: ${delivery.state}`);
            console.log(
              `   🚚 Programada: ${delivery.deliveryScheduled ? "Sí" : "No"}`
            );
            console.log(
              `   ⏰ Última actividad: ${
                delivery.lastActivity
                  ? new Date(delivery.lastActivity).toLocaleString()
                  : "N/A"
              }`
            );
            console.log("");
          });
        }
      }

      console.log("============================\n");
    } catch (error) {
      console.error("Error mostrando cola de entregas físicas:", error);
    }
  } else if (
    cmd.startsWith("complete-delivery ") ||
    cmd.startsWith("completar-entrega ")
  ) {
    try {
      const parts = cmd.split(" ");
      const userId = parts[1];

      if (!userId) {
        console.log("❌ Uso: complete-delivery <userId>");
        return;
      }

      const fullUserId = Object.keys(db.data.userSessions || {}).find((id) =>
        id.includes(userId)
      );

      if (!fullUserId) {
        console.log(`❌ Usuario ${userId} no encontrado`);
        return;
      }

      const userSession = db.data.userSessions[fullUserId];
      if (!userSession.data || !userSession.data.physicalDelivery) {
        console.log(`❌ Usuario ${userId} no tiene entrega física programada`);
        return;
      }

      // Mark delivery as completed
      userSession.data.deliveryCompleted = true;
      userSession.data.deliveryCompletedTime = new Date().toISOString();
      userSession.state = SESSION_STATES.INITIAL;

      // Send notification to user
      await sock.sendMessage(fullUserId, {
        text: "✅ ¡Entrega completada exitosamente!\n\n🎉 Los dólares han sido entregados al beneficiario.\n\n📱 Gracias por confiar en Tecno Inversiones. ¿Hay algo más en lo que pueda ayudarte?",
      });

      // Log the completion
      db.data.logs.push({
        sender: fullUserId,
        action: "physical_delivery_completed",
        completedBy: "admin",
        timestamp: new Date().toISOString(),
        sessionData: userSession.data,
      });

      await db.write();
      console.log(`✅ Entrega física completada para usuario ${userId}`);
    } catch (error) {
      console.error("Error completando entrega física:", error);
    }
  }
});
// ==================== CLEANUP FUNCTIONS ====================

async function cleanOldSessions() {
  try {
    if (!db.data || !db.data.userSessions) return;

    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const initialCount = Object.keys(db.data.userSessions).length;

    for (const [userId, session] of Object.entries(db.data.userSessions)) {
      if (session.lastActivity && new Date(session.lastActivity) < oneDayAgo) {
        delete db.data.userSessions[userId];
      }
    }

    const removedCount =
      initialCount - Object.keys(db.data.userSessions).length;
    if (removedCount > 0) {
      await db.write();
      console.log(`🧹 Limpiadas ${removedCount} sesiones antiguas`);
    }
  } catch (error) {
    console.error("❌ Error limpiando sesiones antiguas:", error);
  }
}

async function cleanOldLogs() {
  try {
    if (!db.data || !db.data.logs) return;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const initialCount = db.data.logs.length;
    db.data.logs = db.data.logs.filter(
      (log) => log.timestamp && new Date(log.timestamp) > thirtyDaysAgo
    );

    const removedCount = initialCount - db.data.logs.length;
    if (removedCount > 0) {
      await db.write();
      console.log(`🧹 Limpiados ${removedCount} logs antiguos`);
    }
  } catch (error) {
    console.error("❌ Error limpiando logs antiguos:", error);
  }
}

async function cleanupOldQRCodes() {
  try {
    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: "whatsapp-qr/",
      max_results: 100,
    });

    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    for (const resource of result.resources) {
      const createdAt = new Date(resource.created_at);
      if (createdAt < oneDayAgo) {
        await cloudinary.uploader.destroy(resource.public_id);
        console.log(`🧹 QR antiguo eliminado: ${resource.public_id}`);
      }
    }
  } catch (error) {
    console.error("❌ Error limpiando QRs antiguos:", error);
  }
}

function createTodayRateFile() {
  const today = new Date().toISOString().split("T")[0];
  const ratesFile = `./rates/${today}.json`;

  if (!fs.existsSync("./rates")) {
    fs.mkdirSync("./rates", { recursive: true });
  }

  if (!fs.existsSync(ratesFile)) {
    const defaultRates = {
      date: today,
      dominican: {
        range1: { min: 0, max: 2000, rate: 2.11944 },
        range2: { min: 2001, max: 10000, rate: 2.11991 },
        range3: { min: 10001, max: 20000, rate: 2.12061 },
        range4: { min: 20001, max: 9999999, rate: 2.12085 },
      },
      peru: 35.13,
      ecuador: 128.22,
      colombia: 31.038,
      chile: 0.136,
    };

    try {
      fs.writeFileSync(ratesFile, JSON.stringify(defaultRates, null, 2));
      console.log(`✅ Archivo de tasas creado para ${today}`);
    } catch (error) {
      console.error(`❌ Error creando archivo de tasas para ${today}:`, error);
    }
  }
}

function checkAndReloadRates() {
  const today = new Date().toISOString().split("T")[0];
  if (dailyRates.date !== today) {
    console.log(
      `🔄 Detectado cambio de fecha. Recargando tasas para ${today}...`
    );
    try {
      createTodayRateFile();
      dailyRates = loadDailyRates();
      console.log("✅ Tasas recargadas automáticamente");
    } catch (error) {
      console.error("❌ Error recargando tasas automáticamente:", error);
    }
  }
}

function printShareableLink() {
  const phone = process.env.WHATSAPP_NUMBER;
  const message = encodeURIComponent(process.env.DEFAULT_MESSAGE || "Hola");
  const link = `https://wa.me/${phone}?text=${message}`;
  console.log("\n🔗 Comparte este enlace de WhatsApp con los clientes:");
  console.log(link + "\n");
}

// ==================== GRACEFUL SHUTDOWN ====================

process.on("SIGINT", () => {
  console.log("\n🛑 Cerrando bot de manera elegante...");
  shouldReconnect = false;
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

// ==================== STARTUP AND INTERVALS ====================

// Run cleanup every 6 hours
setInterval(cleanupOldQRCodes, 6 * 60 * 60 * 1000);
setInterval(cleanOldSessions, 6 * 60 * 60 * 1000);
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
setInterval(checkAndReloadRates, 60 * 60 * 1000);

// Create today's rate file on startup
createTodayRateFile();

// Enhanced startup logging
console.log("🚀 Iniciando Bot de WhatsApp de Tecno Inversiones...");
console.log("📋 Respuestas configuradas:", Object.keys(response).length);
console.log("🌐 Idioma: Español");
console.log("🤖 IA: OpenAI GPT-3.5-turbo integrado");
console.log("📱 Funcionalidades: Fase 2 - IA conversacional avanzada");
console.log("💾 Base de datos: Inicializada con sesiones de usuario");
console.log(
  "🔄 Estados de sesión disponibles:",
  Object.values(SESSION_STATES).length
);
console.log("📈 Tasas cargadas para:", dailyRates.date);
console.log("🗂️ Países soportados:", Object.keys(countries).length);
console.log("🤖 Detección emocional: Activada");
console.log("🔐 Verificación KYC: Configurada");
console.log("💰 Cálculos de efectivo: Habilitados");
console.log("📊 Sistema de logs: Activo");
console.log("🧹 Limpieza automática: Programada");
console.log("🎯 Detección de intents con IA: Habilitada");
console.log("📝 Extracción de entidades: Configurada");
console.log("🔄 Fallback a lógica original: Implementado");
console.log("⚡ Transferencia automática a humanos: Activa");

// Start the WhatsApp connection
connectToWhatsApp();

// ==================== EXPORT FOR TESTING ====================

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    // Core AI functions
    detectIntentWithOpenAI, // Renamed from detectIntentWithAI
    // extractEntitiesWithAI, // This function is now integrated into detectIntentWithOpenAI and other handlers
    generateContextualResponse, // Renamed from generateAIResponse

    // Enhanced handlers
    handleAIBeneficiaryInfo,
    handleAIReceiptSubmission,
    handleAICashDelivery,

    // Utility functions
    // detectEmotionalState, // This is now part of detectIntentWithOpenAI's output
    calculateRate,
    // validateBeneficiaryInfo, // Integrated into handleAIBeneficiaryInfo
    // detectReceiptMessage, // Integrated into handleAIReceiptSubmission
    // isReceiptProperlySigned, // Integrated into handleAIReceiptSubmission
    // handleRateSituation, // Integrated into handleAIRateCheck and handleCountrySpecificRate
    calculateCashDeliveryEnhanced,
    extractAmount,
    detectCountry,
    getCountryDisplayName,
    checkKYCRequirement,
    formatCurrency,
    isNetAmountIntent,

    // Business logic
    // handleHighAmountVerification, // Integrated into handleAmountInputOriginal and handleAISendMoney
    // handleBusinessInquiries, // Handled by general intent detection
    // handleComplaintOrIssue, // Handled by human assistance detection
    // handleSecurityConcerns, // Handled by KYC and account ownership
    // detectUrgentRequest, // Handled by human assistance detection

    // QR management
    forceQRRegeneration,
    checkQRValidityAndRefresh,

    // Database functions
    cleanOldSessions,
    cleanOldLogs,
    cleanupOldQRCodes,

    // Rate management
    loadDailyRates,
    createTodayRateFile,
    checkAndReloadRates,

    // Session management
    SESSION_STATES,

    // Original logic (fallback)
    processUserMessageOriginal,
    handleInitialStateOriginal,
    handleCountryInputOriginal,
    handleAmountInputOriginal,
    handleAccountConfirmationOriginal,
    handleTransferTypeOriginal,
    handleCashDeliveryOriginal,
    handleBeneficiaryInfoOriginal,
    handleKYCRequiredOriginal,
  };
}

// ==================== ADDITIONAL HELPER FUNCTIONS ====================

function logAIInteraction(
  sender,
  messageText,
  aiResponse,
  method,
  intent,
  entities
) {
  const logEntry = {
    sender,
    message: messageText,
    response: aiResponse,
    method: method,
    intent: intent,
    entities: entities,
    timestamp: new Date().toISOString(),
    messageLength: messageText.length,
    responseLength: aiResponse.length,
  };

  if (!db.data.aiLogs) {
    db.data.aiLogs = [];
  }

  db.data.aiLogs.push(logEntry);

  console.log("🤖 Interacción de IA registrada:", {
    usuario: sender.split("@")[0],
    método: method,
    intent: intent,
    entidades: Object.keys(entities || {}).length,
    timestamp: logEntry.timestamp,
  });
}

function getAIStats() {
  if (!db.data.aiLogs) return null;

  const totalInteractions = db.data.aiLogs.length;
  const methods = {};
  const intents = {};
  const today = new Date().toISOString().split("T")[0];
  const todayInteractions = db.data.aiLogs.filter(
    (log) => log.timestamp && log.timestamp.startsWith(today)
  ).length;

  db.data.aiLogs.forEach((log) => {
    methods[log.method] = (methods[log.method] || 0) + 1;
    intents[log.intent] = (intents[log.intent] || 0) + 1;
  });

  return {
    totalInteractions,
    todayInteractions,
    topMethods: Object.entries(methods)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5),
    topIntents: Object.entries(intents)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5),
  };
}

function validateEnvironmentVariables() {
  const required = [
    "OPENAI_API_KEY",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error("❌ Variables de entorno faltantes:", missing);
    console.error("Por favor configura estas variables en tu archivo .env");
    process.exit(1);
  }

  console.log("✅ Variables de entorno validadas correctamente");
}

function initializeDirectories() {
  const directories = ["./rates", "./auth", "./logs"];

  directories.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Directorio creado: ${dir}`);
    }
  });
}

function setupErrorHandlers() {
  process.on("uncaughtException", (error) => {
    console.error("❌ Excepción no capturada:", error);
    console.error("Stack:", error.stack);

    // Log to file if possible
    try {
      const errorLog = {
        type: "uncaughtException",
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      };

      if (!fs.existsSync("./logs")) {
        fs.mkdirSync("./logs", { recursive: true });
      }

      fs.appendFileSync("./logs/errors.log", JSON.stringify(errorLog) + "\n");
    } catch (logError) {
      console.error("❌ Error escribiendo log de error:", logError);
    }
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Promesa rechazada no manejada:", reason);
    console.error("En promesa:", promise);

    // Log to file if possible
    try {
      const errorLog = {
        type: "unhandledRejection",
        reason: reason,
        timestamp: new Date().toISOString(),
      };

      if (!fs.existsSync("./logs")) {
        fs.mkdirSync("./logs", { recursive: true });
      }

      fs.appendFileSync("./logs/errors.log", JSON.stringify(errorLog) + "\n");
    } catch (logError) {
      console.error("❌ Error escribiendo log de error:", logError);
    }
  });
}

function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupData = {
      users: db.data.users,
      logs: db.data.logs.slice(-1000), // Keep last 1000 logs
      userSessions: db.data.userSessions,
      timestamp: new Date().toISOString(),
    };

    if (!fs.existsSync("./backups")) {
      fs.mkdirSync("./backups", { recursive: true });
    }

    fs.writeFileSync(
      `./backups/backup-${timestamp}.json`,
      JSON.stringify(backupData, null, 2)
    );

    console.log(`💾 Backup creado: backup-${timestamp}.json`);

    // Clean old backups (keep only last 7 days)
    const backupFiles = fs
      .readdirSync("./backups")
      .filter((file) => file.startsWith("backup-") && file.endsWith(".json"))
      .map((file) => ({
        name: file,
        time: fs.statSync(`./backups/${file}`).mtime,
      }))
      .sort((a, b) => b.time - a.time);

    // Remove backups older than 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    backupFiles.forEach((backup) => {
      if (backup.time < sevenDaysAgo) {
        fs.unlinkSync(`./backups/${backup.name}`);
        console.log(`🗑️ Backup antiguo eliminado: ${backup.name}`);
      }
    });
  } catch (error) {
    console.error("❌ Error creando backup:", error);
  }
}

function monitorSystemHealth() {
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();

  console.log(
    `🔍 Sistema - Memoria: ${Math.round(
      memUsage.heapUsed / 1024 / 1024
    )}MB, Uptime: ${Math.round(uptime / 60)}min`
  );

  // Alert if memory usage is too high
  if (memUsage.heapUsed > 500 * 1024 * 1024) {
    // 500MB
    console.warn(
      "⚠️ Uso de memoria alto:",
      Math.round(memUsage.heapUsed / 1024 / 1024) + "MB"
    );
  }

  // Check database size
  try {
    const dbStats = fs.statSync("db.json");
    const dbSizeMB = dbStats.size / 1024 / 1024;

    if (dbSizeMB > 50) {
      // 50MB
      console.warn("⚠️ Base de datos grande:", Math.round(dbSizeMB) + "MB");
    }
  } catch (error) {
    console.error("❌ Error verificando tamaño de DB:", error);
  }
}

// ==================== STARTUP INITIALIZATION ====================

// Validate environment before starting
validateEnvironmentVariables();

// Initialize directories
initializeDirectories();

// Setup error handlers
setupErrorHandlers();

// Create initial backup
createBackup();

// Schedule periodic backups (every 6 hours)
setInterval(createBackup, 6 * 60 * 60 * 1000);

// Monitor system health every 30 minutes
setInterval(monitorSystemHealth, 30 * 60 * 1000);

// Initial system health check
monitorSystemHealth();

console.log("🎉 Bot completamente inicializado y listo para funcionar!");
console.log("📞 Esperando conexiones de WhatsApp...");
console.log("💡 Escribe 'help' en la consola para ver comandos disponibles");

// ==================== END OF FILE ====================
