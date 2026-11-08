// Every environment variable is read here and nowhere else.
// Missing required values stop the process at startup with one clear message.

const REQUIRED = [
  "DATABASE_URL",
  "PHOTON_PROJECT_API_KEY",
  "PHOTON_PROJECT_ID",
  "PHOTON_IMESSAGE_HANDLE",
  "PHOTON_VOICE_NUMBER",
  "TYPESAFE_API_KEY",
  "JEV_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_LISTEN_AGENT_ID",
  "ELEVENLABS_VERIFY_AGENT_ID",
  "ELEVENLABS_PHONE_NUMBER_ID",
  "ELEVENLABS_WEBHOOK_SECRET",
  "BOUNCER_LLM_SECRET",
  "BOUNCER_INIT_TOKEN",
  "SAFE_WORD_KEY",
  "PUBLIC_BASE_URL",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(
    `Missing environment variables: ${missing.join(", ")}.\n` +
      "Set them in .env locally (npm scripts load it) or in Railway → Variables.",
  );
  process.exit(1);
}

const env = (name: (typeof REQUIRED)[number]) => process.env[name]!.trim();
const flag = (name: string, fallback: boolean) => {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "on", "yes"].includes(v);
};

export const config = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: env("DATABASE_URL"),
  publicBaseUrl: env("PUBLIC_BASE_URL").replace(/\/+$/, ""),

  photon: {
    apiKey: env("PHOTON_PROJECT_API_KEY"),
    projectId: env("PHOTON_PROJECT_ID"),
    imessageHandle: env("PHOTON_IMESSAGE_HANDLE"),
    voiceNumber: env("PHOTON_VOICE_NUMBER"),
    // CLAUDE.md rule 5: only one server may hold the Photon socket. Railway owns it (PHOTON_SOCKET=on);
    // the local .env sets PHOTON_SOCKET=off unless Railway is paused.
    socket: flag("PHOTON_SOCKET", true),
    // DRY_RUN=1 prints outgoing iMessages instead of sending them (test scripts).
    dryRun: flag("DRY_RUN", false),
  },

  typesafe: {
    apiKey: env("TYPESAFE_API_KEY"),
    model: env("JEV_MODEL"),
  },

  gemini: {
    apiKey: env("GEMINI_API_KEY"),
    model: env("GEMINI_MODEL"), // vision / quality tier
    fastModel: process.env.GEMINI_FAST_MODEL?.trim() || "gemini-3.5-flash-lite", // replies, voice
  },

  elevenlabs: {
    apiKey: env("ELEVENLABS_API_KEY"),
    listenAgentId: env("ELEVENLABS_LISTEN_AGENT_ID"),
    verifyAgentId: env("ELEVENLABS_VERIFY_AGENT_ID"),
    phoneNumberId: env("ELEVENLABS_PHONE_NUMBER_ID"),
    webhookSecret: env("ELEVENLABS_WEBHOOK_SECRET"),
  },

  llmSecret: env("BOUNCER_LLM_SECRET"),
  initToken: env("BOUNCER_INIT_TOKEN"),
  safeWordKey: env("SAFE_WORD_KEY"),
};
