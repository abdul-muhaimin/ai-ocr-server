
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = "gpt-4.1-mini";

// Token cost per 1k tokens (adjust to match your OpenAI pricing)
const COST_PER_1K_INPUT_TOKENS = 0.00015;
const COST_PER_1K_OUTPUT_TOKENS = 0.0006;

// ─────────────────────────────────────────────
// App Setup
// ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "20mb" }));

// Serve tester.html at /tester
app.get("/tester", (req, res) => {
  res.sendFile(join(__dirname, "tester.html"));
});

// ─────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────
const LogLevel = { DEBUG: "DEBUG", INFO: "INFO", WARN: "WARN", ERROR: "ERROR" };

function log(level, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const output = JSON.stringify(entry);
  if (level === LogLevel.ERROR || level === LogLevel.WARN) {
    console.error(output);
  } else {
    console.log(output);
  }
}

// ─────────────────────────────────────────────
// App Setup
// ─────────────────────────────────────────────

app.use(express.json({ limit: "20mb" }));

app.get("/api-docs", (req, res) => {
  res.sendFile(join(__dirname, "api-docs.html"));
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Estimate base64 image size in KB
 */
function estimateImageSizeKB(base64String) {
  const base = base64String.replace(/^data:image\/\w+;base64,/, "");
  return Math.round((base.length * 3) / 4 / 1024);
}

/**
 * Calculate token cost estimate
 */
function calcTokenCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000) * COST_PER_1K_INPUT_TOKENS;
  const outputCost = (outputTokens / 1000) * COST_PER_1K_OUTPUT_TOKENS;
  return parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * Determine processing status from parsed result
 */
function deriveStatus(parsed) {
  const hasTransaction = !!parsed.transactionId;
  const hasAccount = !!parsed.toAccountNumber;

  if (hasTransaction && hasAccount) return "complete";
  if (hasTransaction || hasAccount) return "partial";
  return "empty";
}

/**
 * Clean and extract JSON from AI response
 */
function extractJSON(raw) {
  const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in AI response");
  return JSON.parse(match[0]);
}

// ─────────────────────────────────────────────
// Route: POST /parse-slip
// ─────────────────────────────────────────────
app.post("/parse-slip", async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();

  log(LogLevel.INFO, "parse_slip.start", { requestId });

  try {
    const { base64Image } = req.body;

    if (!base64Image) {
      log(LogLevel.WARN, "parse_slip.missing_image", { requestId });
      return res.status(400).json({
        requestId,
        status: "error",
        error: "Missing image",
        processTimeMs: Date.now() - startTime,
      });
    }

    const imageSizeKB = estimateImageSizeKB(base64Image);
    log(LogLevel.DEBUG, "parse_slip.image_received", { requestId, imageSizeKB });

    // ── AI Call ──────────────────────────────
    const aiStart = Date.now();

    const response = await openai.responses.create({
      model: MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
You are validating a Maldives bank transfer slip (BML or MIB).

Extract ONLY:

1. transactionId
2. toAccountNumber
3. confidenceScore — integer 0–100 reflecting how confident you are in the extracted data based on:
   - Image clarity
   - Text legibility
   - Whether required fields were clearly present and labeled
   - Any ambiguity or missing data

Rules:
- Only use "To" or "To Account" labeled fields for toAccountNumber
- If uncertain about a field, return null
- No guessing
- Return JSON only

{
  "transactionId": "",
  "toAccountNumber": "",
  "confidenceScore": 0,
  "rawText": ""
}
              `,
            },
            {
              type: "input_image",
              image_url: base64Image,
            },
          ],
        },
      ],
    });

    const aiTimeMs = Date.now() - aiStart;

    log(LogLevel.DEBUG, "parse_slip.ai_response_received", {
      requestId,
      aiTimeMs,
      model: MODEL,
    });

    // ── Parse Response ───────────────────────
    const rawOutput = response.output_text;
    let parsed;

    try {
      parsed = extractJSON(rawOutput);
    } catch (parseErr) {
      log(LogLevel.ERROR, "parse_slip.json_parse_failed", {
        requestId,
        error: parseErr.message,
        rawOutput,
      });
      return res.status(500).json({
        requestId,
        status: "error",
        error: "Invalid AI response format",
        processTimeMs: Date.now() - startTime,
      });
    }

    // ── Token & Cost Tracking ────────────────
    const usage = response.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const estimatedCostUSD = calcTokenCost(inputTokens, outputTokens);

    // ── Derived Fields ───────────────────────
    const processTimeMs = Date.now() - startTime;
    const status = deriveStatus(parsed);
    const confidenceScore = typeof parsed.confidenceScore === "number"
      ? Math.min(100, Math.max(0, parsed.confidenceScore))
      : null;

    log(LogLevel.INFO, "parse_slip.success", {
      requestId,
      status,
      confidenceScore,
      processTimeMs,
      aiTimeMs,
      totalTokens,
      estimatedCostUSD,
      imageSizeKB,
      hasTransactionId: !!parsed.transactionId,
      hasAccountNumber: !!parsed.toAccountNumber,
    });

    // ── Response ─────────────────────────────
    return res.json({
      requestId,
      status,

      // Extracted data
      data: {
        transactionId: parsed.transactionId || null,
        toAccountNumber: parsed.toAccountNumber || null,
        rawText: parsed.rawText || null,
      },

      // AI quality signal
      aiScore: confidenceScore,

      // Performance & cost
      meta: {
        processTimeMs,
        aiTimeMs,
        imageSizeKB,
        model: MODEL,
        tokens: {
          input: inputTokens,
          output: outputTokens,
          total: totalTokens,
          estimatedCostUSD,
        },
      },
    });

  } catch (error) {
    const processTimeMs = Date.now() - startTime;

    log(LogLevel.ERROR, "parse_slip.unhandled_error", {
      requestId,
      error: error.message,
      stack: error.stack,
      processTimeMs,
    });

    return res.status(500).json({
      requestId,
      status: "error",
      error: "OCR processing failed",
      processTimeMs,
    });
  }
});

// ─────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  log(LogLevel.INFO, "server.start", { port: PORT, model: MODEL });
});