import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "20mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/parse-slip", async (req, res) => {
  try {
    const { base64Image } = req.body;

    if (!base64Image) {
      return res.status(400).json({ error: "Missing image" });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
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

Rules:
- Only labeled "To" or "To Account"
- If uncertain return null
- No guessing
- Return JSON only

{
  "transactionId": "",
  "toAccountNumber": "",
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

    const output = response.output_text;

    const cleaned = output
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.status(500).json({ error: "Invalid AI response" });
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return res.json({
      transactionId: parsed.transactionId || null,
      toAccountNumber: parsed.toAccountNumber || null,
      text: parsed.rawText || null,
    });

  } catch (error) {
    console.error("OCR Worker error:", error);
    return res.status(500).json({ error: "OCR processing failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`OCR Worker running on port ${PORT}`);
});
