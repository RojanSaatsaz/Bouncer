// SPEC Flow 1 step 5: Gemini transcribes a screenshot into fields. It does not judge (rule 3).
// The image buffer is only held by the caller for this call and never written anywhere (rule 1).
import { generateJson, imagePart } from "./gemini.js";

export interface Extracted {
  source_app: string | null;
  sender: string | null;
  sender_type: "phone" | "shortcode" | "email" | "handle" | "unknown";
  body: string;
  urls: string[];
  phone_numbers: string[];
  qr_code_present: boolean;
  claimed_brand: string | null;
}

const SCHEMA = {
  type: "object",
  properties: {
    source_app: { type: "string", nullable: true, description: "App the screenshot is from, e.g. Messages, WhatsApp, Gmail, Instagram" },
    sender: { type: "string", nullable: true, description: "Sender name, number, short code, email or handle as shown" },
    sender_type: { type: "string", enum: ["phone", "shortcode", "email", "handle", "unknown"] },
    body: { type: "string", description: "Every visible word of the message(s), exactly as written" },
    urls: { type: "array", items: { type: "string" } },
    phone_numbers: { type: "array", items: { type: "string" } },
    qr_code_present: { type: "boolean" },
    claimed_brand: { type: "string", nullable: true, description: "Company, agency or person the message says it is from" },
  },
  required: ["sender_type", "body", "urls", "phone_numbers", "qr_code_present"],
};

const PROMPT =
  "This is a screenshot a user wants checked. Transcribe every visible word of the message or messages exactly, " +
  "then fill the fields. Ignore phone status bars, keyboards and app buttons. Do not judge whether it is a scam.";

export async function extractScreenshot(data: Buffer, mimeType: string): Promise<Extracted> {
  const x = await generateJson<Extracted>({
    tier: "quality",
    parts: [imagePart(data, mimeType), { text: PROMPT }],
    jsonSchema: SCHEMA,
    temperature: 0,
    timeoutMs: 7_000,
  });
  return {
    source_app: x.source_app ?? null,
    sender: x.sender?.trim() || null,
    sender_type: x.sender_type ?? "unknown",
    body: (x.body ?? "").trim(),
    urls: x.urls ?? [],
    phone_numbers: x.phone_numbers ?? [],
    qr_code_present: !!x.qr_code_present,
    claimed_brand: x.claimed_brand?.trim() || null,
  };
}
