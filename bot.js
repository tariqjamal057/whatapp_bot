import pkg from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
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

// Helper Functions (Fixed and Integrated)
function detectReceiptMessage(messageText) {
  const lower = messageText.toLowerCase().trim();
  const receiptKeywords = [
    "comprobante",
    "recibo",
    "receipt",
    "voucher",
    "confirmación",
    "transferencia realizada",
    "pago realizado",
    "deposito realizado",
    "transfer completed",
    "payment made",
    "deposit made",
    "enviado",
    "transferí",
    "deposité",
    "pagué",
    "realicé el pago",
    "hice la transferencia",
  ];

  const documentIndicators = [
    "foto",
    "imagen",
    "captura",
    "screenshot",
    "picture",
    "image",
  ];

  const hasReceiptKeyword = receiptKeywords.some((keyword) =>
    lower.includes(keyword)
  );
  const hasDocumentIndicator = documentIndicators.some((indicator) =>
    lower.includes(indicator)
  );

  return hasReceiptKeyword || hasDocumentIndicator;
}

function isReceiptProperlySigned(messageText) {
  const lower = messageText.toLowerCase().trim();

  const signatureKeywords = [
    "firmado",
    "signed",
    "firma",
    "signature",
    "nombre completo",
    "full name",
    "últimos 4 dígitos",
    "last 4 digits",
    "whatsapp",
  ];

  const phonePattern = /\d{4}/;
  const namePattern = /[A-Za-zÀ-ÿ]+\s+[A-Za-zÀ-ÿ]+/;

  const hasSignatureKeyword = signatureKeywords.some((keyword) =>
    lower.includes(keyword)
  );
  const hasPhoneDigits = phonePattern.test(messageText);
  const hasName = namePattern.test(messageText);

  return (
    (hasSignatureKeyword && hasPhoneDigits && hasName) ||
    (hasPhoneDigits && hasName)
  );
}

function validateBeneficiaryInfo(text) {
  const lower = text.toLowerCase();

  const requiredFields = {
    name: [
      "nombre",
      "name",
      "apellido",
      "full name",
      "nombre completo",
      "beneficiario",
    ],
    cedula: ["cédula", "cedula", "id", "identification", "documento", "ci"],
    account: [
      "cuenta",
      "account",
      "número de cuenta",
      "account number",
      "banco",
      "nro cuenta",
    ],
    amount: [
      "monto",
      "amount",
      "cantidad",
      "entregar",
      "deliver",
      "bolívares",
      "bs",
    ],
  };

  const foundFields = {};

  Object.entries(requiredFields).forEach(([field, keywords]) => {
    foundFields[field] = keywords.some((keyword) => lower.includes(keyword));
  });

  const hasCedulaNumber = /\d{7,8}/.test(text);
  const hasAccountNumber = /\d{15,20}/.test(text);
  const hasAmount = /\d+/.test(text);

  const missingFields = [];
  if (!foundFields.name) missingFields.push("Nombre y Apellido");
  if (!foundFields.cedula || !hasCedulaNumber) missingFields.push("Cédula");
  if (!foundFields.account || !hasAccountNumber)
    missingFields.push("Número de Cuenta");
  if (!foundFields.amount || !hasAmount) missingFields.push("Monto a Entregar");

  return {
    isValid: missingFields.length === 0,
    missingFields: missingFields,
    foundFields: foundFields,
  };
}

function checkTransferCompletionStatus(userSession) {
  const data = userSession.data || {};
  const hasReceipt = data.receiptReceived && data.receiptSigned;
  const hasBeneficiary = data.beneficiaryComplete || data.beneficiaryInfo;

  return {
    hasReceipt,
    hasBeneficiary,
    isComplete: hasReceipt && hasBeneficiary,
    receiptStatus: data.receiptReceived
      ? data.receiptSigned
        ? "signed"
        : "unsigned"
      : "missing",
    beneficiaryStatus: data.beneficiaryComplete
      ? "complete"
      : data.partialBeneficiaryInfo
      ? "partial"
      : "missing",
  };
}

function validateTransferReadiness(userSession) {
  const data = userSession.data || {};
  const checks = {
    hasCountry: !!data.country,
    hasAmount: !!data.amount,
    hasTransferType: !!data.transferType,
    hasReceipt: !!(data.receiptReceived && data.receiptSigned),
    hasBeneficiary: !!(data.beneficiaryComplete || data.beneficiaryInfo),
    hasKYCIfNeeded: data.kycRequired ? !!data.kycCompleted : true,
  };

  const missingItems = [];
  if (!checks.hasCountry) missingItems.push("País de origen");
  if (!checks.hasAmount) missingItems.push("Monto a enviar");
  if (!checks.hasTransferType) missingItems.push("Tipo de transferencia");
  if (!checks.hasReceipt) missingItems.push("Comprobante firmado");
  if (!checks.hasBeneficiary) missingItems.push("Información del beneficiario");
  if (!checks.hasKYCIfNeeded) missingItems.push("Verificación KYC");

  return {
    isReady: missingItems.length === 0,
    missingItems,
    checks,
  };
}

// Enhanced handleSpecialCases function (NOW PROPERLY INTEGRATED)
// function handleSpecialCases(messageText, userSession) {
//   const lower = messageText.toLowerCase().trim();
//   const currentState = userSession.state;

//   console.log('🔍 Verificando casos especiales en estado:', currentState);

//   // Handle receipt messages in any state
//   if (detectReceiptMessage(messageText)) {
//     console.log('📋 Mensaje de comprobante detectado');

//     if (!isReceiptProperlySigned(messageText)) {
//       console.log('❌ Comprobante sin firma detectado');
//       logSpecialCaseHandling(userSession.sender, messageText, 'unsigned_receipt', 'request_signature', currentState);

//       return {
//         message: "📋 Gracias por el comprobante. 🙌 Solo necesito que lo firmes con tu nombre y los últimos cuatro dígitos del número de teléfono desde el que me escribes. Esto garantiza mayor seguridad y evita retrasos en el proceso. 📌\n\n✍️ **Ejemplo:** Juan Pérez 1234\n\nPor favor envía el comprobante firmado.",
//         intent: 'receipt_unsigned',
//         newState: currentState
//       };
//     } else {
//       console.log('✅ Comprobante firmado correctamente');

//       if (currentState === SESSION_STATES.AWAITING_BENEFICIARY_INFO) {
//         if (userSession.data && userSession.data.beneficiaryComplete) {
//           console.log('✅ Proceso completo: comprobante + beneficiario');
//           logSpecialCaseHandling(userSession.sender, messageText, 'process_complete', 'finalize_transfer', currentState);

//           return {
//             message: "✅ Perfecto, he recibido el comprobante firmado y la información del beneficiario está completa.\n\n📋 Procederemos a validar tu pago y comenzar el proceso de transferencia.\n\n⏱️ Te notificaremos cuando esté listo. Normalmente toma entre 15-30 minutos.\n\n¿Hay algo más en lo que pueda ayudarte?",
//             intent: 'process_complete',
//             newState: SESSION_STATES.INITIAL,
//             sessionData: { receiptReceived: true, receiptSigned: true, processComplete: true }
//           };
//         } else {
//           console.log('📋 Comprobante recibido, falta info beneficiario');
//           return {
//             message: "✅ Comprobante firmado recibido correctamente.\n\nAhora necesito la información del beneficiario:\n\n📌 **Nombre y Apellido:**\n📌 **Cédula:**\n📌 **Número de Cuenta:**\n📌 **Monto a Entregar:**",
//             intent: 'receipt_signed_need_beneficiary',
//             newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
//             sessionData: { receiptReceived: true, receiptSigned: true }
//           };
//         }
//       } else {
//         console.log('📋 Comprobante recibido sin transferencia activa');
//         return {
//           message: "✅ Comprobante firmado recibido. Para procesar tu transferencia, también necesito que sigas el proceso de envío de dinero.\n\n¿Deseas iniciar una nueva transferencia?",
//           intent: 'receipt_received_no_active_transfer',
//           newState: SESSION_STATES.INITIAL
//         };
//       }
//     }
//   }

//   // Handle potential beneficiary info when in the right state
//   if (currentState === SESSION_STATES.AWAITING_BENEFICIARY_INFO && !detectReceiptMessage(messageText)) {
//     console.log('📋 Validando información de beneficiario');
//     const validation = validateBeneficiaryInfo(messageText);

//     if (!validation.isValid) {
//       console.log('❌ Información de beneficiario incompleta:', validation.missingFields);
//       logSpecialCaseHandling(userSession.sender, messageText, 'incomplete_beneficiary', 'request_missing_fields', currentState);

//       let responseMessage = "📋 He recibido tu información, pero necesito que completes algunos datos:\n\n";

//       validation.missingFields.forEach((field, index) => {
//         responseMessage += `${index + 1}️⃣ **${field}**\n`;
//       });

//       responseMessage += "\n📌 **Formato requerido:**\n";
//             responseMessage += "**Nombre y Apellido:** [Nombre completo del beneficiario]\n";
//       responseMessage += "**Cédula:** [Número de cédula sin puntos ni guiones]\n";
//       responseMessage += "**Número de Cuenta:** [20 dígitos de la cuenta bancaria]\n";
//       responseMessage += "**Monto a Entregar:** [Cantidad en bolívares]\n\n";
//       responseMessage += "Por favor envía la información completa en este formato.";

//       return {
//         message: responseMessage,
//         intent: 'incomplete_beneficiary_data',
//         newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
//         sessionData: {
//           missingFields: validation.missingFields,
//           partialBeneficiaryInfo: messageText
//         }
//       };
//     }
//   }

//   // Handle high amount verification requests
//   if (lower.includes('verificación') || lower.includes('verification') ||
//       lower.includes('metamap') || lower.includes('completado')) {
//     if (currentState === SESSION_STATES.KYC_REQUIRED) {
//       console.log('🔐 Verificación en estado KYC - continuar flujo normal');
//       return null;
//     } else {
//       console.log('🔐 Consulta de verificación sin transferencia activa');
//       return {
//         message: "🔐 Si necesitas completar una verificación de identidad, te proporcionaré el enlace cuando inicies una transferencia que lo requiera.\n\n¿Deseas enviar dinero ahora?",
//         intent: 'verification_inquiry_no_active_transfer',
//         newState: SESSION_STATES.INITIAL
//       };
//     }
//   }

//   console.log('✅ No se detectaron casos especiales');
//   return null;
// }

// Enhanced logging function (NOW USED)
function logSpecialCaseHandling(
  sender,
  messageText,
  caseType,
  action,
  sessionState
) {
  console.log("🎯 CASO ESPECIAL MANEJADO:", {
    usuario: sender ? sender.split("@")[0] : "unknown",
    caso: caseType,
    accion: action,
    estado: sessionState,
    mensaje: messageText.substring(0, 50) + "...",
    timestamp: new Date().toISOString(),
  });
}

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
        if (qr) {
          console.log("📲 Generando código QR y subiendo a Cloudinary...");

          try {
            // Generate QR code as buffer
            const qrBuffer = await QRCode.toBuffer(qr, {
              color: {
                dark: "#000000",
                light: "#FFFFFF",
              },
              width: 512,
              type: "png",
            });

            // Upload to Cloudinary
            const uploadResult = await new Promise((resolve, reject) => {
              cloudinary.uploader
                .upload_stream(
                  {
                    resource_type: "image",
                    public_id: `whatsapp-qr-${Date.now()}`,
                    folder: "whatsapp-qr",
                    overwrite: true,
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
              "📱 Descarga y escanea el QR con WhatsApp (Dispositivos Vinculados)"
            );

            // Store the public_id for later deletion
            global.currentQRPublicId = uploadResult.public_id;
          } catch (error) {
            console.error(
              "❌ Error generando/subiendo QR a Cloudinary:",
              error
            );
            // Fallback to terminal QR if Cloudinary upload fails
            try {
              qrcode.generate(qr, { small: true });
            } catch (terminalError) {
              console.error(
                "❌ Error mostrando QR en terminal:",
                terminalError
              );
            }
          }
        }

        if (connection === "open") {
          console.log("✅ ¡Conexión de WhatsApp establecida!");

          // Delete QR image from Cloudinary after successful connection
          if (global.currentQRPublicId) {
            try {
              await cloudinary.uploader.destroy(global.currentQRPublicId);
              console.log(
                "🗑️ QR eliminado de Cloudinary después de la conexión exitosa"
              );
              delete global.currentQRPublicId;
            } catch (error) {
              console.log(
                "⚠️ No se pudo eliminar el QR de Cloudinary:",
                error.message
              );
            }
          }

          printShareableLink();
        } else if (connection === "close") {
          console.log("❌ Conexión de WhatsApp cerrada");

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
          // Remove this duplicate section:
          // console.log("🚀 Manejando mensaje del usuario desde:", sender);
          // await handleUserMessage(sender, messageText);
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

function detectEmotionalState(messageText) {
  const lower = messageText.toLowerCase().trim();

  const criticalEmotions = [
    "frustrated",
    "frustrado",
    "enojado",
    "angry",
    "furious",
    "molesto",
    "upset",
    "disappointed",
    "decepcionado",
    "confused",
    "confundido",
    "worried",
    "preocupado",
    "scared",
    "asustado",
    "nervous",
    "nervioso",
    "urgent",
    "urgente",
    "emergency",
    "emergencia",
    "help me",
    "ayúdame",
    "this is terrible",
    "esto es terrible",
    "very bad",
    "muy malo",
    "horrible",
    "awful",
    "terrible",
    "disgusted",
    "disgustado",
  ];

  const humanRequests = [
    "speak to someone",
    "hablar con alguien",
    "human",
    "humano",
    "agent",
    "agente",
    "representative",
    "representante",
    "asesor",
    "manager",
    "gerente",
    "supervisor",
    "talk to person",
    "hablar con persona",
    "i need help",
    "necesito ayuda",
    "can someone help",
    "alguien puede ayudar",
  ];

  const operationalIssues = [
    "not working",
    "no funciona",
    "error",
    "problema",
    "issue",
    "broken",
    "roto",
    "failed",
    "falló",
    "can't access",
    "no puedo acceder",
    "unavailable",
    "no disponible",
    "down",
    "caído",
    "offline",
    "rate not showing",
    "tasa no aparece",
    "can't calculate",
    "no puede calcular",
  ];

  for (const emotion of criticalEmotions) {
    if (lower.includes(emotion)) {
      return {
        needsHuman: true,
        reason: "critical_emotion",
        emotion: emotion,
      };
    }
  }

  for (const request of humanRequests) {
    if (lower.includes(request)) {
      return {
        needsHuman: true,
        reason: "explicit_request",
        request: request,
      };
    }
  }

  for (const issue of operationalIssues) {
    if (lower.includes(issue)) {
      return {
        needsHuman: true,
        reason: "operational_exception",
        issue: issue,
      };
    }
  }

  return {
    needsHuman: false,
    reason: null,
  };
}

// CORRECTED handleUserMessage function with proper integration
async function handleUserMessage(sender, messageText) {
  try {
    console.log("🔄 Procesando mensaje de:", sender, "Texto:", messageText);

    const emotionalState = detectEmotionalState(messageText);

    if (emotionalState.needsHuman) {
      console.log(
        "🚨 Transferencia automática detectada:",
        emotionalState.reason
      );

      let transferMessage =
        "🙌 Te conectaremos con un asesor humano. Un momento por favor…";

      switch (emotionalState.reason) {
        case "critical_emotion":
          transferMessage =
            "Entiendo que esto es importante para ti, y estamos aquí para ayudarte 🕊️\n\n🙌 Te conectaré inmediatamente con un asesor humano que podrá brindarte la atención personalizada que necesitas. Un momento por favor…";
          break;
        case "explicit_request":
          transferMessage =
            "🙌 Por supuesto, te conectaré con uno de nuestros asesores humanos. Un momento por favor…";
          break;
        case "operational_exception":
          transferMessage =
            "🔧 Veo que hay un problema técnico. Te conectaré inmediatamente con un asesor humano que podrá ayudarte a resolverlo. Un momento por favor…";
          break;
      }

      await sock.sendMessage(sender, { text: transferMessage });

      db.data.logs.push({
        sender,
        message: messageText,
        response: transferMessage,
        intent: "automatic_human_transfer",
        transferReason: emotionalState.reason,
        timestamp: new Date().toISOString(),
      });
      await db.write();

      return;
    }

    const rateSituation = detectRateSituation(messageText);
    if (rateSituation) {
      const rateResponse = handleRateSituation(rateSituation);
      if (rateResponse) {
        console.log("📊 Situación de tasa detectada:", rateSituation);

        await sock.sendMessage(sender, { text: rateResponse.message });

        db.data.logs.push({
          sender,
          message: messageText,
          response: rateResponse.message,
          intent: rateResponse.intent,
          rateSituation: rateSituation,
          timestamp: new Date().toISOString(),
        });
        await db.write();

        return;
      }
    }

    const amount = extractAmount(messageText);
    if (
      amount &&
      (messageText.toLowerCase().includes("efectivo") ||
        messageText.toLowerCase().includes("cash") ||
        messageText.toLowerCase().includes("entrega física"))
    ) {
      const isNet = isNetAmountIntent(messageText);
      const country = detectCountry(messageText.toLowerCase());
      const calculation = calculateCashDeliveryEnhanced(amount, isNet, country);

      if (calculation.success) {
        await sock.sendMessage(sender, { text: calculation.message });

        db.data.logs.push({
          sender,
          message: messageText,
          response: calculation.message,
          intent: "cash_delivery_calculation",
          timestamp: new Date().toISOString(),
        });
        await db.write();

        return;
      }
    }

    // Ensure database structure exists
    if (!db.data) {
      db.data = defaultData;
    }
    if (!db.data.userSessions) {
      db.data.userSessions = {};
    }
    if (!db.data.users) {
      db.data.users = {};
    }
    if (!db.data.logs) {
      db.data.logs = [];
    }

    // Initialize user session if not exists
    if (!db.data.userSessions[sender]) {
      db.data.userSessions[sender] = {
        state: SESSION_STATES.INITIAL,
        data: {},
        lastActivity: new Date().toISOString(),
      };
      console.log("🆕 Nueva sesión creada para:", sender);
    }

    // Store user in database
    if (!db.data.users[sender]) {
      db.data.users[sender] = {
        firstContact: new Date().toISOString(),
        messageCount: 0,
        lastMessage: new Date().toISOString(),
      };
      console.log("👤 Nuevo usuario agregado:", sender);
    }
    db.data.users[sender].messageCount++;
    db.data.users[sender].lastMessage = new Date().toISOString();

    const userSession = db.data.userSessions[sender];
    userSession.lastActivity = new Date().toISOString();

    console.log("🎯 Estado actual de sesión:", userSession.state);

    // FIXED: Check for special cases BEFORE processing normal flow
    const specialCaseResponse = handleSpecialCases(messageText, userSession);

    if (specialCaseResponse) {
      console.log("🎯 Caso especial detectado:", specialCaseResponse.intent);

      await sock.sendMessage(sender, { text: specialCaseResponse.message });

      if (specialCaseResponse.newState) {
        userSession.state = specialCaseResponse.newState;
        console.log("🔄 Estado actualizado a:", specialCaseResponse.newState);
      }
      if (specialCaseResponse.sessionData) {
        userSession.data = {
          ...userSession.data,
          ...specialCaseResponse.sessionData,
        };
        console.log("💾 Datos de sesión actualizados");
      }

      db.data.logs.push({
        sender,
        message: messageText,
        response: specialCaseResponse.message,
        intent: specialCaseResponse.intent,
        sessionState: userSession.state,
        timestamp: new Date().toISOString(),
      });
      await db.write();
      console.log("💾 Datos guardados en base de datos");

      return;
    }

    const response = await processUserMessage(sender, messageText, userSession);

    if (!response || !response.message) {
      console.error("❌ No se generó respuesta válida");
      throw new Error("No se generó respuesta válida");
    }

    console.log("📤 Enviando mensaje a:", sender);
    console.log("💭 Respuesta:", response.message.substring(0, 100) + "...");

    await sock.sendMessage(sender, { text: response.message });
    console.log("✅ Mensaje enviado exitosamente");

    if (response.newState) {
      userSession.state = response.newState;
      console.log("🔄 Estado actualizado a:", response.newState);
    }
    if (response.sessionData) {
      userSession.data = { ...userSession.data, ...response.sessionData };
      console.log("💾 Datos de sesión actualizados");
    }

    db.data.logs.push({
      sender,
      message: messageText,
      response: response.message,
      intent: response.intent,
      sessionState: userSession.state,
      timestamp: new Date().toISOString(),
    });
    await db.write();
    console.log("💾 Datos guardados en base de datos");
  } catch (error) {
    console.error("❌ Error en handleUserMessage:", error);
    console.error("❌ Stack del error:", error.stack);
    try {
      await sock.sendMessage(sender, {
        text:
          response?.fallback ||
          "Disculpa, hubo un error temporal. Por favor intenta nuevamente.",
      });
      console.log("📤 Mensaje de respaldo enviado");
    } catch (sendError) {
      console.error("❌ Error enviando mensaje de respaldo:", sendError);
    }
  }
}

async function processUserMessage(sender, messageText, userSession) {
  try {
    const lower = messageText.toLowerCase().trim();
    const currentState = userSession.state;

    console.log("🎯 Procesando en estado:", currentState);

    switch (currentState) {
      case SESSION_STATES.INITIAL:
        return handleInitialState(messageText, userSession);

      case SESSION_STATES.SEND_MONEY_STARTED:
        return handleSendMoneyFlow(messageText, userSession);

      case SESSION_STATES.AWAITING_COUNTRY:
        return handleCountryInput(messageText, userSession);

      case SESSION_STATES.AWAITING_AMOUNT:
        return handleAmountInput(messageText, userSession);

      case SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION:
        return handleAccountConfirmation(messageText, userSession);

      case SESSION_STATES.AWAITING_TRANSFER_TYPE:
        return handleTransferType(messageText, userSession);

      case SESSION_STATES.CASH_DELIVERY:
        return handleCashDelivery(messageText, userSession);

      case SESSION_STATES.AWAITING_BENEFICIARY_INFO:
        return handleBeneficiaryInfo(messageText, userSession);

      case SESSION_STATES.KYC_REQUIRED:
        return handleKYCRequired(messageText, userSession);

      // case SESSION_STATES.AWAITING_RECEIPT:
      //   return handleReceiptInput(messageText, userSession);

      // case SESSION_STATES.AWAITING_RECEIPT_CONFIRMATION:
      //   return handleReceiptConfirmation(messageText, userSession);

      default:
        console.log("⚠️ Estado desconocido, volviendo a inicial");
        return handleInitialState(messageText, userSession);
    }
  } catch (error) {
    console.error("❌ Error en processUserMessage:", error);
    return {
      message:
        response.fallback ||
        "Disculpa, hubo un error temporal. Por favor intenta nuevamente.",
      intent: "error",
      newState: SESSION_STATES.INITIAL,
    };
  }
}

function handleInitialState(messageText, userSession) {
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
    console.log("✅ Detectado: saludo");
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
    lower.includes("open") ||
    lower.includes("when are you") ||
    lower.includes("are you available")
  ) {
    console.log("✅ Detectado: horarios");
    return {
      message: response.business_hours,
      intent: "business_hours",
      newState: SESSION_STATES.INITIAL,
    };
  }

  // Promo
  if (
    lower.includes("promoción") ||
    lower.includes("promocion") ||
    lower.includes("sorteo") ||
    lower.includes("promo") ||
    lower.includes("sweepstakes") ||
    lower.includes("sweeptakes") ||
    lower.includes("concurso") ||
    lower.includes("cupón") ||
    lower.includes("cupon") ||
    lower.includes("coupons") ||
    lower.includes("coupens") ||
    lower.includes("descuento") ||
    lower.includes("oferta") ||
    lower.includes("any promo")
  ) {
    console.log("✅ Detectado: promociones");
    return {
      message: response.promo,
      intent: "promo",
      newState: SESSION_STATES.INITIAL,
    };
  }

  // Human connect
  if (
    lower.includes("hablar") ||
    lower.includes("asesor") ||
    lower.includes("human") ||
    lower.includes("persona") ||
    lower.includes("connect with human") ||
    lower.includes("agente") ||
    lower.includes("speak to someone") ||
    lower.includes("talk with human") ||
    lower.includes("need to talk") ||
    lower.includes("i'd like to speak") ||
    lower.includes("quiero hablar") ||
    lower.includes("necesito hablar")
  ) {
    console.log("✅ Detectado: solicitud de agente humano");
    return {
      message: response.human,
      intent: "human",
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
    console.log("✅ Detectado: enviar dinero");
    return {
      message:
        "¡Perfecto! 🙌 Antes de continuar, necesito confirmar algo importante:\n\n📌 ¿Eres el titular de la cuenta bancaria desde la cual se realizará la transferencia?",
      intent: "send_money",
      newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
    };
  }

  // Cash delivery
  if (
    lower.includes("efectivo") ||
    lower.includes("cash") ||
    lower.includes("dólares físicos") ||
    lower.includes("entrega en efectivo") ||
    lower.includes("dólares en mano")
  ) {
    console.log("✅ Detectado: entrega en efectivo");
    return {
      message:
        "✅ Perfecto, puedes enviar dólares en efectivo a Venezuela. 🔒 Ten en cuenta que este tipo de entrega tiene una comisión del 10% para cubrir la logística de entrega física en destino.\n\n¿Desde qué país estás enviando?",
      intent: "cash_delivery",
      newState: SESSION_STATES.CASH_DELIVERY,
      sessionData: { deliveryType: "cash" },
    };
  }

  // Daily rate - enhanced to handle specific queries
  if (
    lower.includes("tipo de cambio") ||
    lower.includes("tasa") ||
    lower.includes("rate") ||
    lower.includes("cambio del día") ||
    lower.includes("tasa del día") ||
    lower.includes("daily rate") ||
    lower.includes("exchange rate")
  ) {
    console.log("✅ Detectado: tasa del día");

    const country = detectCountry(lower);
    const amount = extractAmount(messageText);

    if (country && amount) {
      return handleSpecificRateCalculation(amount, country);
    } else if (country) {
      return handleCountrySpecificRate(country);
    } else if (amount) {
      return {
        message: `Para calcular exactamente cuánto recibirás por ${formatAmount(
          amount
        )}, necesito saber desde qué país estás enviando.\n\n¿Desde cuál de estos países envías?\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile`,
        intent: "rate_needs_country",
        newState: SESSION_STATES.AWAITING_COUNTRY,
        sessionData: { amount: amount, requestType: "rate_calculation" },
      };
    } else {
      return {
        message: response.daily_rate,
        intent: "daily_rate",
      };
    }
  }

  // Fallback
  console.log("✅ Usando respuesta de fallback");
  return {
    message: response.fallback,
    intent: "fallback",
  };
}

// FIXED: Now properly integrated functions
function isRateCalculationRequest(text) {
  const rateKeywords = ["rate", "tasa", "cambio", "exchange"];
  const calculationKeywords = [
    "how much",
    "cuánto",
    "get for",
    "recibo por",
    "por",
  ];
  const amountPattern = /\d+/;

  const hasRateKeyword = rateKeywords.some((keyword) => text.includes(keyword));
  const hasCalculationKeyword = calculationKeywords.some((keyword) =>
    text.includes(keyword)
  );
  const hasAmount = amountPattern.test(text);

  return (hasRateKeyword || hasCalculationKeyword) && hasAmount;
}

function handleRateCalculationRequest(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();
  const amount = extractAmount(messageText);
  const country = detectCountry(lower);

  console.log("🧮 Procesando solicitud de cálculo de tasa:", {
    amount,
    country,
  });

  if (!amount) {
    return {
      message:
        "Por favor especifica el monto que deseas convertir. Ejemplo: '¿Cuánto recibo por 5000 pesos?'",
      intent: "rate_calculation_no_amount",
    };
  }

  if (country) {
    return handleSpecificRateCalculation(amount, country);
  } else {
    const inferredCountry = inferCountryFromCurrency(messageText);
    if (inferredCountry) {
      return handleSpecificRateCalculation(amount, inferredCountry);
    } else {
      return {
        message: `Para calcular exactamente cuánto recibirás por ${formatAmount(
          amount
        )}, necesito saber desde qué país estás enviando.\n\n¿Desde cuál de estos países envías?\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile`,
        intent: "rate_needs_country",
        newState: SESSION_STATES.AWAITING_COUNTRY,
        sessionData: { amount: amount, requestType: "rate_calculation" },
      };
    }
  }
}

function handleSpecificRateCalculation(amount, country) {
  try {
    const rateInfo = calculateRate(amount, country);
    const countryName = getCountryDisplayName(country);

    if (rateInfo.error === "rate_not_loaded" || !rateInfo.rate) {
      return {
        message: `😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.`,
        intent: "rate_not_loaded",
      };
    }

    let responseMessage = `💰 **Cálculo de tasa para ${countryName}:**\n\n`;
    responseMessage += `📊 Monto a enviar: ${formatCurrency(
      amount,
      country
    )}\n`;
    responseMessage += `📈 Tasa aplicable: ${rateInfo.rate} Bs\n`;
    responseMessage += `💵 El beneficiario recibirá: **${rateInfo.receivedAmount} Bs**\n\n`;

    if (country === "dominican") {
      responseMessage += `ℹ️ *Tasa aplicada según el rango de monto para República Dominicana*\n\n`;
    }

    responseMessage += `✅ Esta tasa es válida para el día de hoy (${dailyRates.date})\n\n`;
    responseMessage += `¿Deseas proceder con esta transferencia?`;

    return {
      message: responseMessage,
      intent: "rate_calculated",
      sessionData: { amount: amount, country: country, rateInfo: rateInfo },
    };
  } catch (error) {
    console.error("❌ Error calculando tasa específica:", error);
    return {
      message: `😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.`,
      intent: "rate_not_loaded",
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
        message: `😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.`,
        intent: "rate_not_loaded",
      };
    }

    const ranges = dailyRates.dominican;
    responseMessage = `📈 **Tasas para ${countryName} (${dailyRates.date}):**\n\n`;

    Object.entries(ranges).forEach(([key, range], index) => {
      const rangeText =
        range.max === 9999999
          ? `Más de RD${range.min.toLocaleString()}`
          : `RD${range.min.toLocaleString()} - RD${range.max.toLocaleString()}`;
      responseMessage += `${index + 1}️⃣ ${rangeText}: **${range.rate} Bs**\n`;
    });

    responseMessage += `\n💡 *La tasa aplicable depende del monto que envíes*\n\n`;
    responseMessage += `¿Quieres calcular cuánto recibirás por un monto específico?`;
  } else {
    const rate = dailyRates[country];
    if (!rate || rate === 0) {
      return {
        message: `😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.`,
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

function inferCountryFromCurrency(text) {
  const lower = text.toLowerCase();

  if (
    lower.includes("peso") ||
    lower.includes("rd$") ||
    lower.includes("pesos dominicanos")
  ) {
    return "dominican";
  }
  if (lower.includes("sol") || lower.includes("soles")) {
    return "peru";
  }
  if (lower.includes("peso colombiano") || lower.includes("cop")) {
    return "colombia";
  }
  if (lower.includes("peso chileno") || lower.includes("clp")) {
    return "chile";
  }
  if (
    lower.includes("dólar") &&
    (lower.includes("ecuador") || lower.includes("ecuatoriano"))
  ) {
    return "ecuador";
  }

  return null;
}

function formatAmount(amount) {
  if (amount >= 1000) {
    return amount.toLocaleString();
  }
  return amount.toString();
}

function handleSendMoneyFlow(messageText, userSession) {
  return {
    message:
      "¡Perfecto! 🙌 Antes de continuar, necesito confirmar algo importante:\n\n📌 ¿Eres el titular de la cuenta bancaria desde la cual se realizará la transferencia?",
    intent: "send_money",
    newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
  };
}

function handleAccountConfirmation(messageText, userSession) {
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
        "⚠️ Por favor recuerda que solo aceptamos pagos realizados desde cuentas a nombre del cliente que nos contacta. Esto es por razones de seguridad, para protegerte de posibles fraudes o que un tercero esté transfiriendo fondos sin tu autorización.\n\n✅ Es indispensable que seas el titular de la cuenta o que informes al titular de la cuenta que se comunique con nosotros.\n\n¿Deseas continuar desde una cuenta personal?",
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

function handleCountryInput(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();
  const country = detectCountry(lower);

  if (country) {
    if (
      userSession.data &&
      userSession.data.requestType === "rate_calculation"
    ) {
      const amount = userSession.data.amount;
      return handleSpecificRateCalculation(amount, country);
    } else {
      return {
        message: `¡Excelente! Desde ${getCountryDisplayName(
          country
        )} 🌎\n\n📝 **Paso 2** - ¿Cuál es el monto aproximado que deseas enviar?`,
        intent: "country_detected",
        newState: SESSION_STATES.AWAITING_AMOUNT,
        sessionData: { country: country },
      };
    }
  } else {
    return {
      message:
        "No pude identificar el país. Por favor especifica desde cuál de estos países estás enviando:\n\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile",
      intent: "country_not_detected",
      newState: SESSION_STATES.AWAITING_COUNTRY,
    };
  }
}

function handleAmountInput(messageText, userSession) {
  const amount = extractAmount(messageText);
  const country = userSession.data.country;

  if (!amount) {
    return {
      message:
        "Por favor especifica el monto que deseas enviar. Ejemplo: 500, $300, 15000 pesos",
      intent: "amount_not_detected",
      newState: SESSION_STATES.AWAITING_AMOUNT,
    };
  }

  const rateInfo = calculateRate(amount, country);

  if (rateInfo.error === "rate_not_loaded" || !rateInfo.rate) {
    return {
      message: `😓 Lo siento, la tasa de hoy aún no ha sido cargada. Por favor consulta más tarde o contacta a un asesor para asistencia inmediata.`,
      intent: "rate_not_loaded",
      newState: SESSION_STATES.INITIAL,
    };
  }

  const needsKYC = checkKYCRequirement(amount, country);

  if (needsKYC) {
    return {
      message: `🚨 Veo que tu transferencia supera los $300 USD. 🔐 Por razones de seguridad, debemos verificar que eres el titular de la cuenta. Esto se hace solo una vez, y luego podrás enviar montos grandes sin problemas, siempre que uses la misma cuenta.\n\nPor favor verifica en este enlace:\n🔗 https://signup.metamap.com/?merchantToken=68221bbbcdc3bb0c6a37635a&flowId=68221bbb70559e84e01b01a1\n\nUna vez completada la verificación, podremos proceder con tu transferencia.`,
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

function handleTransferType(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  if (lower === "1" || lower.includes("transferencia")) {
    return {
      message: `📝 **Instrucciones para Transferencia Bancaria:**\n\n**Paso 1** - Solicita las cuentas bancarias actualizadas aquí. Las cuentas pueden variar.\n\n**Paso 2** - En el concepto de la transferencia, escribe:\n📌 ENTREGAR: Nombre y apellido del destinatario + los últimos 5 dígitos de tu WhatsApp.\n\nEjemplo: 👉 ENTREGAR a María Pérez 55553\n\n**Paso 3** - Después de transferir, envíame:\n1️⃣ Una foto del comprobante\n2️⃣ La información del beneficiario en este formato:\n\n📌 Nombre y Apellido:\n📌 Cédula:\n📌 Número de Cuenta:\n📌 Monto a Entregar:`,
      intent: "transfer_instructions",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: { transferType: "bank_transfer" },
    };
  } else if (
    lower === "2" ||
    lower.includes("depósito") ||
    lower.includes("efectivo")
  ) {
    return {
      message: `📝 **Instrucciones para Depósito en Efectivo:**\n\n**Paso 1** - Solicita las cuentas bancarias actualizadas aquí. Las cuentas pueden variar.\n⚠️ *No aceptamos pagos T-Pay o *960.\n\n**Paso 2** - Debes escribir en la boleta de depósito con bolígrafo:\n📌 Nombre y apellido del destinatario + últimos 5 dígitos de tu WhatsApp.\n\nEjemplo: 👉 ENTREGAR a María Pérez 55553\n\n**Paso 3** - Después de depositar, envíame:\n1️⃣ Una foto del comprobante\n2️⃣ La información del beneficiario en este formato:\n\n📌 Nombre y Apellido:\n📌 Cédula:\n📌 Número de Cuenta:\n📌 Monto a Entregar:`,
      intent: "deposit_instructions",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: { transferType: "cash_deposit" },
    };
  } else {
    return {
      message:
        "Por favor selecciona una opción válida:\n\n1️⃣ **Transferencia bancaria**\n2️⃣ **Depósito en efectivo**\n\nResponde con el número de tu opción preferida.",
      intent: "transfer_type_unclear",
      newState: SESSION_STATES.AWAITING_TRANSFER_TYPE,
    };
  }
}

function handleReceiptInput(messageText, userSession) {
  if (detectReceiptMessage(messageText)) {
    if (!isReceiptProperlySigned(messageText)) {
      return {
        message:
          '📋 Gracias por enviar el comprobante. Sin embargo, necesito que lo firmes con tu nombre completo y los últimos 4 dígitos del número de WhatsApp desde el que me escribes.\n\n✍️ **Ejemplo de firma:**\n"Juan Pérez 1234"\n\nEsto garantiza mayor seguridad y evita retrasos en el proceso. Por favor envía el comprobante firmado.',
        intent: "receipt_unsigned",
        newState: SESSION_STATES.AWAITING_RECEIPT,
      };
    } else {
      return {
        message:
          "✅ Perfecto, comprobante recibido y firmado correctamente.\n\nAhora necesito la información del beneficiario en este formato:\n\n📌 **Nombre y Apellido:**\n📌 **Cédula:**\n📌 **Número de Cuenta:**\n📌 **Monto a Entregar:**",
        intent: "receipt_signed_need_beneficiary",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        sessionData: { receiptReceived: true, receiptSigned: true },
      };
    }
  } else {
    return {
      message:
        "📸 Por favor envía la foto del comprobante de pago firmado con tu nombre completo y los últimos 4 dígitos de tu WhatsApp.",
      intent: "receipt_needed",
      newState: SESSION_STATES.AWAITING_RECEIPT,
    };
  }
}

function handleCashDelivery(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();
  const country = detectCountry(lower);

  if (country) {
    const amount = extractAmount(messageText);
    if (amount) {
      const calculation = calculateCashDelivery(
        amount,
        isNetAmountIntent(messageText)
      );
      return {
        message: `✅ Perfecto, entrega en efectivo desde ${getCountryDisplayName(
          country
        )}.\n\n💰 **Cálculo con comisión del 10%:**\n${
          calculation.message
        }\n\n📝 ¿Deseas proceder con esta transacción?`,
        intent: "cash_calculation",
        newState: SESSION_STATES.AWAITING_ACCOUNT_CONFIRMATION,
        sessionData: {
          country: country,
          deliveryType: "cash",
          calculation: calculation,
        },
      };
    } else {
      return {
        message: `✅ Perfecto, desde ${getCountryDisplayName(
          country
        )} con entrega en efectivo.\n\n💰 ¿Cuál es el monto que deseas enviar?`,
        intent: "cash_country_detected",
        newState: SESSION_STATES.AWAITING_AMOUNT,
        sessionData: { country: country, deliveryType: "cash" },
      };
    }
  } else {
    return {
      message:
        "Por favor especifica desde cuál de estos países estás enviando:\n\n🇩🇴 República Dominicana\n🇵🇪 Perú\n🇪🇨 Ecuador\n🇨🇴 Colombia\n🇨🇱 Chile",
      intent: "cash_country_needed",
      newState: SESSION_STATES.CASH_DELIVERY,
    };
  }
}

// CORRECTED handleBeneficiaryInfo function (NOW PROPERLY INTEGRATED)
function handleBeneficiaryInfo(messageText, userSession) {
  console.log("📋 Procesando información de beneficiario");

  // Check if this is a receipt instead of beneficiary info
  if (detectReceiptMessage(messageText)) {
    console.log(
      "📋 Detectado mensaje de comprobante en lugar de info beneficiario"
    );
    if (!isReceiptProperlySigned(messageText)) {
      return {
        message:
          '📋 Gracias por enviar el comprobante. Sin embargo, necesito que lo firmes con tu nombre completo y los últimos 4 dígitos del número de WhatsApp desde el que me escribes.\n\n✍️ **Ejemplo de firma:**\n"Juan Pérez 1234"\n\nEsto garantiza mayor seguridad y evita retrasos en el proceso. Por favor envía el comprobante firmado.',
        intent: "receipt_unsigned",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      };
    } else {
      return {
        message:
          "✅ Perfecto, comprobante recibido y firmado correctamente.\n\nAhora necesito la información del beneficiario en este formato:\n\n📌 **Nombre y Apellido:**\n📌 **Cédula:**\n📌 **Número de Cuenta:**\n📌 **Monto a Entregar:**",
        intent: "receipt_signed_need_beneficiary",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        sessionData: { receiptReceived: true, receiptSigned: true },
      };
    }
  }

  // Validate beneficiary information
  const validation = validateBeneficiaryInfo(messageText);

  if (validation.isValid) {
    console.log("✅ Información de beneficiario válida");
    const hasReceipt = userSession.data && userSession.data.receiptReceived;

    if (hasReceipt) {
      console.log("✅ Proceso completo: beneficiario + comprobante");
      return {
        message:
          "✅ Perfecto, he recibido toda la información del beneficiario y el comprobante firmado.\n\n📋 Ahora procederemos a validar tu pago y comenzar el proceso de transferencia.\n\n⏱️ Te notificaremos cuando el proceso esté completo. Normalmente toma entre 15-30 minutos.\n\n¿Hay algo más en lo que pueda ayudarte?",
        intent: "beneficiary_info_complete_with_receipt",
        newState: SESSION_STATES.INITIAL,
        sessionData: { beneficiaryInfo: messageText, processComplete: true },
      };
    } else {
      console.log("📋 Info beneficiario completa, falta comprobante");
      return {
        message:
          "✅ Excelente, información del beneficiario recibida correctamente.\n\nAhora necesito que envíes el comprobante de pago firmado con:\n✍️ Tu nombre completo + últimos 4 dígitos de tu WhatsApp\n\n📸 Por favor envía la foto del comprobante firmado.",
        intent: "beneficiary_info_received_need_receipt",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
        sessionData: {
          beneficiaryInfo: messageText,
          beneficiaryComplete: true,
        },
      };
    }
  } else {
    console.log(
      "❌ Información de beneficiario incompleta:",
      validation.missingFields
    );
    let responseMessage =
      "📋 He recibido tu información, pero necesito que completes algunos datos:\n\n";

    validation.missingFields.forEach((field, index) => {
      responseMessage += `${index + 1}️⃣ **${field}**\n`;
    });

    responseMessage += "\n📌 **Formato requerido:**\n";
    responseMessage +=
      "**Nombre y Apellido:** [Nombre completo del beneficiario]\n";
    responseMessage += "**Cédula:** [Número de cédula sin puntos ni guiones]\n";
    responseMessage +=
      "**Número de Cuenta:** [20 dígitos de la cuenta bancaria]\n";
    responseMessage += "**Monto a Entregar:** [Cantidad en bolívares]\n\n";
    responseMessage +=
      "Por favor envía la información completa en este formato.";

    return {
      message: responseMessage,
      intent: "incomplete_beneficiary_data",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: {
        missingFields: validation.missingFields,
        partialBeneficiaryInfo: messageText,
      },
    };
  }
}

function handleKYCRequired(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  if (
    lower.includes("completado") ||
    lower.includes("verificado") ||
    lower.includes("listo") ||
    lower.includes("done") ||
    lower.includes("terminado") ||
    lower.includes("finished")
  ) {
    const country = userSession.data.country;
    const amount = userSession.data.amount;
    const rateInfo = userSession.data.rateInfo;

    return {
      message: `✅ Excelente, hemos recibido tu verificación.\n\n📊 **Resumen de tu transferencia:**\n\n💰 Monto: ${formatCurrency(
        amount,
        country
      )}\n🌎 Desde: ${getCountryDisplayName(country)}\n📈 Tasa aplicable: ${
        rateInfo.rate
      }\n💵 Recibirá aproximadamente: ${
        rateInfo.receivedAmount
      } Bs\n\n📝 **Paso 3** - ¿Cómo prefieres realizar el pago?\n\n1️⃣ **Transferencia bancaria**\n2️⃣ **Depósito en efectivo**\n\nResponde con el número de tu opción preferida.`,
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

// Helper functions
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
      // Check if dominican rates are loaded
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

function formatCurrency(amount, country) {
  if (country === "dominican") {
    return `RD$${amount.toLocaleString()}`;
  }
  return `$${amount.toLocaleString()}`;
}

function detectRateSituation(messageText) {
  const lower = messageText.toLowerCase().trim();

  const previousDayIndicators = [
    "yesterday",
    "ayer",
    "old rate",
    "tasa anterior",
    "previous",
    "anterior",
    "outdated",
    "desactualizada",
    "from yesterday",
    "de ayer",
    "not today",
    "no es de hoy",
    "wrong date",
    "fecha incorrecta",
  ];

  const rateDoubtIndicators = [
    "is that the real rate",
    "esa es la tasa real",
    "real rate",
    "tasa real",
    "different rate",
    "tasa diferente",
    "saw different",
    "vi diferente",
    "too low",
    "muy baja",
    "too high",
    "muy alta",
    "seems wrong",
    "parece mal",
    "doubt",
    "dudo",
    "suspicious",
    "sospechoso",
    "not right",
    "no está bien",
    "other sources",
    "otras fuentes",
    "somewhere else",
    "en otro lado",
  ];

  const rateChangeIndicators = [
    "will change",
    "va a cambiar",
    "rate later",
    "tasa después",
    "update",
    "actualizar",
    "change during day",
    "cambia durante el día",
    "vary",
    "varía",
    "fluctuate",
    "fluctúa",
    "better rate",
    "mejor tasa",
    "wait for update",
    "esperar actualización",
  ];

  const rateNotLoadedIndicators = [
    "not loaded",
    "no cargada",
    "not available",
    "no disponible",
    "rate missing",
    "falta tasa",
    "no rate",
    "sin tasa",
    "not showing",
    "no aparece",
    "can't see rate",
    "no veo la tasa",
  ];

  for (const indicator of previousDayIndicators) {
    if (lower.includes(indicator)) {
      return "previous_day_rate";
    }
  }

  for (const indicator of rateDoubtIndicators) {
    if (lower.includes(indicator)) {
      return "rate_doubt";
    }
  }

  for (const indicator of rateChangeIndicators) {
    if (lower.includes(indicator)) {
      return "rate_change_inquiry";
    }
  }

  for (const indicator of rateNotLoadedIndicators) {
    if (lower.includes(indicator)) {
      return "rate_not_loaded";
    }
  }

  return null;
}

function handleRateSituation(situation) {
  switch (situation) {
    case "previous_day_rate":
      return {
        message:
          "🕐 Las tasas se actualizan diariamente.\n\nPor favor asegúrate de que la fecha mostrada en el enlace corresponda al día de hoy.\n\n¿Quieres que un asesor humano te la confirme ahora mismo?",
        intent: "rate_previous_day",
        requiresHumanFollowup: true,
      };

    case "rate_doubt":
      return {
        message:
          "📌 Nuestras tasas son propias y se actualizan diariamente según nuestro sistema interno de liquidación.\n\nEntendemos que pueden variar de otras fuentes, pero garantizamos transparencia y respaldo en cada envío.\n\n¿Te gustaría que un asesor revise manualmente la tasa para ti?",
        intent: "rate_doubt",
        requiresHumanFollowup: true,
      };

    case "rate_change_inquiry":
      return {
        message:
          "🔄 Las tasas pueden variar durante el día dependiendo del mercado.\n\nLa que te compartí ahora es la tasa actual.\n\n¿Quieres proceder con esta tasa o prefieres esperar una posible actualización?",
        intent: "rate_change_inquiry",
        requiresHumanFollowup: false,
      };

    case "rate_not_loaded":
      return {
        message:
          "😓 Disculpa, parece que aún no hemos cargado la tasa de hoy.\n\nPor favor consulta más tarde o déjame saber si quieres que un asesor te atienda de inmediato.",
        intent: "rate_not_loaded",
        requiresHumanFollowup: true,
      };

    default:
      return null;
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

function calculateCashDelivery(amount, isNetAmount = false) {
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return { message: "Monto inválido" };
  }

  if (isNetAmount) {
    const totalToSend = numAmount * 1.1;
    return {
      message: `Si quieres que reciban exactamente ${numAmount.toFixed(
        2
      )}, debes enviar ${totalToSend.toFixed(2)} (incluye comisión del 10%).`,
      amountToSend: totalToSend.toFixed(2),
      amountToReceive: numAmount.toFixed(2),
      commission: (totalToSend - numAmount).toFixed(2),
    };
  } else {
    const amountToReceive = numAmount / 1.1;
    return {
      message: `Si envías ${numAmount.toFixed(
        2
      )}, después de la comisión del 10%, recibirán ${amountToReceive.toFixed(
        2
      )}.`,
      amountToSend: numAmount.toFixed(2),
      amountToReceive: amountToReceive.toFixed(2),
      commission: (numAmount - amountToReceive).toFixed(2),
    };
  }
}

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

function printShareableLink() {
  const phone = process.env.WHATSAPP_NUMBER;
  const message = encodeURIComponent(process.env.DEFAULT_MESSAGE || "Hola");
  const link = `https://wa.me/${phone}?text=${message}`;
  console.log("\n🔗 Comparte este enlace de WhatsApp con los clientes:");
  console.log(link + "\n");
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Cerrando bot de manera elegante...");
  shouldReconnect = false;
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

// Admin commands
process.stdin.on("data", async (data) => {
  const cmd = data.toString().trim();
  if (cmd === "rate" || cmd === "tasa") {
    try {
      const msg = response.daily_rate;
      const users = Object.keys(db.data.users);
      console.log(`📢 Enviando tasa a ${users.length} usuarios...`);

      for (const number of users) {
        try {
          await sock.sendMessage(number, { text: msg });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Error enviando a ${number}:`, error);
        }
      }
      console.log("✅ Broadcast de tasa completado");
    } catch (error) {
      console.error("Error en broadcast de tasa:", error);
    }
  } else if (cmd === "stats" || cmd === "estadisticas") {
    try {
      const totalUsers = Object.keys(db.data.users).length;
      const totalMessages = db.data.logs.length;
      const activeSessions = Object.keys(db.data.userSessions || {}).length;
      const today = new Date().toISOString().split("T")[0];
      const todayMessages = db.data.logs.filter(
        (log) => log.timestamp && log.timestamp.startsWith(today)
      ).length;

      console.log("\n📊 ESTADÍSTICAS DEL BOT");
      console.log("========================");
      console.log(`👥 Total usuarios: ${totalUsers}`);
      console.log(`💬 Total mensajes: ${totalMessages}`);
      console.log(`🔄 Sesiones activas: ${activeSessions}`);
      console.log(`📅 Mensajes hoy: ${todayMessages}`);
      console.log("========================\n");
    } catch (error) {
      console.error("Error mostrando estadísticas:", error);
    }
  } else if (cmd === "sessions" || cmd === "sesiones") {
    try {
      console.log("\n🔄 SESIONES ACTIVAS");
      console.log("==================");
      if (db.data.userSessions) {
        Object.entries(db.data.userSessions).forEach(([user, session]) => {
          console.log(`📱 ${user.split("@")[0]}: ${session.state}`);
          if (session.data && session.data.country)
            console.log(`   🌎 País: ${session.data.country}`);
          if (session.data && session.data.amount)
            console.log(`   💰 Monto: ${session.data.amount}`);
        });
      }
      console.log("==================\n");
    } catch (error) {
      console.error("Error mostrando sesiones:", error);
    }
  } else if (cmd === "reset" || cmd === "reiniciar") {
    try {
      if (!db.data) db.data = {};
      db.data.userSessions = {};
      await db.write();
      console.log("✅ Todas las sesiones han sido reiniciadas");
    } catch (error) {
      console.error("Error reiniciando sesiones:", error);
    }
  } else if (cmd === "reload-rates" || cmd === "recargar-tasas") {
    try {
      dailyRates = loadDailyRates();
      console.log("✅ Tasas recargadas exitosamente");
    } catch (error) {
      console.error("Error recargando tasas:", error);
    }
  } else if (cmd === "help" || cmd === "ayuda") {
    console.log("\n🤖 COMANDOS DISPONIBLES");
    console.log("=======================");
    console.log("rate/tasa - Enviar tasa a todos los usuarios");
    console.log("stats/estadisticas - Mostrar estadísticas");
    console.log("sessions/sesiones - Mostrar sesiones activas");
    console.log("reset/reiniciar - Reiniciar todas las sesiones");
    console.log("reload-rates/recargar-tasas - Recargar tasas del día");
    console.log("help/ayuda - Mostrar esta ayuda");
    console.log("=======================\n");
  }
});

// NEW FUNCTIONS FOR RECEIPT AND BENEFICIARY VALIDATION

// function detectReceiptMessage(messageText) {
//   const lower = messageText.toLowerCase().trim();
//   const receiptIndicators = [
//     'comprobante', 'recibo', 'receipt', 'voucher', 'transferencia',
//     'depósito', 'deposito', 'pago', 'payment', 'transacción',
//     'transferí', 'deposité', 'pagué', 'sent', 'transferred'
//   ];

//   return receiptIndicators.some(indicator => lower.includes(indicator));
// }

// function isReceiptProperlySigned(messageText) {
//   const lower = messageText.toLowerCase().trim();

//   // Check for name patterns
//   const hasName = /[a-záéíóúñ]+\s+[a-záéíóúñ]+/i.test(messageText);

//   // Check for 4-digit pattern (last 4 digits of phone)
//   const hasDigits = /\d{4}/.test(messageText);

//   // Check for signature keywords
//   const signatureKeywords = ['firmado', 'signed', 'firma', 'signature'];
//   const hasSignatureKeyword = signatureKeywords.some(keyword => lower.includes(keyword));

//   return (hasName && hasDigits) || hasSignatureKeyword;
// }

// function validateBeneficiaryInfo(messageText) {
//   const lines = messageText.split('\n').filter(line => line.trim());
//   const text = messageText.toLowerCase();

//   const requiredFields = {
//     'Nombre y Apellido': ['nombre', 'apellido', 'name'],
//     'Cédula': ['cédula', 'cedula', 'ci', 'id'],
//     'Número de Cuenta': ['cuenta', 'account', 'número'],
//     'Monto a Entregar': ['monto', 'amount', 'entregar', 'bolívares', 'bs']
//   };

//   const foundFields = [];
//   const missingFields = [];

//   for (const [fieldName, keywords] of Object.entries(requiredFields)) {
//     const fieldFound = keywords.some(keyword => text.includes(keyword));
//     if (fieldFound) {
//       foundFields.push(fieldName);
//     } else {
//       missingFields.push(fieldName);
//     }
//   }

//   // Additional validation for account number format (should be 20 digits)
//   const accountNumberPattern = /\d{20}/;
//   const hasValidAccountNumber = accountNumberPattern.test(messageText);

//   // Additional validation for cedula (should be 7-8 digits)
//   const cedulaPattern = /\d{7,8}/;
//   const hasValidCedula = cedulaPattern.test(messageText);

//   const isValid = foundFields.length >= 3 && hasValidAccountNumber && hasValidCedula;

//   return {
//     isValid,
//     foundFields,
//     missingFields,
//     hasValidAccountNumber,
//     hasValidCedula,
//     fieldCount: foundFields.length
//   };
// }

// Clean old sessions (24 hours)
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

// Clean old logs (30 days)
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

// Rate update function (for manual rate updates)
function updateDailyRates(newRates) {
  try {
    Object.assign(dailyRates, newRates);
    console.log("✅ Tasas actualizadas exitosamente");
    return true;
  } catch (error) {
    console.error("❌ Error actualizando tasas:", error);
    return false;
  }
}

// Enhanced logging
function logUserInteraction(
  sender,
  messageText,
  response,
  intent,
  sessionState
) {
  const logEntry = {
    sender,
    message: messageText,
    response: response.message || response,
    intent,
    sessionState,
    timestamp: new Date().toISOString(),
    messageLength: messageText.length,
    responseLength: (response.message || response).length,
  };

  if (!db.data.logs) {
    db.data.logs = [];
  }

  db.data.logs.push(logEntry);

  console.log("📝 Interacción registrada:", {
    usuario: sender.split("@")[0],
    intent,
    estado: sessionState,
    timestamp: logEntry.timestamp,
  });
}

// Function to create today's rate file if it doesn't exist
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

// Function to check if rates need to be reloaded (daily check)
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

// Validation functions
function isValidWhatsAppNumber(number) {
  return number && number.includes("@s.whatsapp.net");
}

// Function to get conversation context
function getConversationContext(sender) {
  if (!db.data || !db.data.logs) return "new_user";

  const recentLogs = db.data.logs
    .filter((log) => log.sender === sender)
    .slice(-5);

  if (recentLogs.length === 0) return "new_user";

  const lastIntent = recentLogs[recentLogs.length - 1]?.intent;
  const hasAskedForMoney = recentLogs.some(
    (log) => log.intent === "send_money"
  );
  const hasAskedForRate = recentLogs.some((log) => log.intent === "daily_rate");

  return {
    lastIntent,
    hasAskedForMoney,
    hasAskedForRate,
    isReturningUser: recentLogs.length > 1,
  };
}

// Function to get user stats
function getUserStats(sender) {
  if (!db.data || !db.data.users) return null;

  const user = db.data.users[sender];
  if (!user) return null;

  const userLogs = db.data.logs
    ? db.data.logs.filter((log) => log.sender === sender)
    : [];
  const intents = userLogs.reduce((acc, log) => {
    acc[log.intent] = (acc[log.intent] || 0) + 1;
    return acc;
  }, {});

  return {
    firstContact: user.firstContact,
    messageCount: user.messageCount,
    lastMessage: user.lastMessage,
    topIntents: Object.entries(intents)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3),
  };
}

// Function to handle cash calculation with better error handling
function handleCashCalculation(text) {
  try {
    const amount = extractAmount(text);
    if (!amount) return null;

    const isNet = isNetAmountIntent(text);
    const calculation = calculateCashDelivery(amount, isNet);

    if (!calculation || calculation.message === "Monto inválido") return null;

    if (isNet) {
      return `✅ Entendido. Si quieres que tu familiar reciba exactamente ${calculation.amountToReceive} en efectivo, debes enviar ${calculation.amountToSend}, ya que aplicamos una comisión del 10% por la entrega física.`;
    } else {
      return `Gracias. Si estás enviando ${calculation.amountToSend} en efectivo, después de aplicar la comisión del 10%, tu familiar recibirá aproximadamente ${calculation.amountToReceive} en Venezuela.`;
    }
  } catch (error) {
    console.error("❌ Error en handleCashCalculation:", error);
    return null;
  }
}

// Enhanced error handling for specific scenarios
function handleSpecialCases(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  // Handle incomplete beneficiary information
  if (userSession.state === SESSION_STATES.AWAITING_BENEFICIARY_INFO) {
    if (!validateBeneficiaryInfo(messageText).isValid) {
      return {
        message: response.incomplete_data,
        intent: "incomplete_data",
        newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      };
    }
  }

  // Handle receipt without signature
  if (lower.includes("comprobante") || lower.includes("recibo")) {
    if (!lower.includes("firmado") && !lower.includes("signed")) {
      return {
        message:
          "🖋️ Gracias por tu comprobante. 🙌 Solo necesito que lo firmes con tu nombre y los últimos cuatro dígitos del número de teléfono desde el que me escribes. Esto garantiza mayor seguridad y evita retrasos en el proceso. 📌",
        intent: "receipt_unsigned",
      };
    }
  }

  return null;
}

// Function to handle high amount verification requests
function handleHighAmountVerification(amount, country) {
  const isHighAmount = checkKYCRequirement(amount, country);

  if (isHighAmount) {
    return {
      message:
        "🚨 Veo que tu transferencia supera los $300 USD. 🔐 Por razones de seguridad, debemos verificar que eres el titular de la cuenta. Esto se hace solo una vez, y luego podrás enviar montos grandes sin problemas, siempre que uses la misma cuenta.\n\nPor favor verifica en este enlace:\n🔗 https://signup.metamap.com/?merchantToken=68221bbbcdc3bb0c6a37635a&flowId=68221bbb70559e84e01b01a1",
      requiresVerification: true,
      verificationUrl:
        "https://signup.metamap.com/?merchantToken=68221bbbcdc3bb0c6a37635a&flowId=68221bbb70559e84e01b01a1",
    };
  }

  return null;
}

async function handleImageMessage(sender, imageMessage) {
  try {
    // Get user session
    if (!db.data.userSessions[sender]) {
      db.data.userSessions[sender] = {
        state: SESSION_STATES.INITIAL,
        data: {},
        lastActivity: new Date().toISOString(),
      };
    }

    const userSession = db.data.userSessions[sender];
    const currentState = userSession.state;

    // Only process images when expecting receipt
    if (
      currentState === SESSION_STATES.AWAITING_RECEIPT ||
      currentState === SESSION_STATES.AWAITING_BENEFICIARY_INFO
    ) {
      // Treat image as receipt submission
      const response = {
        message:
          '📸 Imagen recibida. Por favor envía también un mensaje de texto confirmando que el comprobante está firmado con tu nombre completo y los últimos 4 dígitos de tu WhatsApp.\n\nEjemplo: "Comprobante firmado con Juan Pérez 1234"',
        intent: "image_receipt_received",
        newState: SESSION_STATES.AWAITING_RECEIPT_CONFIRMATION,
      };

      await sock.sendMessage(sender, { text: response.message });

      // Log the interaction
      db.data.logs.push({
        sender,
        message: "[IMAGE_RECEIVED]",
        response: response.message,
        intent: response.intent,
        sessionState: currentState,
        timestamp: new Date().toISOString(),
      });
      await db.write();
    } else {
      // Image sent in wrong context
      await sock.sendMessage(sender, {
        text: "📸 He recibido tu imagen, pero en este momento necesito información de texto. ¿En qué puedo ayudarte?",
      });
    }
  } catch (error) {
    console.error("❌ Error manejando imagen:", error);
    await sock.sendMessage(sender, {
      text: "Disculpa, hubo un error procesando tu imagen. Por favor intenta nuevamente.",
    });
  }
}

function handleReceiptConfirmation(messageText, userSession) {
  const lower = messageText.toLowerCase().trim();

  if (
    lower.includes("firmado") ||
    lower.includes("signed") ||
    lower.includes("comprobante") ||
    isReceiptProperlySigned(messageText)
  ) {
    return {
      message:
        "✅ Perfecto, comprobante recibido y firmado correctamente.\n\nAhora necesito la información del beneficiario en este formato:\n\n📌 **Nombre y Apellido:**\n📌 **Cédula:**\n📌 **Número de Cuenta:**\n📌 **Monto a Entregar:**",
      intent: "receipt_confirmed",
      newState: SESSION_STATES.AWAITING_BENEFICIARY_INFO,
      sessionData: { receiptReceived: true, receiptSigned: true },
    };
  } else {
    return {
      message:
        'Por favor confirma que el comprobante está firmado con tu nombre completo y los últimos 4 dígitos de tu WhatsApp.\n\nEjemplo: "Comprobante firmado con Juan Pérez 1234"',
      intent: "receipt_confirmation_needed",
      newState: SESSION_STATES.AWAITING_RECEIPT_CONFIRMATION,
    };
  }
}

// Function to handle business inquiries
function handleBusinessInquiries(messageText) {
  const lower = messageText.toLowerCase().trim();

  const businessKeywords = [
    "negocio",
    "business",
    "empresa",
    "company",
    "comercial",
    "commercial",
    "volumen",
    "volume",
    "mayorista",
    "wholesale",
    "partnership",
    "sociedad",
  ];

  const hasBusinessKeyword = businessKeywords.some((keyword) =>
    lower.includes(keyword)
  );

  if (hasBusinessKeyword) {
    return {
      message:
        "🏢 Para consultas comerciales y de alto volumen, te conectaremos con nuestro equipo especializado en soluciones empresariales.\n\n📞 Un asesor comercial se pondrá en contacto contigo para discutir tus necesidades específicas.\n\n¿Podrías proporcionarme más detalles sobre el tipo de operación que necesitas?",
      intent: "business_inquiry",
      requiresHumanFollowup: true,
    };
  }

  return null;
}

// Function to handle complaint or issue reports
function handleComplaintOrIssue(messageText) {
  const lower = messageText.toLowerCase().trim();

  const complaintKeywords = [
    "problema",
    "issue",
    "error",
    "fallo",
    "queja",
    "complaint",
    "reclamo",
    "claim",
    "no funciona",
    "not working",
    "mal servicio",
    "bad service",
    "insatisfecho",
    "unsatisfied",
  ];

  const hasComplaintKeyword = complaintKeywords.some((keyword) =>
    lower.includes(keyword)
  );

  if (hasComplaintKeyword) {
    return {
      message:
        "😔 Lamento escuchar que has tenido una experiencia no satisfactoria. Tu feedback es muy importante para nosotros.\n\n🙌 Te conectaré inmediatamente con un supervisor que podrá revisar tu caso y brindarte una solución personalizada.\n\nUn momento por favor...",
      intent: "complaint_or_issue",
      requiresHumanFollowup: true,
      priority: "high",
    };
  }

  return null;
}

// Function to handle security concerns
function handleSecurityConcerns(messageText) {
  const lower = messageText.toLowerCase().trim();

  const securityKeywords = [
    "seguro",
    "secure",
    "seguridad",
    "security",
    "confiable",
    "trustworthy",
    "fraude",
    "fraud",
    "estafa",
    "scam",
    "robo",
    "theft",
    "hack",
  ];

  const hasSecurityKeyword = securityKeywords.some((keyword) =>
    lower.includes(keyword)
  );

  if (hasSecurityKeyword) {
    return {
      message:
        "🔒 La seguridad es nuestra máxima prioridad. Contamos con:\n\n✅ Encriptación de extremo a extremo\n✅ Verificación de identidad obligatoria\n✅ Monitoreo 24/7 de transacciones\n✅ Cumplimiento de regulaciones internacionales\n\n🛡️ Todas nuestras operaciones están respaldadas y aseguradas.\n\n¿Tienes alguna preocupación específica sobre la seguridad?",
      intent: "security_inquiry",
    };
  }

  return null;
}

// Function to detect and handle urgent requests
function detectUrgentRequest(messageText) {
  const lower = messageText.toLowerCase().trim();

  const urgentKeywords = [
    "urgente",
    "urgent",
    "emergencia",
    "emergency",
    "rápido",
    "quick",
    "inmediato",
    "immediate",
    "ya",
    "now",
    "prisa",
    "rush",
  ];

  const hasUrgentKeyword = urgentKeywords.some((keyword) =>
    lower.includes(keyword)
  );

  if (hasUrgentKeyword) {
    return {
      message:
        "⚡ Entiendo que tu solicitud es urgente. Te conectaré inmediatamente con un asesor que podrá atenderte con prioridad.\n\n🚀 Nuestros tiempos de procesamiento estándar son de 15-30 minutos, pero haremos todo lo posible para acelerar tu caso.\n\nUn momento por favor...",
      intent: "urgent_request",
      requiresHumanFollowup: true,
      priority: "urgent",
    };
  }

  return null;
}

// Function to clean up old QR codes from Cloudinary
async function cleanupOldQRCodes() {
  try {
    const result = await cloudinary.api.resources({
      type: 'upload',
      prefix: 'whatsapp-qr/',
      max_results: 100
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

// Run cleanup every 6 hours
setInterval(cleanupOldQRCodes, 6 * 60 * 60 * 1000);
// Start cleanup intervals
setInterval(cleanOldSessions, 6 * 60 * 60 * 1000); // Every 6 hours
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000); // Every 24 hours
setInterval(checkAndReloadRates, 60 * 60 * 1000); // Every hour

// Create today's rate file on startup
createTodayRateFile();

// Enhanced startup logging
console.log("🚀 Iniciando Bot de WhatsApp de Tecno Inversiones...");
console.log("📋 Respuestas configuradas:", Object.keys(response).length);
console.log("🌐 Idioma: Español");
console.log("📱 Funcionalidades: Fase 1 completa con flujos conversacionales");
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

// Start the WhatsApp connection
connectToWhatsApp();

// Export functions for testing (if needed)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    detectEmotionalState,
    calculateRate,
    validateBeneficiaryInfo,
    detectReceiptMessage,
    isReceiptProperlySigned,
    handleRateSituation,
    calculateCashDeliveryEnhanced,
    extractAmount,
    detectCountry,
    getCountryDisplayName,
    checkKYCRequirement,
    formatCurrency,
    isNetAmountIntent,
    handleHighAmountVerification,
    handleBusinessInquiries,
    handleComplaintOrIssue,
    handleSecurityConcerns,
    detectUrgentRequest,
  };
}
