// The language model behind the AI-assisted quote (quoteAiService) and the
// reading of electricity bills for it (energyBillService).
//
// One provider for now: Google Gemini, whose API has a free tier — a key from
// https://aistudio.google.com/apikey goes in GEMINI_API_KEY. The model answers
// in JSON held to a schema, so the caller gets an object, never prose to parse.
//
//   GEMINI_API_KEY   required — without it the feature answers 503
//   GEMINI_MODEL     optional — defaults to the current Flash model
//   GEMINI_API_URL   optional — another endpoint (a proxy, or a stub in tests)
//
// The key never leaves this file: it travels in a header, not the URL, so it
// stays out of the request log and out of error messages.
import logger from "./logger.js";

const DEFAULT_MODEL = "gemini-flash-latest";
const DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 90_000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const llmModel = () => process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
export const llmConfigured = () => Boolean(process.env.GEMINI_API_KEY?.trim());

/** Types the model can read as a file sent with the prompt (an electricity bill, say). */
export const LLM_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** What went wrong, in words the person at the quote screen can act on. */
const failure = (status, detail, { withFiles = false } = {}) => {
    if (status === 429)
        return httpError(429, "The AI service's request limit has been reached — wait a minute and try again");
    if (status === 400 && /api key/i.test(detail))
        return httpError(503, "The AI service rejected its API key — check GEMINI_API_KEY in the backend's .env");
    // Any other refusal of a request carrying a file is about the file: damaged, password-protected, blank.
    if (status === 400 && withFiles)
        return httpError(422, "The AI service could not open this file — try a clearer PDF or photo of the bill (not password-protected)");
    if (status === 401 || status === 403)
        return httpError(503, "The AI service refused the API key — check GEMINI_API_KEY in the backend's .env");
    if (status === 404)
        return httpError(503, `The AI model "${llmModel()}" was not found — check GEMINI_MODEL in the backend's .env`);
    return httpError(502, "The AI service could not answer just now — try again shortly");
};

/**
 * Asks the model for one JSON object. { system, prompt, schema, files? } → the
 * parsed object. `schema` is the response schema in Gemini's form (OpenAPI
 * subset). `files` ([{ mimeType, data: Buffer }], types from LLM_FILE_TYPES)
 * go with the prompt for the model to read — sent inline, so keep them under
 * ~15 MB together. Throws an error carrying an HTTP status: 503 when the
 * feature is not set up, 429 when the quota is spent, 422 when a file could
 * not be read, 502 when the model fails or answers badly.
 */
export const generateJson = async ({ system, prompt, schema, files = [] }) => {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key)
        throw httpError(
            503,
            "AI quotes are not set up yet — add GEMINI_API_KEY to the backend's .env (a free key comes from aistudio.google.com/apikey) and restart the server"
        );

    const base = (process.env.GEMINI_API_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
    const url = `${base}/models/${encodeURIComponent(llmModel())}:generateContent`;

    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [
                    {
                        role: "user",
                        parts: [
                            ...files.map((file) => ({ inlineData: { mimeType: file.mimeType, data: Buffer.from(file.data).toString("base64") } })),
                            { text: prompt },
                        ],
                    },
                ],
                generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) {
        logger.warn(`AI request failed before an answer: ${err?.cause?.code || err?.name || "error"} ${err?.message || ""}`);
        if (err?.name === "TimeoutError") throw httpError(504, "The AI service took too long to answer — try again");
        throw httpError(502, "The AI service could not be reached — check the server's internet connection and try again");
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = String(body?.error?.message ?? "");
        logger.warn(`AI request refused: ${response.status} ${detail.slice(0, 300)}`);
        throw failure(response.status, detail, { withFiles: files.length > 0 });
    }

    const candidate = body?.candidates?.[0];
    const answer = (candidate?.content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("");
    if (!answer) {
        logger.warn(`AI answered with nothing: ${body?.promptFeedback?.blockReason || candidate?.finishReason || "no candidate"}`);
        throw httpError(502, "The AI service gave no answer for this job — try again, or reword the instructions");
    }
    try {
        return JSON.parse(answer);
    } catch {
        logger.warn(`AI answer was not JSON (finish: ${candidate?.finishReason || "?"})`);
        throw httpError(502, "The AI service gave an incomplete answer — try again");
    }
};
