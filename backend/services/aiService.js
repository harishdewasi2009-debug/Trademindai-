// services/aiService.js
// ══════════════════════════════════════════════════════════════════════════
//  TradeMind Multi-Model AI Service
//  Handles Gemini, Claude, ChatGPT, and DeepSeek calls directly from Node.
//  No external AI engine process needed — just set the API keys in .env.
//
//  Plan → model routing:
//   free    → Gemini Flash only (fallback: none)
//   basic   → Gemini Flash primary, DeepSeek V3 fallback
//   pro     → Gemini Flash + Claude Sonnet (limited) + ChatGPT (limited)
//             + DeepSeek V3 fallback; consensus result
//   elite   → Gemini Pro + Claude Opus + ChatGPT (high) + DeepSeek R1
//             run in parallel, return consensus + per-model debate
//
//  Token limits:
//   Each model now gets ITS OWN maxOutputTokens, defined per-plan in
//   config/plans.js (PLANS[plan].aiModels[modelKey].maxOutputTokens) —
//   not one shared cap for every model in the request. This matters
//   because Pro/Elite call multiple models IN PARALLEL on every request,
//   so the expensive models (Claude Sonnet/Opus) get a smaller individual
//   cap than the cheap ones (Gemini Flash, DeepSeek), keeping combined
//   worst-case cost well under each plan's price. See plans.js comments
//   for the worst-case math.
// ══════════════════════════════════════════════════════════════════════════

const { getModelConfig } = require('../config/plans');
const marketDataService = require('./marketDataService');
const { computeAllIndicators } = require('../utils/indicators');
const AppError = require('../utils/AppError');

// ── Model identifiers ────────────────────────────────────────────────────
const MODELS = {
  GEMINI_FLASH:   'gemini-2.5-flash',
  GEMINI_PRO:     'gemini-2.5-pro',
  CLAUDE_SONNET:  'claude-sonnet-4-6',
  CLAUDE_OPUS:    'claude-opus-4-7',
  GPT4O:          'gpt-4o',
  GPT4O_HIGH:     'gpt-4o',              // same model, higher token cap for Elite
  DEEPSEEK_V3:    'deepseek-chat',       // DeepSeek V3
  DEEPSEEK_R1:    'deepseek-reasoner',   // DeepSeek R1
};

// ── Default max output tokens per plan (fallback only — real source of truth
//    is now config/plans.js PLANS[plan].aiModels[modelKey].maxOutputTokens) ──
const DEFAULT_MAX_TOKENS = {
  free:  1_500,
  basic: 2_000,
  pro:   5_000,
  elite: 10_000,
};

/** Looks up this model's own maxOutputTokens for the plan; falls back to the
 *  plan-wide default if config/plans.js doesn't have an entry for some reason. */
function maxTokensFor(plan, modelKey) {
  const cfg = getModelConfig(plan, modelKey);
  return cfg?.maxOutputTokens || DEFAULT_MAX_TOKENS[plan] || DEFAULT_MAX_TOKENS.free;
}



// ── Approximate cost per 1K tokens (USD) — for DB logging only ───────────
const COST_PER_1K = {
  [MODELS.GEMINI_FLASH]:  { input: 0.000075, output: 0.0003  },
  [MODELS.GEMINI_PRO]:    { input: 0.00125,  output: 0.01    },
  [MODELS.CLAUDE_SONNET]: { input: 0.003,    output: 0.015   },
  [MODELS.CLAUDE_OPUS]:   { input: 0.015,    output: 0.075   },
  [MODELS.GPT4O]:         { input: 0.005,    output: 0.015   },
  [MODELS.DEEPSEEK_V3]:   { input: 0.00027,  output: 0.0011  },
  [MODELS.DEEPSEEK_R1]:   { input: 0.00055,  output: 0.00219 },
};

function calcCost(model, tokIn, tokOut) {
  const rates = COST_PER_1K[model];
  if (!rates) return 0;
  return (tokIn / 1000) * rates.input + (tokOut / 1000) * rates.output;
}

// ─────────────────────────────────────────────────────────────────────────
//  REAL MARKET DATA FETCH
//  Pulls a live quote + real historical candles from Upstox (via
//  marketDataService) and computes real technical indicators from them.
//  Throws if Upstox isn't connected or returns no data — callers must
//  surface that as "Data Unavailable", never fall back to invented numbers.
// ─────────────────────────────────────────────────────────────────────────
// FIX (index analysis): NIFTY 50 / SENSEX / NIFTY BANK aren't equities —
// resolveInstrumentKey() (used by getLtp/getHistoricalCandles) only knows
// equity trading symbols, so analysing an index by name used to fail
// outright. Route these three through the dedicated index quote/candle
// functions instead (same ones the Charts/Options pages already use).
const INDEX_LABELS = ['NIFTY 50', 'SENSEX', 'NIFTY BANK'];
function normalizeIndexLabel(stockSymbol) {
  const s = (stockSymbol || '').trim().toUpperCase();
  if (INDEX_LABELS.includes(s)) return s;
  // Accept common aliases so users typing "NIFTY", "BANKNIFTY" etc. in the
  // Analysis search box still resolve to the right index.
  if (s === 'NIFTY' || s === 'NIFTY50') return 'NIFTY 50';
  if (s === 'BANKNIFTY' || s === 'NIFTYBANK' || s === 'BANK NIFTY') return 'NIFTY BANK';
  return null;
}

async function fetchRealMarketContext(stockSymbol, exchange) {
  const indexLabel = normalizeIndexLabel(stockSymbol);
  if (indexLabel) return fetchRealIndexContext(indexLabel);

  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);

  const [quote, candleData] = await Promise.all([
    marketDataService.getLtp(stockSymbol, exchange),
    marketDataService.getHistoricalCandles(stockSymbol, {
      unit: 'days',
      interval: 1,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      exchange,
    }),
  ]);

  const candles = candleData?.candles || [];
  const indicators = computeAllIndicators(candles);
  if (!indicators) {
    throw new AppError(
      `Not enough real historical data returned by Upstox for ${stockSymbol} to compute indicators.`,
      503
    );
  }

  return { quote, indicators, candleCount: candles.length };
}

async function fetchRealIndexContext(indexLabel) {
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);

  const [quotes, candleData] = await Promise.all([
    marketDataService.getIndexQuotes(),
    marketDataService.getIndexHistoricalCandles(indexLabel, {
      unit: 'days',
      interval: 1,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    }),
  ]);

  const idx = quotes.indices.find((i) => i.label === indexLabel);
  if (!idx || idx.lastPrice == null) {
    throw new AppError(`Real index quote for ${indexLabel} is currently unavailable from Upstox.`, 503);
  }
  const quote = {
    symbol: indexLabel,
    instrumentKey: idx.instrumentKey,
    lastPrice: idx.lastPrice,
    previousClose: idx.previousClose,
    changePct: idx.changePct,
    fetchedAt: idx.fetchedAt,
  };

  const candles = candleData?.candles || [];
  const indicators = computeAllIndicators(candles);
  if (!indicators) {
    throw new AppError(
      `Not enough real historical data returned by Upstox for ${indexLabel} to compute indicators.`,
      503
    );
  }

  return { quote, indicators, candleCount: candles.length };
}

// ─────────────────────────────────────────────────────────────────────────
//  PROMPT BUILDER
//  Returns a structured system + user message pair for stock analysis.
//  The AI is given REAL price + indicator data pulled from Upstox — it is
//  explicitly told to analyze only the numbers provided, never to invent
//  or estimate a price/indicator value on its own.
// ─────────────────────────────────────────────────────────────────────────
// COMPLIANCE NOTE: This prompt intentionally does NOT ask for a BUY/SELL/HOLD
// verdict, a future price prediction, or an expected return. Under SEBI's
// Research Analyst / Investment Adviser regulations, "giving stop-loss
// targets" and "providing trading calls" are explicitly regulated research
// services requiring registration — regardless of whether a human or an AI
// produced them. This app is not SEBI-registered, so it must describe what
// the real indicator data shows (a "technical score") without instructing
// the user to buy, sell, or hold, and without predicting a future price.
function buildPrompt(stockSymbol, horizon, riskTolerance, marketContext) {
  const { quote, indicators } = marketContext;

  const system = `You are TradeMind AI, an expert Indian stock market data analyst.
You will be given REAL, live market data (price, volume, and computed technical indicators) for one NSE/BSE stock, fetched moments ago from Upstox. Base your entire analysis strictly on the numbers provided below — never invent, estimate, or recall a price or indicator value from your own training data or general knowledge, even if you believe you know this stock. If the provided data seems insufficient for some part of the analysis, say so in "reasoning" rather than guessing.
IMPORTANT — this is a data-description tool, not investment advice: never tell the user to buy, sell, or hold; never state or imply a future price, price target, or expected return; do not use the words "buy", "sell", or "hold" as a recommendation. Describe only what the current indicators show and what they have historically meant, in neutral, descriptive language. The user makes their own decision.
Return ONLY a JSON object — no prose, no markdown fences, no preamble. Prices in INR. All percentage values as numbers (not strings). The "currentPrice" field in your response MUST exactly equal the currentPrice given to you below.`;

  const user = `Describe the current technical picture for: ${stockSymbol.toUpperCase()}
Horizon of interest: ${horizon || '1 month'}
Stated risk tolerance: ${riskTolerance || 'moderate'}

REAL LIVE MARKET DATA (fetched from Upstox just now — use these numbers, do not invent your own):
- Current price (LTP): ${quote?.lastPrice ?? indicators.currentPrice}
- Previous close: ${quote?.previousClose ?? 'n/a'}
- Day change: ${quote?.changePct != null ? quote.changePct.toFixed(2) + '%' : 'n/a'}
- Volume (last session): ${indicators.volume}
- Avg. volume (20d): ${indicators.avgVolume20}
- RSI (14): ${indicators.rsi}
- MACD: ${indicators.macd} | Signal: ${indicators.macdSignal} | Histogram: ${indicators.macdHistogram}
- EMA20: ${indicators.ema20} | EMA50: ${indicators.ema50}
- SMA20: ${indicators.sma20} | SMA50: ${indicators.sma50}
- Bollinger Bands: upper ${indicators.bollingerUpper} / mid ${indicators.bollingerMid} / lower ${indicators.bollingerLower}
- VWAP: ${indicators.vwap}
- ATR (14): ${indicators.atr}
- Supertrend: ${indicators.supertrend} (${indicators.supertrendDirection})
- Support: ${indicators.support} | Resistance: ${indicators.resistance}
- Trend strength score (0-100): ${indicators.trendStrength}

Return a JSON object with this exact structure:
{
  "technicalScore": <integer 0-100, how strongly the CURRENT indicators lean bullish (100) vs bearish (0); 50 = mixed/neutral — this describes the data, it is not a recommendation>,
  "sentiment": "strong_bullish" | "moderate_bullish" | "neutral" | "moderate_bearish" | "strong_bearish",
  "currentPrice": <number, must equal the current price given above>,
  "riskLevel": <integer 1-10, how volatile/risky this stock's recent price action has been, based on ATR — NOT a personalized suitability rating>,
  "technicals": {
    "rsi": ${indicators.rsi},
    "rsiSignal": "oversold" | "neutral" | "overbought",
    "trend": "bullish" | "bearish" | "sideways",
    "support": ${indicators.support},
    "resistance": ${indicators.resistance},
    "macd": "bullish_crossover" | "bearish_crossover" | "neutral"
  },
  "reasoning": "<2-3 sentences describing what the indicators show right now, in neutral descriptive language — no buy/sell/hold instruction, no future price>",
  "risks": ["<risk factor 1>", "<risk factor 2>", "<risk factor 3>"],
  "watchPoints": ["<technical level or event worth watching 1>", "<watch point 2>"]
}`;

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
//  INDIVIDUAL MODEL CALLERS
//  Each caller accepts maxTokens so the plan cap is enforced at the model
//  level — preventing any single response from burning too many tokens.
// ─────────────────────────────────────────────────────────────────────────

// ── Gemini (Google AI Studio) ────────────────────────────────────────────
async function callGemini(model, system, user, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,      // ← plan cap applied here
      responseMimeType: 'application/json',
      // FIX: Gemini 2.5 models reserve part of maxOutputTokens for internal
      // "thinking" by default. On a small cap like the Free plan's 1,500
      // tokens, the model could burn its whole budget thinking and return
      // an EMPTY response — which then failed JSON parsing downstream and
      // surfaced as the generic "AI analysis is temporarily unavailable"
      // error with no clue why. We don't need chain-of-thought for a
      // structured data-extraction task, so turn it off entirely.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const finishReason = data.candidates?.[0]?.finishReason;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const tokIn  = data.usageMetadata?.promptTokenCount     || 0;
  const tokOut = data.usageMetadata?.candidatesTokenCount || 0;

  // FIX: previously this silently fell back to '{}' when Gemini returned no
  // text, which then failed JSON parsing further downstream with a vague
  // "AI returned unparseable JSON" error and no indication of WHY the text
  // was missing. Surface the real reason (e.g. MAX_TOKENS truncation) here
  // instead, so logs actually explain the failure.
  if (!text) {
    throw new Error(`Gemini returned no text (finishReason: ${finishReason || 'unknown'})`);
  }

  return { text, tokIn, tokOut, model };
}

// ── Claude (Anthropic) ───────────────────────────────────────────────────
async function callClaude(model, system, user, maxTokens) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,           // ← plan cap applied here
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(40_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';
  const tokIn  = data.usage?.input_tokens  || 0;
  const tokOut = data.usage?.output_tokens || 0;

  return { text, tokIn, tokOut, model };
}

// ── ChatGPT (OpenAI) ──────────────────────────────────────────────────────
async function callGPT(model, system, user, maxTokens) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,           // ← plan cap applied here
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(40_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ChatGPT ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const tokIn  = data.usage?.prompt_tokens     || 0;
  const tokOut = data.usage?.completion_tokens || 0;

  return { text, tokIn, tokOut, model };
}

// ── DeepSeek (OpenAI-compatible) ─────────────────────────────────────────
async function callDeepSeek(model, system, user, maxTokens) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,           // ← plan cap applied here
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(40_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const tokIn  = data.usage?.prompt_tokens     || 0;
  const tokOut = data.usage?.completion_tokens || 0;

  return { text, tokIn, tokOut, model };
}

// ─────────────────────────────────────────────────────────────────────────
//  SAFE JSON PARSE
// ─────────────────────────────────────────────────────────────────────────
function safeParseJSON(text) {
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// Safety net: even though the prompt instructs the model to use the real
// price/indicator values verbatim, we don't trust an LLM to always comply
// exactly — so the real, server-computed numbers are force-written back
// into the result before it's ever returned to a user. This guarantees
// currentPrice/RSI/support/resistance shown to the user are always the
// real computed values, never whatever the model happened to output.
function groundResult(result, indicators) {
  if (!result || !indicators) return result;
  result.currentPrice = indicators.currentPrice;
  result.technicals = result.technicals || {};
  result.technicals.rsi = indicators.rsi;
  result.technicals.support = indicators.support;
  result.technicals.resistance = indicators.resistance;
  // COMPLIANCE: strip these even if an older client/model still sends them —
  // this endpoint must never surface a buy/sell/hold verdict or a price
  // prediction (see buildPrompt() note above).
  delete result.signal;
  delete result.priceTargets;
  delete result.expectedReturn;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
//  CONSENSUS BUILDER  (Pro + Elite — multiple models in parallel)
//  Majority-vote on signal, average on numeric fields.
// ─────────────────────────────────────────────────────────────────────────
// COMPLIANCE: consensus is now built from descriptive fields only
// (technicalScore, sentiment, riskLevel) — no signal vote, no price target
// averaging. See buildPrompt() note above for why.
function buildConsensus(results) {
  const valid = results.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  const sentimentCount = {};
  valid.forEach(r => { sentimentCount[r.sentiment] = (sentimentCount[r.sentiment] || 0) + 1; });
  const sentimentEntries = Object.entries(sentimentCount);
  const sentiment = sentimentEntries.length
    ? sentimentEntries.sort((a, b) => b[1] - a[1])[0][0]
    : 'neutral';

  const avg  = key => Math.round(valid.reduce((s, r) => s + (r[key] || 0), 0) / valid.length);
  const avgF = key => parseFloat((valid.reduce((s, r) => s + (r[key] || 0), 0) / valid.length).toFixed(2));

  const allReasonings  = valid.map(r => r.reasoning).filter(Boolean);
  const allRisks       = [...new Set(valid.flatMap(r => r.risks       || []))].slice(0, 5);
  const allWatchPoints = [...new Set(valid.flatMap(r => r.watchPoints || []))].slice(0, 4);

  const primary = valid[0];

  return {
    technicalScore: avg('technicalScore'),
    sentiment,
    currentPrice:   avgF('currentPrice'),
    riskLevel:      avg('riskLevel'),
    technicals:     primary.technicals,
    reasoning:      allReasonings.join(' | '),
    risks:          allRisks,
    watchPoints:    allWatchPoints,
    consensusFrom:  valid.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  MAIN ENTRY POINT
//  Called by aiRoutes. Returns { result, modelUsed, tokensInput,
//  tokensOutput, costUsd }
//
//  maxTokensPerRequest — set by enforceTokenQuota middleware (plan cap).
//  Falls back to DEFAULT_MAX_TOKENS[plan] if not provided.
// ─────────────────────────────────────────────────────────────────────────
/** True if this model is allowed to be called — either no quota list was
 *  passed (caller didn't check, e.g. internal/test usage) or the model's
 *  own monthly quota isn't exhausted yet, per attachAvailableModels. */
function isAvailable(availableModelKeys, modelKey) {
  if (!availableModelKeys) return true; // no restriction passed in
  return availableModelKeys.includes(modelKey);
}

async function analyzeStock({ stockSymbol, horizon, riskTolerance, exchange, userPlan, availableModelKeys }) {
  // Real data first — if this fails (Upstox not connected, symbol not
  // found, no historical candles), we throw here and never reach an AI
  // call at all. There is no fallback that lets the AI guess instead.
  let marketContext;
  try {
    marketContext = await fetchRealMarketContext(stockSymbol, exchange);
  } catch (err) {
    console.error(`[aiService] Real market data fetch failed for ${stockSymbol}:`, err.message);
    throw new AppError(
      `Data Unavailable: could not load real market data for ${stockSymbol.toUpperCase()} from Upstox. ${err.message}`,
      err.statusCode || 503
    );
  }

  const { system, user } = buildPrompt(stockSymbol, horizon, riskTolerance, marketContext);
  const plan = (userPlan || 'free').toLowerCase();

  // ── FREE: Gemini Flash only ───────────────────────────────────────────
  if (plan === 'free') {
    if (!isAvailable(availableModelKeys, 'gemini_flash')) {
      throw new Error('NO_MODELS_AVAILABLE');
    }
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    const maxTok = maxTokensFor(plan, 'gemini_flash');
    const raw = await callGemini(MODELS.GEMINI_FLASH, system, user, maxTok);
    const result = groundResult(safeParseJSON(raw.text), marketContext.indicators);
    if (!result) throw new Error('AI returned unparseable JSON');
    const breakdown = [{ modelKey: 'gemini_flash', model: MODELS.GEMINI_FLASH, tokIn: raw.tokIn, tokOut: raw.tokOut, cost: calcCost(MODELS.GEMINI_FLASH, raw.tokIn, raw.tokOut) }];
    return {
      result,
      modelUsed:    MODELS.GEMINI_FLASH,
      tokensInput:  raw.tokIn,
      tokensOutput: raw.tokOut,
      costUsd:      breakdown[0].cost,
      modelBreakdown: breakdown,
    };
  }

  // ── BASIC: Gemini Flash → DeepSeek V3 fallback ───────────────────────
  if (plan === 'basic') {
    const geminiOk   = isAvailable(availableModelKeys, 'gemini_flash');
    const deepseekOk = isAvailable(availableModelKeys, 'deepseek_v3');
    if (!geminiOk && !deepseekOk) throw new Error('NO_MODELS_AVAILABLE');

    let raw;
    let modelKey = 'gemini_flash';
    let modelLabel = MODELS.GEMINI_FLASH;
    if (geminiOk) {
      try {
        raw = await callGemini(MODELS.GEMINI_FLASH, system, user, maxTokensFor(plan, 'gemini_flash'));
      } catch (err) {
        console.warn('[aiService] Gemini Flash failed on Basic, falling back to DeepSeek V3:', err.message);
      }
    }
    if (!raw && deepseekOk) {
      modelKey = 'deepseek_v3';
      modelLabel = MODELS.DEEPSEEK_V3;
      raw = await callDeepSeek(MODELS.DEEPSEEK_V3, system, user, maxTokensFor(plan, 'deepseek_v3'));
    }
    if (!raw) throw new Error('NO_MODELS_AVAILABLE');
    const result = groundResult(safeParseJSON(raw.text), marketContext.indicators);
    if (!result) throw new Error('AI returned unparseable JSON');
    const breakdown = [{ modelKey, model: modelLabel, tokIn: raw.tokIn, tokOut: raw.tokOut, cost: calcCost(modelLabel, raw.tokIn, raw.tokOut) }];
    return {
      result,
      modelUsed:    modelLabel,
      tokensInput:  raw.tokIn,
      tokensOutput: raw.tokOut,
      costUsd:      breakdown[0].cost,
      modelBreakdown: breakdown,
    };
  }

  // ── PRO: Gemini + Claude Sonnet + ChatGPT in parallel; DeepSeek fallback
  if (plan === 'pro') {
    const calls = [];
    if (process.env.GEMINI_API_KEY  && isAvailable(availableModelKeys, 'gemini_flash'))  calls.push(callGemini(MODELS.GEMINI_FLASH, system, user, maxTokensFor(plan, 'gemini_flash')).then(r => ({ ...r, modelKey: 'gemini_flash' })).catch(e => { console.warn('[Pro] Gemini failed:', e.message); return null; }));
    if (process.env.CLAUDE_API_KEY  && isAvailable(availableModelKeys, 'claude_sonnet')) calls.push(callClaude(MODELS.CLAUDE_SONNET, system, user, maxTokensFor(plan, 'claude_sonnet')).then(r => ({ ...r, modelKey: 'claude_sonnet' })).catch(e => { console.warn('[Pro] Claude failed:', e.message); return null; }));
    if (process.env.OPENAI_API_KEY  && isAvailable(availableModelKeys, 'gpt4o'))         calls.push(callGPT(MODELS.GPT4O, system, user, maxTokensFor(plan, 'gpt4o')).then(r => ({ ...r, modelKey: 'gpt4o' })).catch(e => { console.warn('[Pro] ChatGPT failed:', e.message); return null; }));

    let raws = (await Promise.all(calls)).filter(Boolean);

    if (raws.length === 0) {
      if (!isAvailable(availableModelKeys, 'deepseek_v3')) {
        throw new Error('NO_MODELS_AVAILABLE');
      }
      if (!process.env.DEEPSEEK_API_KEY) {
        console.warn('[aiService] All Pro models failed/exhausted and DEEPSEEK_API_KEY not set; no models available');
        throw new Error('NO_MODELS_AVAILABLE');
      }
      console.warn('[aiService] All Pro models failed or exhausted; falling back to DeepSeek V3');
      let dsRaw;
      try {
        dsRaw = await callDeepSeek(MODELS.DEEPSEEK_V3, system, user, maxTokensFor(plan, 'deepseek_v3'));
      } catch (err) {
        console.warn('[Pro] DeepSeek fallback failed:', err.message);
        throw new Error('NO_MODELS_AVAILABLE');
      }
      const result = groundResult(safeParseJSON(dsRaw.text), marketContext.indicators);
      if (!result) throw new Error('AI returned unparseable JSON');
      const breakdown = [{ modelKey: 'deepseek_v3', model: MODELS.DEEPSEEK_V3, tokIn: dsRaw.tokIn, tokOut: dsRaw.tokOut, cost: calcCost(MODELS.DEEPSEEK_V3, dsRaw.tokIn, dsRaw.tokOut) }];
      return {
        result,
        modelUsed:    MODELS.DEEPSEEK_V3,
        tokensInput:  dsRaw.tokIn,
        tokensOutput: dsRaw.tokOut,
        costUsd:      breakdown[0].cost,
        modelBreakdown: breakdown,
      };
    }

    const parsed = raws.map(r => safeParseJSON(r.text));
    const consensusResult = groundResult(buildConsensus(parsed), marketContext.indicators);
    if (!consensusResult) throw new Error('AI returned unparseable JSON from all models');

    const breakdown = raws.map(r => ({ modelKey: r.modelKey, model: r.model, tokIn: r.tokIn, tokOut: r.tokOut, cost: calcCost(r.model, r.tokIn, r.tokOut) }));
    const totalTokIn  = breakdown.reduce((s, b) => s + b.tokIn,  0);
    const totalTokOut = breakdown.reduce((s, b) => s + b.tokOut, 0);
    const totalCost   = breakdown.reduce((s, b) => s + b.cost,   0);
    const modelsUsed  = breakdown.map(b => b.model).join('+');

    return {
      result:       consensusResult,
      modelUsed:    modelsUsed,
      tokensInput:  totalTokIn,
      tokensOutput: totalTokOut,
      costUsd:      totalCost,
      modelBreakdown: breakdown,
    };
  }

  // ── ELITE: all 4 flagship models in parallel consensus ────────────────
  if (plan === 'elite') {
    const eliteCalls = [
      (process.env.GEMINI_API_KEY   && isAvailable(availableModelKeys, 'gemini_pro'))    ? callGemini(MODELS.GEMINI_PRO,   system, user, maxTokensFor(plan, 'gemini_pro')).then(r => ({ ...r, modelKey: 'gemini_pro' })).catch(e => { console.warn('[Elite] Gemini Pro failed:', e.message); return null; }) : Promise.resolve(null),
      (process.env.CLAUDE_API_KEY   && isAvailable(availableModelKeys, 'claude_opus4'))  ? callClaude(MODELS.CLAUDE_OPUS,  system, user, maxTokensFor(plan, 'claude_opus4')).then(r => ({ ...r, modelKey: 'claude_opus4' })).catch(e => { console.warn('[Elite] Claude Opus failed:', e.message); return null; }) : Promise.resolve(null),
      (process.env.OPENAI_API_KEY   && isAvailable(availableModelKeys, 'gpt4o_high'))    ? callGPT(MODELS.GPT4O_HIGH,      system, user, maxTokensFor(plan, 'gpt4o_high')).then(r => ({ ...r, modelKey: 'gpt4o_high' })).catch(e => { console.warn('[Elite] ChatGPT failed:', e.message); return null; }) : Promise.resolve(null),
      (process.env.DEEPSEEK_API_KEY && isAvailable(availableModelKeys, 'deepseek_r1'))   ? callDeepSeek(MODELS.DEEPSEEK_R1, system, user, maxTokensFor(plan, 'deepseek_r1')).then(r => ({ ...r, modelKey: 'deepseek_r1' })).catch(e => { console.warn('[Elite] DeepSeek R1 failed:', e.message); return null; }) : Promise.resolve(null),
    ];

    const raws = (await Promise.all(eliteCalls)).filter(Boolean);
    if (raws.length === 0) throw new Error('NO_MODELS_AVAILABLE');

    const parsed = raws.map(r => safeParseJSON(r.text));

    const modelDebate = raws.map((r, i) => ({
      model:          r.model,
      technicalScore: parsed[i]?.technicalScore || 50,
      sentiment:      parsed[i]?.sentiment       || 'neutral',
      reasoning:      parsed[i]?.reasoning       || '',
    }));

    const consensusResult = groundResult(buildConsensus(parsed.filter(Boolean)), marketContext.indicators);
    if (!consensusResult) throw new Error('AI returned unparseable JSON from all models');

    consensusResult.modelDebate = modelDebate;  // Elite-only field

    const breakdown = raws.map(r => ({ modelKey: r.modelKey, model: r.model, tokIn: r.tokIn, tokOut: r.tokOut, cost: calcCost(r.model, r.tokIn, r.tokOut) }));
    const totalTokIn  = breakdown.reduce((s, b) => s + b.tokIn,  0);
    const totalTokOut = breakdown.reduce((s, b) => s + b.tokOut, 0);
    const totalCost   = breakdown.reduce((s, b) => s + b.cost,   0);
    const modelsUsed  = breakdown.map(b => b.model).join('+');

    return {
      result:       consensusResult,
      modelUsed:    modelsUsed,
      tokensInput:  totalTokIn,
      tokensOutput: totalTokOut,
      costUsd:      totalCost,
      modelBreakdown: breakdown,
    };
  }

  // Fallback — unknown plan treated as free
  return analyzeStock({ stockSymbol, horizon, riskTolerance, userPlan: 'free', availableModelKeys });
}

// ─────────────────────────────────────────────────────────────────────────
//  GENERIC AI INSIGHT — powers Trade Ideas, Portfolio Health, Market Brief,
//  Option Strategy Advisor, Backtest Advisor, Multi-Timeframe Confluence.
//  Unlike analyzeStock() this returns plain commentary text, not a forced
//  JSON signal — these features are about explaining/synthesizing REAL data
//  already fetched from Upstox, not generating a new Buy/Sell/Hold verdict.
// ─────────────────────────────────────────────────────────────────────────
// COMPLIANCE NOTE: these prompts are written to produce descriptive,
// educational commentary — not stock-specific recommendations, strategy
// suggestions, or trading calls. SEBI's Research Analyst / Investment
// Adviser regulations cover "trading calls" and portfolio-level advice
// regardless of whether a human or an AI produced them, and this app is
// not SEBI-registered. Each prompt below explicitly instructs the model to
// describe what the data shows and explain general concepts, and NOT to
// tell the user what action to take.
const INSIGHT_PROMPTS = {
  tradeIdeas: (ctx) => `You are a markets data assistant. Below are REAL scan results from a live NSE/BSE market scanner (real prices, real volume, real technical conditions — not simulated). For the 3-5 most notable entries, describe in plain language WHAT technical condition triggered the match (e.g. "RSI dropped below 30 while volume rose") and what that condition has generally meant historically. Do NOT recommend buying, selling, or entering a position, and do NOT rank them as "best" opportunities — just describe the setups factually and note the risk in each. Scan type: ${ctx.scanType}. Results:\n${JSON.stringify(ctx.matches)}`,

  portfolioHealth: (ctx) => `You are a portfolio data reviewer. Below is a trader's REAL current holdings with real live prices (not simulated). Describe, using the actual numbers given: concentration levels (is any single stock or sector a large % of the total?), and any correlated positions you can identify. Flag these as observations only — do NOT tell the user to trim, add, sell, or rebalance any specific position; simply describe what the numbers show so the user can decide for themselves. Holdings:\n${JSON.stringify(ctx.holdings)}`,

  marketBrief: (ctx) => `You are a markets writer. Write a 3-4 sentence factual morning market brief for Indian traders using ONLY these REAL numbers (not simulated) — today's NIFTY/SENSEX/BANKNIFTY levels and change%, plus the real top gainers/losers given. Be concise and factual, no invented reasons for moves unless obvious from the data, and do not suggest any action the reader should take. Data:\n${JSON.stringify(ctx.marketData)}`,

  optionStrategy: (ctx) => `You are an options data educator. Below is a REAL option chain snapshot (real spot price, real PCR, real Max Pain, real OI, not simulated) for ${ctx.underlying} expiring ${ctx.expiry}. Explain in plain language what this specific combination of PCR, Max Pain, and OI concentration typically indicates about market positioning (e.g. what a PCR in this range or an OI concentration at this strike generally suggests). Do NOT suggest or name a specific strategy to enter (no "consider a straddle/spread/etc."); keep it educational — describing the data, not prescribing an action. Include a note on the general risks of options trading. Data:\n${JSON.stringify(ctx.chainSummary)}`,

  backtestAdvisor: (ctx) => `You are a quant data reviewer. Below are REAL backtest results (real historical trades on real Upstox candle data, not simulated) for a ${ctx.strategy} strategy on ${ctx.symbol}. Explain in plain English what the win rate/drawdown/avg-return numbers actually mean statistically, and what limitations or weaknesses this kind of backtest generally has (e.g. overfitting, regime dependence, no slippage modeled). Do NOT tell the user whether to use this strategy live or not — describe the numbers and their limitations only. Results:\n${JSON.stringify(ctx.results)}`,

  multiTimeframe: (ctx) => `You are a technical data analyst. Below are REAL daily and weekly indicator readings (real RSI/MACD/trend from real Upstox candles, not simulated) for ${ctx.symbol}. Describe factually how the daily and weekly readings compare — e.g. "daily RSI shows X while the weekly trend indicator shows Y" — and note plainly if the two timeframes agree or conflict. Do NOT state or imply what the user should do with this information. Data:\n${JSON.stringify(ctx.timeframes)}`,
};

const INSIGHT_SYSTEM = 'You are a careful, honest markets data assistant, not an investment adviser. You only comment on the real data given to you — never invent numbers, news, or reasons not present in the input. You describe what the data shows and explain general market concepts, but you NEVER tell the user to buy, sell, hold, or enter/exit any position, and you never predict future prices. If the data is insufficient to say something meaningful, say so plainly.';

// Plain-text (non-JSON-forced) callers for insight generation — these
// features return prose commentary, not a structured signal, so they must
// NOT use the JSON-forced callGemini/callGPT/callDeepSeek above (which would
// either reject plain prose or truncate it awkwardly into a JSON shape).
async function callGeminiPlain(model, prompt, systemText = INSIGHT_SYSTEM) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  if (!text) throw new Error('Gemini returned no text');
  return { text, model };
}

async function callClaudePlain(model, prompt, systemText = INSIGHT_SYSTEM) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 700, system: systemText, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  if (!text) throw new Error('Claude returned no text');
  return { text, model };
}

async function callDeepSeekPlain(model, prompt, systemText = INSIGHT_SYSTEM) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: systemText }, { role: 'user', content: prompt }], temperature: 0.3, max_tokens: 700 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('DeepSeek returned no text');
  return { text, model };
}

// FIX: previously every plan got the exact same Gemini Flash commentary on
// Trade Ideas / Portfolio Health / Market Brief / Option Strategy /
// Backtest Advisor / Multi-Timeframe — the model selector on the Analysis
// tab had no effect anywhere else. This now cascades through the actual
// model(s) each plan pays for (config/plans.js), same spirit as
// analyzeStock(), and falls back down the chain (never all the way to
// nothing) if a higher model is temporarily unavailable.
function insightCascadeForPlan(plan) {
  switch (plan) {
    case 'elite':
      return [
        { fn: callClaudePlain,   model: MODELS.CLAUDE_OPUS  },
        { fn: callGeminiPlain,   model: MODELS.GEMINI_PRO   },
        { fn: callDeepSeekPlain, model: MODELS.DEEPSEEK_R1  },
        { fn: callGeminiPlain,   model: MODELS.GEMINI_FLASH },
      ];
    case 'pro':
      return [
        { fn: callClaudePlain,   model: MODELS.CLAUDE_SONNET },
        { fn: callDeepSeekPlain, model: MODELS.DEEPSEEK_V3   },
        { fn: callGeminiPlain,   model: MODELS.GEMINI_FLASH  },
      ];
    case 'basic':
      return [
        { fn: callDeepSeekPlain, model: MODELS.DEEPSEEK_V3  },
        { fn: callGeminiPlain,   model: MODELS.GEMINI_FLASH },
      ];
    default: // free
      return [{ fn: callGeminiPlain, model: MODELS.GEMINI_FLASH }];
  }
}

async function getAIInsight(kind, context, plan = 'free') {
  const promptFn = INSIGHT_PROMPTS[kind];
  if (!promptFn) throw new Error(`Unknown insight kind: ${kind}`);
  const prompt = promptFn(context);

  const cascade = insightCascadeForPlan(plan);
  let lastErr;
  for (const step of cascade) {
    try {
      const { text, model } = await step.fn(step.model, prompt);
      return { text, modelUsed: model || step.model };
    } catch (err) {
      lastErr = err;
      console.warn(`[getAIInsight:${kind}] ${step.model} failed, trying next in cascade:`, err.message);
    }
  }
  throw lastErr || new Error('AI is not configured on the server.');
}

module.exports = {
  analyzeStock, getAIInsight, MODELS, DEFAULT_MAX_TOKENS, maxTokensFor,
  // Exported so /api/ai/chat (aiRoutes.js) can reuse the SAME per-plan model
  // cascade and calling code that /api/ai/insight already uses, instead of
  // its own separate hardcoded deepseek→claude-only logic (see FIX note in
  // aiRoutes.js's chat handler for the item this resolves — "AI Assistant
  // wasn't using DeepSeek according to plan").
  insightCascadeForPlan, callGeminiPlain, callClaudePlain, callDeepSeekPlain,
};
