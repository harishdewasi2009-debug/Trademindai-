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
async function fetchRealMarketContext(stockSymbol, exchange) {
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

// ─────────────────────────────────────────────────────────────────────────
//  PROMPT BUILDER
//  Returns a structured system + user message pair for stock analysis.
//  The AI is given REAL price + indicator data pulled from Upstox — it is
//  explicitly told to analyze only the numbers provided, never to invent
//  or estimate a price/indicator value on its own.
// ─────────────────────────────────────────────────────────────────────────
function buildPrompt(stockSymbol, horizon, riskTolerance, marketContext) {
  const { quote, indicators } = marketContext;

  const system = `You are TradeMind AI, an expert Indian stock market analyst.
You will be given REAL, live market data (price, volume, and computed technical indicators) for one NSE/BSE stock, fetched moments ago from Upstox. Base your entire analysis strictly on the numbers provided below — never invent, estimate, or recall a price or indicator value from your own training data or general knowledge, even if you believe you know this stock. If the provided data seems insufficient for some part of the analysis, say so in "reasoning" rather than guessing.
Return ONLY a JSON object — no prose, no markdown fences, no preamble. Prices in INR. All percentage values as numbers (not strings). The "currentPrice" field in your response MUST exactly equal the currentPrice given to you below.`;

  const user = `Analyse the stock: ${stockSymbol.toUpperCase()}
Horizon: ${horizon || '1 month'}
Risk tolerance: ${riskTolerance || 'moderate'}

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
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <integer 0-100>,
  "currentPrice": <number, must equal the current price given above>,
  "priceTargets": {
    "oneWeek": <number>,
    "oneMonth": <number>,
    "threeMonths": <number>
  },
  "expectedReturn": <number, percentage>,
  "riskScore": <integer 1-10>,
  "technicals": {
    "rsi": ${indicators.rsi},
    "rsiSignal": "oversold" | "neutral" | "overbought",
    "trend": "bullish" | "bearish" | "sideways",
    "support": ${indicators.support},
    "resistance": ${indicators.resistance},
    "macd": "bullish_crossover" | "bearish_crossover" | "neutral"
  },
  "reasoning": "<2-3 sentence investment thesis grounded in the data above>",
  "risks": ["<risk 1>", "<risk 2>", "<risk 3>"],
  "catalysts": ["<catalyst 1>", "<catalyst 2>"]
}`;

  return { system, user };
}

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
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const tokIn  = data.usageMetadata?.promptTokenCount     || 0;
  const tokOut = data.usageMetadata?.candidatesTokenCount || 0;

  return { text, tokIn, tokOut, model };
}

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
      max_tokens: maxTokens,
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
      max_tokens: maxTokens,
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
      max_tokens: maxTokens,
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

function safeParseJSON(text) {
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function groundResult(result, indicators) {
  if (!result || !indicators) return result;
  result.currentPrice = indicators.currentPrice;
  result.technicals = result.technicals || {};
  result.technicals.rsi = indicators.rsi;
  result.technicals.support = indicators.support;
  result.technicals.resistance = indicators.resistance;
  return result;
}

function buildConsensus(results) {
  const valid = results.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  const signalCount = {};
  valid.forEach(r => { signalCount[r.signal] = (signalCount[r.signal] || 0) + 1; });
  const signal = Object.entries(signalCount).sort((a, b) => b[1] - a[1])[0][0];

  const avg  = key => Math.round(valid.reduce((s, r) => s + (r[key] || 0), 0) / valid.length);
  const avgF = key => parseFloat((valid.reduce((s, r) => s + (r[key] || 0), 0) / valid.length).toFixed(2));

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const avgNested = path => {
    const vals = valid.map(r => getPath(r, path)).filter(v => typeof v === 'number' && !isNaN(v));
    if (!vals.length) return null;
    return parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
  };

  const allReasonings = valid.map(r => r.reasoning).filter(Boolean);
  const allRisks      = [...new Set(valid.flatMap(r => r.risks      || []))].slice(0, 5);
  const allCatalysts  = [...new Set(valid.flatMap(r => r.catalysts  || []))].slice(0, 4);

  const primary = valid[0];

  return {
    signal,
    confidence:     avg('confidence'),
    currentPrice:   avgF('currentPrice'),
    priceTargets: {
      oneWeek:      avgNested('priceTargets.oneWeek')     ?? primary.priceTargets?.oneWeek,
      oneMonth:     avgNested('priceTargets.oneMonth')    ?? primary.priceTargets?.oneMonth,
      threeMonths:  avgNested('priceTargets.threeMonths') ?? primary.priceTargets?.threeMonths,
    },
    expectedReturn: avgF('expectedReturn'),
    riskScore:      avg('riskScore'),
    technicals:     primary.technicals,
    reasoning:      allReasonings.join(' | '),
    risks:          allRisks,
    catalysts:      allCatalysts,
    consensusFrom:  valid.length,
  };
}

function isAvailable(availableModelKeys, modelKey) {
  if (!availableModelKeys) return true;
  return availableModelKeys.includes(modelKey);
}

async function analyzeStock({ stockSymbol, horizon, riskTolerance, exchange, userPlan, availableModelKeys }) {
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
      model:      r.model,
      signal:     parsed[i]?.signal     || 'HOLD',
      confidence: parsed[i]?.confidence || 0,
      reasoning:  parsed[i]?.reasoning  || '',
    }));

    const consensusResult = groundResult(buildConsensus(parsed.filter(Boolean)), marketContext.indicators);
    if (!consensusResult) throw new Error('AI returned unparseable JSON from all models');

    consensusResult.modelDebate = modelDebate;

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

  return analyzeStock({ stockSymbol, horizon, riskTolerance, userPlan: 'free', availableModelKeys });
}

const INSIGHT_PROMPTS = {
  tradeIdeas: (ctx) => `You are a trading assistant. Below are REAL scan results from a live NSE/BSE market scanner (real prices, real volume, real technical conditions — not simulated). Pick the 3-5 most compelling setups and explain briefly why each stands out, in plain language a retail trader would understand. Be direct about risk too, don't just hype. Scan type: ${ctx.scanType}. Results:\n${JSON.stringify(ctx.matches)}`,

  portfolioHealth: (ctx) => `You are a portfolio risk reviewer. Below is a trader's REAL current holdings with real live prices (not simulated). Comment on: concentration risk (any single stock or sector too large?), correlated positions, and 2-3 concrete suggestions. Be specific using the actual numbers given, not generic advice. Holdings:\n${JSON.stringify(ctx.holdings)}`,

  marketBrief: (ctx) => `You are a markets writer. Write a 3-4 sentence morning market brief for Indian traders using ONLY these REAL numbers (not simulated) — today's NIFTY/SENSEX/BANKNIFTY levels and change%, plus the real top gainers/losers given. Be concise and factual, no invented reasons for moves unless obvious from the data. Data:\n${JSON.stringify(ctx.marketData)}`,

  optionStrategy: (ctx) => `You are an options strategy advisor. Below is a REAL option chain snapshot (real spot price, real PCR, real Max Pain, real OI, not simulated) for ${ctx.underlying} expiring ${ctx.expiry}. Suggest 1-2 strategies (e.g. straddle, bull call spread, iron condor) that fit this real setup, with brief reasoning grounded in the actual PCR/Max Pain/OI values given. Include the key risk. Data:\n${JSON.stringify(ctx.chainSummary)}`,

  backtestAdvisor: (ctx) => `You are a quant strategy reviewer. Below are REAL backtest results (real historical trades on real Upstox candle data, not simulated) for a ${ctx.strategy} strategy on ${ctx.symbol}. Critique the strategy in plain English: what does the win rate/drawdown/avg-return actually tell us, and what's the biggest weakness a trader should know before using this live? Results:\n${JSON.stringify(ctx.results)}`,

  multiTimeframe: (ctx) => `You are a technical analyst. Below are REAL daily and weekly indicator readings (real RSI/MACD/trend from real Upstox candles, not simulated) for ${ctx.symbol}. Synthesize a short multi-timeframe view — e.g. "bullish daily momentum but weak weekly trend" if that's what the data shows. Be honest if the timeframes agree or conflict. Data:\n${JSON.stringify(ctx.timeframes)}`,
};

async function getAIInsight(kind, context) {
  const promptFn = INSIGHT_PROMPTS[kind];
  if (!promptFn) throw new Error(`Unknown insight kind: ${kind}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('AI is not configured on the server (GEMINI_API_KEY missing).');

  const prompt = promptFn(context);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.GEMINI_FLASH}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: 'You are a careful, honest markets assistant. You only comment on the real data given to you — never invent numbers, news, or reasons not present in the input. If the data is insufficient to say something meaningful, say so plainly.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('AI returned an empty response.');
  return text.trim();
}

module.exports = { analyzeStock, getAIInsight, MODELS, DEFAULT_MAX_TOKENS, maxTokensFor };
