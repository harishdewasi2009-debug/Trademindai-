const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

/* ─────────────────────────────────────────────────────────────
   API keys — set these in your backend .env
   ───────────────────────────────────────────────────────────── */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

/* ─────────────────────────────────────────────────────────────
   Model ids — override via .env if your provider account uses
   different ids. These are placeholders; verify against your
   provider dashboards before deploying.
   ───────────────────────────────────────────────────────────── */
const MODELS = {
  gemini: {
    flash: process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash',
    pro: process.env.GEMINI_MODEL_PRO || 'gemini-2.5-pro',
  },
  claude: {
    sonnet: process.env.ANTHROPIC_MODEL_SONNET || 'claude-sonnet-4-5',
    opus: process.env.ANTHROPIC_MODEL_OPUS || 'claude-opus-4-1',
  },
  openai: {
    gpt4o: process.env.OPENAI_MODEL || 'gpt-4o',
  },
  deepseek: {
    v3: process.env.DEEPSEEK_MODEL_CHAT || 'deepseek-chat',
    r1: process.env.DEEPSEEK_MODEL_REASONER || 'deepseek-reasoner',
  },
};

/* ─────────────────────────────────────────────────────────────
   Plan → which models run (matches the pricing table in
   frontend/index.html)
   ───────────────────────────────────────────────────────────── */
function modelsForPlan(plan) {
  switch (plan) {
    case 'elite':
      return [
        { provider: 'gemini', model: MODELS.gemini.pro, label: 'Gemini 2.5 Pro' },
        { provider: 'claude', model: MODELS.claude.opus, label: 'Claude Opus 4.7' },
        { provider: 'openai', model: MODELS.openai.gpt4o, label: 'GPT-4o' },
        { provider: 'deepseek', model: MODELS.deepseek.r1, label: 'DeepSeek R1' },
      ];
    case 'pro':
      return [
        { provider: 'gemini', model: MODELS.gemini.flash, label: 'Gemini 2.5 Flash' },
        { provider: 'claude', model: MODELS.claude.sonnet, label: 'Claude Sonnet 4.6' },
        { provider: 'openai', model: MODELS.openai.gpt4o, label: 'GPT-4o' },
        { provider: 'deepseek', model: MODELS.deepseek.v3, label: 'DeepSeek V3' },
      ];
    case 'basic':
      return [
        { provider: 'gemini', model: MODELS.gemini.flash, label: 'Gemini 2.5 Flash' },
        { provider: 'deepseek', model: MODELS.deepseek.v3, label: 'DeepSeek V3' },
      ];
    default: // free
      return [{ provider: 'gemini', model: MODELS.gemini.flash, label: 'Gemini 2.5 Flash' }];
  }
}

/* ─────────────────────────────────────────────────────────────
   Provider callers — each returns raw text from the model
   ───────────────────────────────────────────────────────────── */
async function callGemini(model, prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Gemini request failed');
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('');
}

async function callClaude(model, prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Claude request failed');
  return (data.content || []).map((c) => c.text || '').join('');
}

async function callOpenAI(model, prompt) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'OpenAI request failed');
  return data.choices?.[0]?.message?.content || '';
}

async function callDeepSeek(model, prompt) {
  if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'DeepSeek request failed');
  return data.choices?.[0]?.message?.content || '';
}

async function callProvider(provider, model, prompt) {
  switch (provider) {
    case 'gemini':
      return callGemini(model, prompt);
    case 'claude':
      return callClaude(model, prompt);
    case 'openai':
      return callOpenAI(model, prompt);
    case 'deepseek':
      return callDeepSeek(model, prompt);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Pulls the first {...} JSON object out of a raw model response, tolerating
// markdown code fences and stray commentary around it.
function extractJson(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /api/ai/analyze
   body: { stockSymbol, exchange?, horizon?, riskTolerance? }
   ───────────────────────────────────────────────────────────── */
const ANALYZE_SCHEMA_PROMPT = `Respond with ONLY a single valid JSON object (no markdown, no commentary) with exactly these keys:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": number (0-100),
  "riskScore": number (1-10),
  "currentPrice": number,
  "reasoning": string (2-4 sentences),
  "risks": string[] (2-4 short bullet points),
  "catalysts": string[] (1-3 short bullet points),
  "technicals": { "rsi": number, "rsiSignal": "overbought"|"oversold"|"neutral", "macd": "bullish"|"bearish"|"neutral" },
  "priceTargets": { "oneWeek": number, "oneMonth": number, "threeMonths": number }
}`;

exports.analyzeStock = asyncHandler(async (req, res, next) => {
  const { stockSymbol, exchange, horizon = '1 month', riskTolerance = 'moderate' } = req.body;
  if (!stockSymbol) return next(new AppError('stockSymbol is required', 400));

  const plan = req.user?.plan || 'free';
  const models = modelsForPlan(plan);

  const prompt = `You are a stock market analyst covering the Indian markets (NSE/BSE). Analyse ${stockSymbol}${exchange ? ` on ${exchange}` : ''} for a ${horizon} horizon with ${riskTolerance} risk tolerance, using sound technical and fundamental reasoning. ${ANALYZE_SCHEMA_PROMPT}`;

  const settled = await Promise.allSettled(
    models.map((m) => callProvider(m.provider, m.model, prompt).then((text) => ({ ...m, text })))
  );

  const parsed = settled
    .filter((s) => s.status === 'fulfilled')
    .map((s) => ({ ...s.value, json: extractJson(s.value.text) }))
    .filter((s) => s.json);

  if (!parsed.length) {
    return next(new AppError('All AI models failed to respond. Please try again shortly.', 502));
  }

  const primary = parsed[0].json;
  const counts = parsed.reduce((acc, p) => {
    acc[p.json.signal] = (acc[p.json.signal] || 0) + 1;
    return acc;
  }, {});
  const consensusSignal = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const avgConfidence = Math.round(
    parsed.reduce((sum, p) => sum + (Number(p.json.confidence) || 0), 0) / parsed.length
  );

  const modelDebate =
    plan === 'elite'
      ? parsed.map((p) => ({
          model: p.label,
          signal: p.json.signal,
          reasoning: p.json.reasoning,
          confidence: p.json.confidence,
        }))
      : undefined;

  res.json({
    stockSymbol: stockSymbol.toUpperCase(),
    signal: consensusSignal,
    confidence: avgConfidence,
    consensusFrom: parsed.length,
    riskScore: primary.riskScore,
    currentPrice: primary.currentPrice,
    reasoning: primary.reasoning,
    risks: primary.risks,
    catalysts: primary.catalysts,
    technicals: primary.technicals,
    priceTargets: primary.priceTargets,
    modelDebate,
    analysedAt: new Date().toISOString(),
    // Pass-through only — wire these up to your real quota tracking if you
    // have one; left null here so the frontend just hides that bit of text.
    queriesRemainingThisMonth: req.user?.queriesRemaining ?? null,
    tokenQuota: req.user?.tokenQuota ?? null,
  });
});

/* ─────────────────────────────────────────────────────────────
   POST /api/ai/insight
   body: { kind, context }
   ───────────────────────────────────────────────────────────── */
const INSIGHT_PROMPTS = {
  marketBrief: (ctx) =>
    `Write a concise 3-4 sentence market brief for Indian markets given this data (JSON): ${JSON.stringify(
      ctx.marketData
    )}. Plain text, no markdown headers.`,
  portfolioHealth: (ctx) =>
    `Review this portfolio (JSON) and give a short health check naming 1 key strength and 1 key risk: ${JSON.stringify(
      ctx.holdings
    )}. Plain text, 3-5 sentences.`,
  tradeIdeas: (ctx) =>
    `Comment on these stock scan matches (scan type: ${ctx.scanType}) in 3-5 sentences, grounded only in the data given (JSON): ${JSON.stringify(
      ctx.matches
    )}.`,
  optionStrategy: (ctx) =>
    `Suggest a short options strategy idea for ${ctx.underlying} expiring ${ctx.expiry}, given this chain summary (JSON): ${JSON.stringify(
      ctx.chainSummary
    )}. 3-5 sentences, plain text.`,
  backtestAdvisor: (ctx) =>
    `Critique this backtest for ${ctx.symbol} using strategy "${ctx.strategy}" (JSON results): ${JSON.stringify(
      ctx.results
    )}. 3-5 sentences, plain text, mention whether it beat buy & hold.`,
  multiTimeframe: (ctx) =>
    `Compare the daily and weekly technical picture for ${ctx.symbol} given this data (JSON): ${JSON.stringify(
      ctx.timeframes
    )}. 2-4 sentences, plain text.`,
};

exports.getInsight = asyncHandler(async (req, res, next) => {
  const { kind, context = {} } = req.body;
  const builder = INSIGHT_PROMPTS[kind];
  if (!builder) return next(new AppError(`Unknown insight kind: ${kind}`, 400));

  const plan = req.user?.plan || 'free';
  const [primaryModel] = modelsForPlan(plan);
  const prompt = builder(context);

  try {
    const text = await callProvider(primaryModel.provider, primaryModel.model, prompt);
    if (!text.trim()) throw new Error('Empty response');
    res.json({ text: text.trim(), model: primaryModel.label });
  } catch (err) {
    return next(new AppError('AI insight is temporarily unavailable. Please try again.', 502));
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/ai/chat
   body: { message }
   ───────────────────────────────────────────────────────────── */
exports.chat = asyncHandler(async (req, res, next) => {
  const { message } = req.body;
  if (!message || !message.trim()) return next(new AppError('message is required', 400));

  const plan = req.user?.plan || 'free';
  const [primaryModel] = modelsForPlan(plan);

  const prompt = `You are TradeMind AI, a helpful assistant for Indian stock market trading. Answer clearly and concisely (max ~150 words), grounded in what the user actually asked. User: ${message.trim()}`;

  try {
    const reply = await callProvider(primaryModel.provider, primaryModel.model, prompt);
    if (!reply.trim()) throw new Error('Empty response');
    res.json({ reply: reply.trim(), model: primaryModel.label });
  } catch (err) {
    return next(new AppError('AI chat is temporarily unavailable. Please try again.', 502));
  }
});
