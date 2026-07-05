// services/aiService.js
// ══════════════════════════════════════════════════════════════════════════
//  TradeMind Multi-Model AI Service
//  Handles Gemini, Claude, GPT-4o, and DeepSeek calls directly from Node.
//  No external AI engine process needed — just set the API keys in .env.
//
//  Plan → model routing:
//   free    → Gemini Flash only (fallback: none)
//   basic   → Gemini Flash primary, DeepSeek V3 fallback
//   pro     → Gemini Flash + Claude Sonnet (limited) + GPT-4o (limited)
//             + DeepSeek V3 fallback; consensus result
//   elite   → Gemini Pro + Claude Opus + GPT-4o (high) + DeepSeek R1
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
//  PROMPT BUILDER
//  Returns a structured system + user message pair for stock analysis.
// ─────────────────────────────────────────────────────────────────────────
function buildPrompt(stockSymbol, horizon, riskTolerance) {
  const system = `You are TradeMind AI, an expert Indian stock market analyst. 
Analyse NSE/BSE stocks and return ONLY a JSON object — no prose, no markdown fences, no preamble.
Be concise. Prices in INR. All percentage values as numbers (not strings).`;

  const user = `Analyse the stock: ${stockSymbol.toUpperCase()}
Horizon: ${horizon || '1 month'}
Risk tolerance: ${riskTolerance || 'moderate'}

Return a JSON object with this exact structure:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <integer 0-100>,
  "currentPrice": <number>,
  "priceTargets": {
    "oneWeek": <number>,
    "oneMonth": <number>,
    "threeMonths": <number>
  },
  "expectedReturn": <number, percentage>,
  "riskScore": <integer 1-10>,
  "technicals": {
    "rsi": <number>,
    "rsiSignal": "oversold" | "neutral" | "overbought",
    "trend": "bullish" | "bearish" | "sideways",
    "support": <number>,
    "resistance": <number>,
    "macd": "bullish_crossover" | "bearish_crossover" | "neutral"
  },
  "fundamentals": {
    "pe": <number | null>,
    "pb": <number | null>,
    "marketCap": "<string, e.g. ₹2.4T>",
    "sector": "<string>"
  },
  "reasoning": "<2-3 sentence investment thesis>",
  "risks": ["<risk 1>", "<risk 2>", "<risk 3>"],
  "catalysts": ["<catalyst 1>", "<catalyst 2>"]
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

// ── GPT-4o (OpenAI) ──────────────────────────────────────────────────────
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
    throw new Error(`GPT-4o ${res.status}: ${errText.slice(0, 200)}`);
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

// ─────────────────────────────────────────────────────────────────────────
//  CONSENSUS BUILDER  (Pro + Elite — multiple models in parallel)
//  Majority-vote on signal, average on numeric fields.
// ─────────────────────────────────────────────────────────────────────────
function buildConsensus(results) {
  const valid = results.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  const signalCount = {};
  valid.forEach(r => { signalCount[r.signal] = (signalCount[r.signal] || 0) + 1; });
  const signal = Object.entries(signalCount).sort((a, b) => b[1] - a[1])[0][0];

  const avg  = key => Math.round(valid.reduce((s, r) => s + (r[key] || 0), 0) / valid.length);
  const avgF = key => parseFloat((valid.reduce((s, r) => s + (r[key] || 0), 0) / valid.length).toFixed(2));

  // FIX: dot-path getter + averager so nested fields (e.g. "priceTargets.oneWeek")
  // are actually read and averaged across models. Previously this used the same
  // bracket lookup as the flat avg/avgF helpers, so r['priceTargets.oneWeek']
  // was always undefined and the consensus silently fell back to the primary
  // model's number on every request — i.e. price targets were NEVER actually
  // averaged across models, despite that being the whole point of consensus.
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
    fundamentals:   primary.fundamentals,
    reasoning:      allReasonings.join(' | '),
    risks:          allRisks,
    catalysts:      allCatalysts,
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

async function analyzeStock({ stockSymbol, horizon, riskTolerance, userPlan, availableModelKeys }) {
  const { system, user } = buildPrompt(stockSymbol, horizon, riskTolerance);
  const plan = (userPlan || 'free').toLowerCase();

  // ── FREE: Gemini Flash only ───────────────────────────────────────────
  if (plan === 'free') {
    if (!isAvailable(availableModelKeys, 'gemini_flash')) {
      throw new Error('NO_MODELS_AVAILABLE');
    }
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    const maxTok = maxTokensFor(plan, 'gemini_flash');
    const raw = await callGemini(MODELS.GEMINI_FLASH, system, user, maxTok);
    const result = safeParseJSON(raw.text);
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
    const result = safeParseJSON(raw.text);
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

  // ── PRO: Gemini + Claude Sonnet + GPT-4o in parallel; DeepSeek fallback
  if (plan === 'pro') {
    const calls = [];
    if (process.env.GEMINI_API_KEY  && isAvailable(availableModelKeys, 'gemini_flash'))  calls.push(callGemini(MODELS.GEMINI_FLASH, system, user, maxTokensFor(plan, 'gemini_flash')).then(r => ({ ...r, modelKey: 'gemini_flash' })).catch(e => { console.warn('[Pro] Gemini failed:', e.message); return null; }));
    if (process.env.CLAUDE_API_KEY  && isAvailable(availableModelKeys, 'claude_sonnet')) calls.push(callClaude(MODELS.CLAUDE_SONNET, system, user, maxTokensFor(plan, 'claude_sonnet')).then(r => ({ ...r, modelKey: 'claude_sonnet' })).catch(e => { console.warn('[Pro] Claude failed:', e.message); return null; }));
    if (process.env.OPENAI_API_KEY  && isAvailable(availableModelKeys, 'gpt4o'))         calls.push(callGPT(MODELS.GPT4O, system, user, maxTokensFor(plan, 'gpt4o')).then(r => ({ ...r, modelKey: 'gpt4o' })).catch(e => { console.warn('[Pro] GPT-4o failed:', e.message); return null; }));

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
      const result = safeParseJSON(dsRaw.text);
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
    const consensusResult = buildConsensus(parsed);
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
      (process.env.OPENAI_API_KEY   && isAvailable(availableModelKeys, 'gpt4o_high'))    ? callGPT(MODELS.GPT4O_HIGH,      system, user, maxTokensFor(plan, 'gpt4o_high')).then(r => ({ ...r, modelKey: 'gpt4o_high' })).catch(e => { console.warn('[Elite] GPT-4o failed:', e.message); return null; }) : Promise.resolve(null),
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

    const consensusResult = buildConsensus(parsed.filter(Boolean));
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

module.exports = { analyzeStock, MODELS, DEFAULT_MAX_TOKENS, maxTokensFor };
