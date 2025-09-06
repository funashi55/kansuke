import path from 'node:path';
import axios from 'axios';
import dayjs from 'dayjs';

// ------------------------- Config -------------------------
const DEFAULT_LANGUAGE = 'ja';
const DEFAULT_COUNTRY_REGION = 'jp';
const DEFAULT_RADIUS_M = 1500; // Search radius in meters
const DEFAULT_MAX_RESULTS = 6;
const CANDIDATE_FETCH_MULTIPLIER = 4; // pull more, then filter/sort down
const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20240620';
const DEFAULT_STATION_SEARCH_RADIUS_M = 2000; // station lookup radius
const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';

// ------------------------- Utils --------------------------
function assertEnv() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error('GOOGLE_MAPS_API_KEY is not set. Export it before running.');
  }
  return key;
}

function getAnthropicKey() {
  const k = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  return k || null;
}

function getGeminiKey() {
  // Prefer GOOGLE_API_KEY (Google AI Studio), fall back to GEMINI_API_KEY / GOOGLE_GENAI_API_KEY
  return (
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    null
  );
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function ensureString(v, name) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v.trim();
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

// Parse "YYYY-MM-DD HH:mm" or ISO string; returns { year, month, day, hour, minute }
function parseLocalDateTime(s) {
  const raw = (s ?? '').toString();
  // Basic sanitization: trim, normalize colon, strip Japanese approximate markers
  let str = raw.trim()
    .replace(/[：]/g, ':') // full-width colon to half-width
    .replace(/[\s]*(ごろ|頃)[\s]*$/i, '');

  // Accept general ISO-8601 strings if Date can parse and contains 'T'
  const dISO = new Date(str);
  if (!isNaN(dISO.getTime()) && str.includes('T')) {
    return {
      year: dISO.getFullYear(),
      month: dISO.getMonth() + 1,
      day: dISO.getDate(),
      hour: dISO.getHours(),
      minute: dISO.getMinutes(),
    };
  }

  // Support forms like "YYYY-MM-DD HH:mm" or "YYYY/MM/DD HH:mm[:ss]"
  let m = str.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) {
    const [_, y, mo, d2, h, mi] = m;
    return {
      year: Number(y),
      month: Number(mo),
      day: Number(d2),
      hour: Number(h),
      minute: Number(mi),
    };
  }

  // Support Japanese time notation: "YYYY-MM-DD HH時" or "YYYY/MM/DD HH時MM分"
  m = str.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2})時(?:(\d{1,2})分?)?$/);
  if (m) {
    const [_, y, mo, d2, h, miOpt] = m;
    return {
      year: Number(y),
      month: Number(mo),
      day: Number(d2),
      hour: Number(h),
      minute: Number(miOpt ?? 0),
    };
  }

  throw new Error('dateTime must be ISO or "YYYY-MM-DD HH:mm"');
}

// Day of week from calendar date (0=Sun..6=Sat), invariant across time zones
function dayOfWeekFromDate(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(2, 4));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Check if a place with opening_hours.periods is open at given local day/time
function isOpenAtTime(openingHoursPeriods, targetDow, targetMinutes) {
  if (!Array.isArray(openingHoursPeriods) || openingHoursPeriods.length === 0) return null;
  const WEEK_MIN = 7 * 1440;
  const t1 = targetDow * 1440 + targetMinutes;
  const t2 = t1 + WEEK_MIN; // handle wrap intervals by checking second window

  for (const p of openingHoursPeriods) {
    const o = p.open;
    if (!o || typeof o.day !== 'number' || !o.time) continue;
    const c = p.close; // may be undefined for 24h open starting at o
    const openIdx = o.day * 1440 + (hhmmToMinutes(o.time) ?? 0);
    let closeIdx;
    if (!c) {
      // No close specified: treat as 24h starting at o until next day's same time
      closeIdx = openIdx + 24 * 60;
    } else {
      const closeMin = hhmmToMinutes(c.time) ?? 0;
      closeIdx = c.day * 1440 + closeMin;
      // If close before open in week index, it wraps to next week
      if (closeIdx <= openIdx) closeIdx += WEEK_MIN;
    }
    // Check in both windows
    if ((t1 >= openIdx && t1 < closeIdx) || (t2 >= openIdx && t2 < closeIdx)) return true;
  }
  return false;
}

function mapGenreToTypeAndKeyword(genre) {
  const g = genre.toLowerCase();
  if (g.includes('居酒屋')) return { type: 'restaurant', keyword: '居酒屋' };
  if (g.includes('バー') || g.includes('bar')) return { type: 'bar', keyword: genre };
  if (g.includes('焼肉')) return { type: 'restaurant', keyword: '焼肉' };
  if (g.includes('焼き鳥') || g.includes('焼鳥')) return { type: 'restaurant', keyword: '焼き鳥' };
  if (g.includes('寿司') || g.includes('すし')) return { type: 'restaurant', keyword: '寿司' };
  if (g.includes('ラーメン')) return { type: 'restaurant', keyword: 'ラーメン' };
  if (g.includes('中華') || g.includes('中国')) return { type: 'restaurant', keyword: '中華' };
  if (g.includes('魚') || g.includes('海鮮')) return { type: 'restaurant', keyword: '魚料理' };
  if (g.includes('肉')) return { type: 'restaurant', keyword: '肉料理' };
  if (g.includes('イタリア') || g.includes('italian')) return { type: 'restaurant', keyword: 'イタリアン' };
  if (g.includes('フレンチ') || g.includes('フランス')) return { type: 'restaurant', keyword: 'フレンチ' };
  return { type: 'restaurant', keyword: genre };
}

function splitList(str) {
  if (typeof str !== 'string') return [];
  return str
    .split(/[、,\/|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseGenres(primaryGenre, genresArr) {
  if (Array.isArray(genresArr) && genresArr.length) {
    return [...new Set(genresArr.map((g) => String(g).trim()).filter(Boolean))];
  }
  if (typeof primaryGenre === 'string') {
    const list = splitList(primaryGenre);
    if (list.length) return [...new Set(list)];
  }
  return primaryGenre ? [String(primaryGenre)] : [];
}

function priceLevelFromBudgetYen(minYen, maxYen) {
  // Rough mapping for JP contexts; adjust as desired
  if (maxYen == null && minYen == null) return null;
  const max = Number(maxYen);
  if (Number.isFinite(max)) {
    if (max <= 1000) return 0; // inexpensive
    if (max <= 3000) return 1;
    if (max <= 6000) return 2;
    if (max <= 12000) return 3;
    return 4;
  }
  const min = Number(minYen);
  if (Number.isFinite(min)) {
    if (min >= 12000) return 4;
    if (min >= 6000) return 3;
    if (min >= 3000) return 2;
    if (min >= 1000) return 1;
    return 0;
  }
  return null;
}

// Indicative yen bands for Google price_level (rough JP mapping)
function priceLevelIndicativeYen(priceLevel) {
  switch (priceLevel) {
    case 0: return { min: 0, max: 1000 };
    case 1: return { min: 1000, max: 3000 };
    case 2: return { min: 3000, max: 6000 };
    case 3: return { min: 6000, max: 12000 };
    case 4: return { min: 12000, max: 999999 };
    default: return null;
  }
}

function inYenRange(priceLevel, rangeMin, rangeMax) {
  if (priceLevel == null) return false;
  const band = priceLevelIndicativeYen(priceLevel);
  if (!band) return false;
  return !(band.max < rangeMin || band.min > rangeMax);
}

// ------------------------- Validation/Sanitization ---------
function sanitizeNLPlan(raw) {
  const out = {
    areas: Array.isArray(raw.areas) ? raw.areas.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 3) : [],
    genres: Array.isArray(raw.genres) ? raw.genres.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 5) : [],
    price_bands: Array.isArray(raw.price_bands)
      ? raw.price_bands
          .filter((b) => b && (b.min_yen != null || b.max_yen != null))
          .map((b) => ({
            min_yen: Number.isFinite(Number(b.min_yen)) ? Number(b.min_yen) : null,
            max_yen: Number.isFinite(Number(b.max_yen)) ? Number(b.max_yen) : null,
          }))
          .slice(0, 3)
      : [],
    datetime: (() => {
      if (typeof raw.datetime !== 'string') return null;
      const t = raw.datetime.trim();
      if (!t) return null;
      // Allow only strict "YYYY-MM-DD HH:mm" (24h) or ISO "YYYY-MM-DDTHH:mm[...TZ]"
      const reHuman = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/;
      const reISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:\:\d{2})?(?:Z|[+\-]\d{2}:\d{2})?$/;
      if (reHuman.test(t) || reISO.test(t)) return t;
      return null; // drop anything else to avoid downstream parse errors
    })(),
    party_size: Number.isFinite(Number(raw.party_size)) ? Number(raw.party_size) : null,
    radius_m: (() => {
      const n = Number(raw.radius_m);
      if (Number.isFinite(n)) return Math.max(500, Math.min(3000, Math.trunc(n)));
      return 1200;
    })(),
    openAtStrict: !!raw.openAtStrict,
  };
  return out;
}

// ------------------------- Google API ---------------------
async function googleGet(path, params) {
  const key = assertEnv();
  const sp = new URLSearchParams({ key, ...params });
  const url = `https://maps.googleapis.com${path}?${sp.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

// ------------------------- Claude API ---------------------
async function claudeMessagesJson({ system, user, model = DEFAULT_CLAUDE_MODEL, max_tokens = 512, temperature = 0 }) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system,
      max_tokens,
      temperature,
      // Ask for strict JSON when available on the API; harmless if ignored
      // Anthropic structured output: enforce JSON response
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: user }
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${t}`);
  }
  const data = await res.json();
  const content = Array.isArray(data.content) && data.content[0]?.type === 'text' ? data.content[0].text : '';
  return JSON.parse(content);
}

// ------------------------- Gemini API ---------------------
async function geminiGenerateJson({ system, user, model = DEFAULT_GEMINI_MODEL, maxOutputTokens = 30000, temperature = 0.1, responseSchema = null }) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('GOOGLE_API_KEY (or GEMINI_API_KEY) is not set');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: system }] },
    contents: [
      { role: 'user', parts: [{ text: user }] }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      ...(responseSchema ? { responseSchema } : {}),
    },
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${t}`);
  }
  const data = await res.json();
  const block = data?.promptFeedback?.blockReason;
  if (block) {
    throw new Error(`Gemini prompt blocked: ${block}`);
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const finish = data?.candidates?.[0]?.finishReason || data?.candidates?.[0]?.finish_reason || 'UNKNOWN';
    const safety = data?.candidates?.[0]?.safetyRatings || data?.candidates?.[0]?.safety_ratings || null;
    const pf = data?.promptFeedback || null;
    const meta = { finishReason: finish, safetyRatings: safety, promptFeedback: pf };
    throw new Error(`Gemini returned no content: ${JSON.stringify(meta).slice(0,800)}`);
  }
  const text = parts.map(p => p?.text || '').join('').trim();
  if (!text) {
    throw new Error('Gemini returned empty text');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`Gemini JSON parse failed: ${e?.message || e}. First 300 chars: ${snippet}`);
  }
}

async function normalizeAreaWithClaude(rawArea, { language = DEFAULT_LANGUAGE, region = DEFAULT_COUNTRY_REGION, model = DEFAULT_CLAUDE_MODEL } = {}) {
  const system = 'You convert vague location descriptions in Japanese into a single, geocodable place string suitable for Google Geocoding. Output strictly valid JSON only (no extra text).';
  const user = [
    '入力のエリア表現を、Google Geocodingで解釈しやすい1つの地名や施設名に正規化してください。',
    '例: 「渋谷の飲み屋街あたり」→「渋谷駅」や「渋谷センター街」など。',
    '以下のJSONだけを返してください。',
    '{',
    '  "normalized_area": "...",',
    '  "confidence": 0.0,',
    '  "reason": "...",',
    '  "alternatives": ["...", "..."]',
    '}',
    '',
    `area: ${rawArea}`,
    `language: ${language}`,
    `region: ${region}`,
  ].join('\n');
  const json = await claudeMessagesJson({ system, user, model, max_tokens: 256, temperature: 0 });
  const normalized = ensureString(json.normalized_area, 'normalized_area');
  const confidence = typeof json.confidence === 'number' ? json.confidence : null;
  const reason = typeof json.reason === 'string' ? json.reason : null;
  const alternatives = Array.isArray(json.alternatives) ? json.alternatives.filter((s) => typeof s === 'string') : [];
  return { normalized, confidence, reason, alternatives };
}

async function normalizeAreaWithGemini(rawArea, { language = DEFAULT_LANGUAGE, region = DEFAULT_COUNTRY_REGION, model = DEFAULT_GEMINI_MODEL } = {}) {
  const system = 'You convert vague location descriptions in Japanese into a single, geocodable place string suitable for Google Geocoding. Return compact JSON only.';
  const user = [
    '入力のエリア表現を、Google Geocodingで解釈しやすい1つの地名や施設名に正規化してください。',
    '例: 「渋谷の飲み屋街あたり」→「渋谷駅」や「渋谷センター街」など。',
    '以下のJSONだけを返してください。',
    '{',
    '  "normalized_area": "...",',
    '  "confidence": 0.0,',
    '  "reason": "...",',
    '  "alternatives": ["...", "..."]',
    '}',
    '',
    `area: ${rawArea}`,
    `language: ${language}`,
    `region: ${region}`,
  ].join('\n');
  const json = await geminiGenerateJson({
    system,
    user,
    model,
    maxOutputTokens: 256,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        normalized_area: { type: 'STRING' },
        confidence: { type: 'NUMBER' },
        reason: { type: 'STRING' },
        alternatives: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    },
  });
  const normalized = ensureString(json.normalized_area, 'normalized_area');
  const confidence = typeof json.confidence === 'number' ? json.confidence : null;
  const reason = typeof json.reason === 'string' ? json.reason : null;
  const alternatives = Array.isArray(json.alternatives) ? json.alternatives.filter((s) => typeof s === 'string') : [];
  return { normalized, confidence, reason, alternatives };
}

async function optimizeResultsWithClaude({ query, candidates, model = DEFAULT_CLAUDE_MODEL, maxReturn }) {
  const system = 'You re-rank restaurant candidates for a Japanese user. Output strictly valid JSON only (no extra text).';
  const payload = {
    query,
    candidates: candidates.map((c) => ({
      place_id: c.place_id,
      name: c.name,
      rating: c.rating,
      user_ratings_total: c.user_ratings_total,
      price_level: c.price_level,
      is_open: c.is_open_at_scheduled_time,
      address: c.address,
      types: c.types,
    })),
    maxReturn,
  };
  const user = [
    '次の候補から最大 maxReturn 件を、ユーザー満足度が高くなる順に並べ替えてください。',
    '重視: 指定時刻に営業中、評価値、レビュー件数、予算適合、ジャンル適合。',
    '短い理由も付けてください。',
    'JSONのみで返してください。',
    '{',
    '  "recommendations": [',
    '    { "place_id": "...", "score": 0.0, "reason": "..." }',
    '  ]',
    '}',
    '',
    JSON.stringify(payload, null, 0),
  ].join('\n');
  const json = await claudeMessagesJson({ system, user, model, max_tokens: 1024, temperature: 0 });
  const recs = Array.isArray(json.recommendations) ? json.recommendations : [];
  const byId = new Map(recs.filter(r => r && r.place_id).map(r => [r.place_id, r]));
  const ordered = candidates
    .slice()
    .sort((a, b) => {
      const ra = byId.get(a.place_id)?.score ?? -Infinity;
      const rb = byId.get(b.place_id)?.score ?? -Infinity;
      if (ra !== rb) return rb - ra;
      return 0;
    })
    .filter(c => byId.has(c.place_id));
  const top = ordered.slice(0, maxReturn).map((c) => ({
    ...c,
    claude_reason: byId.get(c.place_id)?.reason ?? null,
    claude_score: byId.get(c.place_id)?.score ?? null,
  }));
  return { recommendations: top, raw: recs };
}

async function optimizeResultsWithGemini({ query, candidates, model = DEFAULT_GEMINI_MODEL, maxReturn }) {
  const system = 'You re-rank restaurant candidates for a Japanese user. Output compact JSON only.';
  const payload = {
    query,
    candidates: candidates.map((c) => ({
      place_id: c.place_id,
      name: c.name,
      rating: c.rating,
      user_ratings_total: c.user_ratings_total,
      price_level: c.price_level,
      is_open: c.is_open_at_scheduled_time,
      address: c.address,
      types: c.types,
    })),
    maxReturn,
  };
  const user = [
    '次の候補から最大 maxReturn 件を、ユーザー満足度が高くなる順に並べ替えてください。',
    '重視: 指定時刻に営業中、評価値、レビュー件数、予算適合、ジャンル適合。',
    '短い理由も付けてください。',
    'JSONのみで返してください。',
    '{',
    '  "recommendations": [',
    '    { "place_id": "...", "score": 0.0, "reason": "..." }',
    '  ]',
    '}',
    '',
    JSON.stringify(payload, null, 0),
  ].join('\n');
  const json = await geminiGenerateJson({
    system,
    user,
    model,
    maxOutputTokens: 1024,
    temperature: 0,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        recommendations: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              place_id: { type: 'STRING' },
              score: { type: 'NUMBER' },
              reason: { type: 'STRING' },
            },
          },
        },
      },
    },
  });
  const recs = Array.isArray(json.recommendations) ? json.recommendations : [];
  const byId = new Map(recs.filter(r => r && r.place_id).map(r => [r.place_id, r]));
  const ordered = candidates
    .slice()
    .sort((a, b) => {
      const ra = byId.get(a.place_id)?.score ?? -Infinity;
      const rb = byId.get(b.place_id)?.score ?? -Infinity;
      if (ra !== rb) return rb - ra;
      return 0;
    })
    .filter(c => byId.has(c.place_id));
  const top = ordered.slice(0, maxReturn).map((c) => ({
    ...c,
    llm_reason: byId.get(c.place_id)?.reason ?? null,
    llm_score: byId.get(c.place_id)?.score ?? null,
  }));
  return { recommendations: top, raw: recs };
}

// ------------------------- LLM wrappers -------------------
async function normalizeAreaWithLLM(rawArea, { language, region, claudeModel = DEFAULT_CLAUDE_MODEL, geminiModel = DEFAULT_GEMINI_MODEL } = {}) {
  const errors = [];
  if (getAnthropicKey()) {
    try {
      const r = await normalizeAreaWithClaude(rawArea, { language, region, model: claudeModel });
      return { ...r, _provider: 'claude', _model: claudeModel };
    } catch (e) {
      errors.push(`Claude: ${e?.message || e}`);
    }
  }
  if (getGeminiKey()) {
    try {
      const r = await normalizeAreaWithGemini(rawArea, { language, region, model: geminiModel });
      return { ...r, _provider: 'gemini', _model: geminiModel };
    } catch (e) {
      errors.push(`Gemini: ${e?.message || e}`);
    }
  }
  throw new Error(`Area normalization failed. ${errors.join(' | ') || 'No LLM API key configured.'}`);
}

async function optimizeResultsWithLLM({ query, candidates, claudeModel = DEFAULT_CLAUDE_MODEL, geminiModel = DEFAULT_GEMINI_MODEL, maxReturn }) {
  const errors = [];
  if (getAnthropicKey()) {
    try {
      const r = await optimizeResultsWithClaude({ query, candidates, model: claudeModel, maxReturn });
      return { ...r, _provider: 'claude', _model: claudeModel };
    } catch (e) {
      errors.push(`Claude: ${e?.message || e}`);
    }
  }
  if (getGeminiKey()) {
    try {
      const r = await optimizeResultsWithGemini({ query, candidates, model: geminiModel, maxReturn });
      return { ...r, _provider: 'gemini', _model: geminiModel };
    } catch (e) {
      errors.push(`Gemini: ${e?.message || e}`);
    }
  }
  throw new Error(`Results optimization failed. ${errors.join(' | ') || 'No LLM API key configured.'}`);
}

// ---------------- Summarize final top via LLM ----------------
async function summarizeTopWithClaude({ nl, items, model = DEFAULT_CLAUDE_MODEL, language = DEFAULT_LANGUAGE }) {
  const system = 'From up to 10 restaurant candidates, pick at most 5 best recommendations for a Japanese user. Output strictly valid JSON only (no code fences, no preface). For each picked item, write a single catchy Japanese sentence (about 30-60 chars) as the reason, reflecting the user intent (time, party size, genre, budget). No bullet lists, no slashes.';
  const payload = {
    nl,
    items: items.map((x) => ({
      name: x.name,
      image_url: x.image_url,
      google_maps_url: x.google_maps_url,
      genres: Array.isArray(x.matched_genres) ? x.matched_genres : [],
      areas: Array.isArray(x.source_areas) ? x.source_areas : [],
      reason_short: x.reason_short || null,
      rating: x.rating ?? null,
      user_ratings_total: x.user_ratings_total ?? null,
    })),
    language,
  };
  const user = [
    '以下の候補（最大10件）から、最大5件を選んで構造化JSONで返してください。',
    '各要素は以下の形式です。',
    '{',
    '  "name": "...",',
    '  "image_url": "..." | null,',
    '  "google_maps_url": "..." | null,',
    '  "genres": ["..."]',
    '  "area": "...",',
    '  "reason": "..."  // 自然でキャッチーな日本語一文（30〜60文字）',
    '}',
    '',
    'reasonはユーザー入力と店舗属性（営業時間・評価・レビュー数・価格帯・ジャンル・エリア）に基づき、口語的で魅力的に。',
    JSON.stringify(payload, null, 0),
  ].join('\n');
  
  const json = await claudeMessagesJson({ system, user, model, max_tokens: 1024, temperature: 0 });
  return json; // expect { recommendations: [ {name, image_url, google_maps_url, genres, area, reason} ] }
}

async function summarizeTopWithGemini({ nl, items, model = DEFAULT_GEMINI_MODEL, language = DEFAULT_LANGUAGE }) {
  const system = 'From up to 10 restaurant candidates, pick at most 5 best recommendations for a Japanese user. Output strictly JSON matching the response schema (no additional text). For each picked item, produce a single catchy Japanese sentence (about 30-60 chars) as reason, reflecting user intent (time, party size, genre, budget). No bullet lists.';
  const payload = {
    nl,
    items: items.map((x) => ({
      name: x.name,
      image_url: x.image_url,
      google_maps_url: x.google_maps_url,
      genres: Array.isArray(x.matched_genres) ? x.matched_genres : [],
      areas: Array.isArray(x.source_areas) ? x.source_areas : [],
      reason_short: x.reason_short || null,
      rating: x.rating ?? null,
      user_ratings_total: x.user_ratings_total ?? null,
    })),
    language,
  };
  const user = JSON.stringify(payload, null, 0);
  
  const responseSchema = {
    type: 'OBJECT',
    properties: {
      recommendations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            image_url: { type: 'STRING' },
            google_maps_url: { type: 'STRING' },
            genres: { type: 'ARRAY', items: { type: 'STRING' } },
            area: { type: 'STRING' },
            reason: { type: 'STRING' },
          },
        },
      },
    },
  };
  const json = await geminiGenerateJson({ system, user, model, maxOutputTokens: 30000, temperature: 0, responseSchema });
  
  return json;
}

async function summarizeTopWithLLM({ nl, items, claudeModel = DEFAULT_CLAUDE_MODEL, geminiModel = DEFAULT_GEMINI_MODEL, language = DEFAULT_LANGUAGE }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Top-5 summarization failed: no items to summarize');
  }
  const errors = [];
  if (getAnthropicKey()) {
    try {
      const r = await summarizeTopWithClaude({ nl, items, model: claudeModel, language });
      return { ...r, _provider: 'claude', _model: claudeModel };
    } catch (e) {
      errors.push(`Claude: ${e?.message || e}`);
    }
  }
  if (getGeminiKey()) {
    try {
      const r = await summarizeTopWithGemini({ nl, items, model: geminiModel, language });
      return { ...r, _provider: 'gemini', _model: geminiModel };
    } catch (e) {
      errors.push(`Gemini: ${e?.message || e}`);
    }
  }
  throw new Error(`Top-5 summarization failed. ${errors.join(' | ') || 'No LLM API key configured.'}`);
}

// ---------------- Natural-language query parsing via LLM ---------------
async function parseUserQueryWithClaude(nl, { model = DEFAULT_CLAUDE_MODEL } = {}) {
  const system = 'Extract structured search parameters from Japanese natural-language dining requests. Output strictly valid JSON only (no code fences, no commentary). Use null for unknown values. For datetime, return exactly "YYYY-MM-DD HH:mm" (24-hour, leading zeros) or an ISO-8601 string like "YYYY-MM-DDTHH:mm"; if uncertain, return null.';
  const user = [
    '次のユーザー入力から、飲食店検索のための構造化パラメータを抽出してください。',
    'ルール:',
    '- areas: 最大3件。駅名を優先して抽出（例: 恵比寿→恵比寿駅）。',
    '- genres: 最大5件。ユーザー意図が明確（例: 焼肉）なら1〜3件に絞る。不明瞭なら4〜5件を多様に（例: 焼肉/すき焼き/ステーキ/イタリアン/韓国）。',
    '- price_bands: 1〜3件、各 {min_yen, max_yen}（税込概算）。',
    '- datetime: ローカル時間で厳密に "YYYY-MM-DD HH:mm"（24時間制、ゼロ詰め）またはISO（"YYYY-MM-DDTHH:mm"）。不明確ならnull。"19時"/"頃"/"午後"/"半"などは使用禁止。',
    '- party_size: 人数があれば数値、無ければnull。',
    '- radius_m: 既定1200。必要なら1000〜2000程度で調整。',
    '- openAtStrict: 時間がある場合はtrue、無ければfalse。',
    '必ず以下のJSON形式のみで出力してください。',
    '以下のJSONのみを返してください。',
    '{',
    '  "areas": ["..."]',
    '  "genres": ["..."]',
    '  "price_bands": [ { "min_yen": 3000, "max_yen": 6000 } ],',
    '  "datetime": "YYYY-MM-DD HH:mm" | null,',
    '  "party_size": 5 | null,',
    '  "radius_m": 1200,',
    '  "openAtStrict": true | false',
    '}',
    '',
    `ユーザー入力: ${nl}`,
  ].join('\n');
  return claudeMessagesJson({ system, user, model, max_tokens: 512, temperature: 0 });
}

async function parseUserQueryWithGemini(nl, { model = DEFAULT_GEMINI_MODEL } = {}) {
  const system = [
    'Extract structured search parameters from Japanese natural-language dining requests.',
    'Output strictly JSON matching the response schema (no additional text). Use null for unknown values.',
    'Guidelines:',
    '- areas: up to 3, prefer station names (e.g., 恵比寿→恵比寿駅).',
    '- genres: up to 5. If intent is explicit (e.g., yakiniku), return 1–3 focused items; if ambiguous, return 4–5 diverse items.',
    '- price_bands: 1–3 objects {min_yen, max_yen}.',
    '- datetime: strictly "YYYY-MM-DD HH:mm" (24-hour, leading zeros) or ISO-8601 like "YYYY-MM-DDTHH:mm"; otherwise null. Do not use words like "頃", "午後", or half-hour kanji.',
    '- party_size: number or null.',
    '- radius_m: default 1200 (tune 1000–2000 if needed).',
    '- openAtStrict: true only if datetime provided, else false.',
  ].join('\n');
  const user = `ユーザー入力: ${nl}`;
  const responseSchema = {
    type: 'OBJECT',
    properties: {
      areas: { type: 'ARRAY', items: { type: 'STRING' } },
      genres: { type: 'ARRAY', items: { type: 'STRING' } },
      price_bands: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { min_yen: { type: 'NUMBER' }, max_yen: { type: 'NUMBER' } } },
      },
      datetime: { type: 'STRING' },
      party_size: { type: 'NUMBER' },
      radius_m: { type: 'NUMBER' },
      openAtStrict: { type: 'BOOLEAN' },
    },
  };
  const json = await geminiGenerateJson({ system, user, model, maxOutputTokens: 512, temperature: 0, responseSchema });
  return json;
}

async function parseUserQueryWithLLM(nl, { claudeModel = DEFAULT_CLAUDE_MODEL, geminiModel = DEFAULT_GEMINI_MODEL } = {}) {
  const errors = [];
  if (getAnthropicKey()) {
    try {
      const r = await parseUserQueryWithClaude(nl, { model: claudeModel });
      return { ...r, _provider: 'claude', _model: claudeModel };
    } catch (e) {
      errors.push(`Claude: ${e?.message || e}`);
    }
  }
  if (getGeminiKey()) {
    try {
      const r = await parseUserQueryWithGemini(nl, { model: geminiModel });
      return { ...r, _provider: 'gemini', _model: geminiModel };
    } catch (e) {
      errors.push(`Gemini: ${e?.message || e}`);
    }
  }
  throw new Error(`NL parsing failed. ${errors.join(' | ') || 'No LLM API key configured.'}`);
}

// --------------- NL-driven suggestion pipeline -----------------
export async function suggestPlacesFromNL(nl, { language = DEFAULT_LANGUAGE, preferStationCenter = true, date } = {}) {
  const planRaw = await parseUserQueryWithLLM(nl, {});
  const plan = sanitizeNLPlan(planRaw);
  const areas = plan.areas;
  const genres = plan.genres;
  const priceBands = plan.price_bands;
  if (!areas.length) throw new Error('NL parsing produced no areas');
  if (!genres.length) throw new Error('NL parsing produced no genres');
  const radius_m = toInt(plan.radius_m, 1200);
  const maxPerCombo = 5;

  let openAtStrict = !!plan.openAtStrict;
  let dateTime = plan.datetime && String(plan.datetime).trim() ? String(plan.datetime).trim() : null;
  let parsedDT = null;
  if (dateTime) {
    const { year, month, day, hour, minute } = parseLocalDateTime(dateTime);
    parsedDT = { year, month, day, hour, minute, dow: dayOfWeekFromDate(year, month, day), minutesOfDay: hour * 60 + minute };
  } else {
    openAtStrict = false;
  }

  // Resolve centers per area
  const centerMeta = [];
  for (const areaText of areas) {
    // Try to resolve center from text loosely (prefer direct Place hit), then fall back to geocoding
    let resolvedAny = await findPlaceAny(areaText, { language });
    let geocoded = null;
    if (!resolvedAny) {
      geocoded = await geocodeArea(areaText, { language });
    }
    if (preferStationCenter) {
      // If station center is preferred, attempt strict station resolution using geocoded center (if available), otherwise from findplace-any
      const base = geocoded || (resolvedAny ? { lat: resolvedAny.location.lat, lng: resolvedAny.location.lng, formatted: resolvedAny.address || resolvedAny.name } : null);
      if (!base) throw new Error(`Could not resolve center for area "${areaText}"`);
      const resolved = await resolveStationCenter({ areaText, geocode: base, language, radius: Math.max(300, toInt(radius_m, DEFAULT_RADIUS_M)) });
      if (!resolved?.location) throw new Error(`Station resolution returned no location for area "${areaText}"`);
      centerMeta.push({ input: areaText, geocoded: geocoded || { lat: base.lat, lng: base.lng }, station: resolved, center: { lat: resolved.location.lat, lng: resolved.location.lng } });
    } else {
      if (resolvedAny) {
        centerMeta.push({ input: areaText, geocoded: geocoded || { lat: resolvedAny.location.lat, lng: resolvedAny.location.lng }, station: null, center: { lat: resolvedAny.location.lat, lng: resolvedAny.location.lng } });
      } else if (geocoded) {
        centerMeta.push({ input: areaText, geocoded, station: null, center: { lat: geocoded.lat, lng: geocoded.lng } });
      } else {
        throw new Error(`Could not resolve any center for area "${areaText}"`);
      }
    }
  }

  // If no price bands, derive a neutral null to use default behavior
  const bands = priceBands.length ? priceBands : [ { min_yen: null, max_yen: null } ];

  const combinations = [];
  const allOutputs = [];
  for (const area of centerMeta) {
    for (const pb of bands) {
      const priceLevel = priceLevelFromBudgetYen(pb.min_yen, pb.max_yen);
      for (const g of genres) {
        const { type, keyword } = mapGenreToTypeAndKeyword(g);
        const part = await nearbySearch({
          lat: area.center.lat,
          lng: area.center.lng,
          radius: Math.max(300, toInt(radius_m, DEFAULT_RADIUS_M)),
          type,
          keyword,
          language,
          price_level: priceLevel,
          maxPages: 1,
        });

        // Pull details for up to 20, compute scores, filter strictly if requested
        const pool = part.slice(0, 20);
        const detailed = [];
        for (const r of pool) {
          const d = await placeDetails(r.place_id, { language });
          detailed.push(d);
        }
        const enriched = detailed.map((d) => {
          const open = parsedDT ? isOpenAtTime(d.opening_hours?.periods, parsedDT.dow, parsedDT.minutesOfDay) : null;
          const base = computeScore(d, { genres: [g], preferOpen: !openAtStrict || open === true });
          return { d, openAtTime: open, score: base };
        });
        let filtered = enriched;
        if (openAtStrict) filtered = enriched.filter(e => e.openAtTime === true);
        filtered.sort((a, b) => b.score - a.score);
        const picks = filtered.slice(0, maxPerCombo).map(({ d, openAtTime }) => {
          const extras = { matched_genres: [g], source_areas: [area.input], hit_count: 1 };
          return toOutput(d, openAtTime, parsedDT ? { dow: parsedDT.dow, minutesOfDay: parsedDT.minutesOfDay } : { dow: 0, minutesOfDay: 0 }, { includePhotoUrl: true, extras });
        });
        combinations.push({ area: area.input, genre: g, price_band: pb, results: picks });
        allOutputs.push(...picks);
      }
    }
  }

  // Build cross-combination summary (dedup by place_id)
  const seen = new Map();
  const aggregated = [];
  for (const it of allOutputs) {
    if (!seen.has(it.place_id)) {
      seen.set(it.place_id, it);
      aggregated.push(it);
    }
  }
  // Simple ranking: open first (if available), rating then reviews
  aggregated.sort((a, b) => {
    const oa = a.is_open_at_scheduled_time === true ? 1 : 0;
    const ob = b.is_open_at_scheduled_time === true ? 1 : 0;
    if (oa !== ob) return ob - oa;
    const ar = a.rating ?? 0; const br = b.rating ?? 0;
    if (br !== ar) return br - ar;
    const at = a.user_ratings_total ?? 0; const bt = b.user_ratings_total ?? 0;
    return bt - at;
  });

  const top10 = aggregated.slice(0, 10);
  if (top10.length === 0) {
    throw new Error('Top-5 summarization failed: no items to summarize');
  }
  const topSummary = await summarizeTopWithLLM({ nl, items: top10, language: language });

  return {
    nl: nl,
    nl_plan: {
      provider: planRaw._provider,
      model: planRaw._model,
      areas,
      genres,
      price_bands: bands,
      datetime: dateTime,
      party_size: plan.party_size ?? null,
      radius_m,
      openAtStrict,
    },
    station_center: centerMeta.map(a => ({ input: a.input, geocoded_center: { lat: a.geocoded.lat, lng: a.geocoded.lng }, station: a.station })),
    combinations,
    summary_top: aggregated.slice(0, 15),
    top5_structured: {
      provider: topSummary?._provider,
      model: topSummary?._model,
      recommendations: Array.isArray(topSummary?.recommendations) ? topSummary.recommendations : [],
    },
  };
}

async function geocodeArea(area, { language = DEFAULT_LANGUAGE, region = DEFAULT_COUNTRY_REGION } = {}) {
  const data = await googleGet('/maps/api/geocode/json', { address: area, language, region });
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Failed to geocode area: ${area} (${data.status})`);
  }
  const top = data.results[0];
  const loc = top.geometry?.location;
  if (!loc) throw new Error('No geometry for area');
  return { lat: loc.lat, lng: loc.lng, formatted: top.formatted_address };
}

// ------------------- Station resolution utilities -------------------
function isStationTypes(types) {
  if (!Array.isArray(types)) return false;
  const set = new Set(types);
  return (
    set.has('train_station') ||
    set.has('subway_station') ||
    set.has('transit_station') ||
    set.has('light_rail_station') ||
    set.has('bus_station')
  );
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const aa = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

async function findPlaceStation(text, biasLat, biasLng, { language = DEFAULT_LANGUAGE, radius = DEFAULT_STATION_SEARCH_RADIUS_M } = {}) {
  const fields = ['place_id', 'name', 'formatted_address', 'types', 'geometry'].join(',');
  const params = {
    input: text,
    inputtype: 'textquery',
    language,
    fields,
  };
  if (Number.isFinite(biasLat) && Number.isFinite(biasLng)) {
    params.locationbias = `circle:${radius}@${biasLat},${biasLng}`;
  }
  const data = await googleGet('/maps/api/place/findplacefromtext/json', params);
  if (data.status !== 'OK' || !Array.isArray(data.candidates)) return null;
  const withStationType = data.candidates.filter((c) => isStationTypes(c.types));
  const list = withStationType.length ? withStationType : data.candidates;
  const top = list[0];
  if (!top?.geometry?.location) return null;
  return {
    source: 'findplace',
    place_id: top.place_id,
    name: top.name,
    address: top.formatted_address,
    location: top.geometry.location,
    types: top.types || [],
  };
}

// Find Place without requiring station types; returns top candidate with geometry if available
async function findPlaceAny(text, { language = DEFAULT_LANGUAGE } = {}) {
  const fields = ['place_id', 'name', 'formatted_address', 'types', 'geometry'].join(',');
  const params = {
    input: text,
    inputtype: 'textquery',
    language,
    fields,
  };
  const data = await googleGet('/maps/api/place/findplacefromtext/json', params);
  if (data.status !== 'OK' || !Array.isArray(data.candidates) || data.candidates.length === 0) return null;
  const top = data.candidates[0];
  if (!top?.geometry?.location) return null;
  return {
    source: 'findplace_any',
    place_id: top.place_id,
    name: top.name,
    address: top.formatted_address,
    location: top.geometry.location,
    types: top.types || [],
  };
}

async function nearbyStations(lat, lng, { language = DEFAULT_LANGUAGE, radius = DEFAULT_STATION_SEARCH_RADIUS_M } = {}) {
  const types = ['train_station', 'subway_station', 'transit_station'];
  const results = [];
  for (const type of types) {
    const data = await googleGet('/maps/api/place/nearbysearch/json', {
      location: `${lat},${lng}`,
      radius: String(radius),
      type,
      language,
    });
    if (data.status === 'OK' && Array.isArray(data.results)) {
      for (const r of data.results) {
        if (r.geometry?.location) results.push({ ...r, type_source: type });
      }
    }
  }
  return results;
}

async function resolveStationCenter({ areaText, geocode, language = DEFAULT_LANGUAGE, radius = DEFAULT_STATION_SEARCH_RADIUS_M }) {
  // No fallbacks: must resolve a station via Find Place near geocoded center
  const fp = await findPlaceStation(areaText, geocode.lat, geocode.lng, { language, radius });
  if (fp && isStationTypes(fp.types)) {
    return { ...fp, distance_m: haversineMeters(geocode, fp.location) };
  }
  throw new Error(`Failed to resolve station center for area "${areaText}"`);
}

async function nearbySearch({ lat, lng, radius, type, keyword, language = DEFAULT_LANGUAGE, price_level = null, maxPages = 2 }) {
  const paramsBase = {
    location: `${lat},${lng}`,
    radius: String(radius),
    type,
    keyword,
    language,
    // rankby not used because radius present; prominence is fine
  };
  if (price_level != null) {
    // Nearby Search supports minprice/maxprice 0..4
    paramsBase.minprice = String(Math.max(0, Math.min(4, price_level - 1)));
    paramsBase.maxprice = String(Math.max(0, Math.min(4, price_level)));
  }
  let token = undefined;
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const params = token ? { pagetoken: token } : paramsBase;
    const data = await googleGet('/maps/api/place/nearbysearch/json', params);
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`NearbySearch failed: ${data.status}`);
    }
    if (Array.isArray(data.results)) all.push(...data.results);
    if (!data.next_page_token) break;
    token = data.next_page_token;
    await sleep(1500); // Required delay before using next_page_token
  }
  return all;
}

async function placeDetails(placeId, { language = DEFAULT_LANGUAGE } = {}) {
  const fields = [
    'place_id',
    'name',
    'formatted_address',
    'geometry/location',
    'rating',
    'user_ratings_total',
    'price_level',
    'opening_hours/periods',
    'opening_hours/weekday_text',
    'website',
    'url',
    'formatted_phone_number',
    'types',
    'business_status',
    'photos',
  ].join(',');
  const data = await googleGet('/maps/api/place/details/json', { place_id: placeId, fields, language });
  if (data.status !== 'OK' || !data.result) throw new Error(`PlaceDetails failed: ${data.status}`);
  return data.result;
}

// Optional: get timezone info for location and timestamp (seconds since epoch)
async function timezoneInfo(lat, lng, timestampSec) {
  const data = await googleGet('/maps/api/timezone/json', {
    location: `${lat},${lng}`,
    timestamp: String(timestampSec),
  });
  if (data.status !== 'OK') throw new Error(`Time Zone API failed: ${data.status}`);
  return data; // { timeZoneId, rawOffset, dstOffset }
}

// ------------------------- Core logic ---------------------
async function suggestPlaces(input) {
  const {
    dateTime,
    area,
    areas,
    genre,
    genres,
    language = DEFAULT_LANGUAGE,
    radius_m = DEFAULT_RADIUS_M,
    maxResults = DEFAULT_MAX_RESULTS,
    budget_yen_min = null,
    budget_yen_max = null,
    openAtStrict = true,
    useClaudeAreaNormalization = false,
    useClaudeResultOptimization = false,
    claudeModel = DEFAULT_CLAUDE_MODEL,
    preferStationCenter = true,
    station_search_radius_m = DEFAULT_STATION_SEARCH_RADIUS_M,
    mixPrice_3000_6000 = true,
    includePhotoUrl = true,
  } = input;

  ensureString(dateTime, 'dateTime');
  if (!area && !areas) throw new Error('Provide area or areas');
  ensureString(genre, 'genre');

  const { year, month, day, hour, minute } = parseLocalDateTime(dateTime);
  const dow = dayOfWeekFromDate(year, month, day); // 0..6
  const minutesOfDay = hour * 60 + minute;

  // Build areas list (supports multiple place names)
  const areaList = Array.isArray(areas) && areas.length
    ? areas
    : (typeof area === 'string' ? area.split(/[、,\/|]/).map(s => s.trim()).filter(Boolean) : []);

  const perAreaMeta = [];
  const searchCenters = [];
  for (const areaText of areaList) {
    let normalized = areaText;
    let normInfo = null;
    if (useClaudeAreaNormalization) {
      const norm = await normalizeAreaWithLLM(areaText, { language, region: DEFAULT_COUNTRY_REGION, claudeModel, geminiModel: DEFAULT_GEMINI_MODEL });
      normalized = norm.normalized;
      normInfo = { provider: norm._provider, model: norm._model, confidence: norm.confidence, reason: norm.reason, alternatives: norm.alternatives };
    }
    const geocoded = await geocodeArea(normalized, { language });
    let searchCenter = { lat: geocoded.lat, lng: geocoded.lng };
    let stationInfo = null;
    if (preferStationCenter) {
      const resolved = await resolveStationCenter({ areaText: normalized, geocode: geocoded, language, radius: Math.max(300, toInt(station_search_radius_m, DEFAULT_STATION_SEARCH_RADIUS_M)) });
      if (resolved?.location) {
        searchCenter = { lat: resolved.location.lat, lng: resolved.location.lng };
        stationInfo = resolved;
      } else {
        throw new Error(`Station resolution returned no location for area "${normalized}"`);
      }
    }
    perAreaMeta.push({ input: areaText, normalized, geocoded, stationInfo, info: normInfo });
    searchCenters.push({ center: searchCenter, areaText: normalized });
  }

  const desired = Math.max(3, Math.min(10, toInt(maxResults, DEFAULT_MAX_RESULTS)));
  const priceLevel = priceLevelFromBudgetYen(budget_yen_min, budget_yen_max);
  const genreList = parseGenres(genre, genres);
  const finalGenreList = genreList.length ? genreList : (genre ? [genre] : ['居酒屋']);

  // Aggregate nearby results across all centers and genres
  const candidatesRaw = [];
  for (const sc of searchCenters) {
    for (const gLabel of finalGenreList) {
      const { type, keyword } = mapGenreToTypeAndKeyword(gLabel);
      const part = await nearbySearch({
        lat: sc.center.lat,
        lng: sc.center.lng,
        radius: Math.max(300, toInt(radius_m, DEFAULT_RADIUS_M)),
        type,
        keyword,
        language,
        price_level: priceLevel,
        maxPages: 1,
      });
      for (const r of part) {
        r._source_area = sc.areaText;
        r._matched_genres = [gLabel];
      }
      candidatesRaw.push(...part);
    }
  }

  // Deduplicate by place_id and keep OPERATIONAL
  const uniqMap = new Map();
  for (const r of candidatesRaw) {
    if (!r.place_id) continue;
    if (r.business_status && r.business_status !== 'OPERATIONAL') continue;
    if (!uniqMap.has(r.place_id)) {
      const sources = new Set();
      if (r._source_area) sources.add(r._source_area);
      const gset = new Set();
      if (Array.isArray(r._matched_genres)) r._matched_genres.forEach((x) => gset.add(x));
      uniqMap.set(r.place_id, { ...r, _hit_count: 1, _sources: sources, _matched_genres_set: gset });
    } else {
      const cur = uniqMap.get(r.place_id);
      cur._hit_count = (cur._hit_count || 1) + 1;
      if (r._source_area) cur._sources?.add?.(r._source_area);
      if (Array.isArray(r._matched_genres)) r._matched_genres.forEach((x) => cur._matched_genres_set?.add?.(x));
    }
  }
  const uniqList = Array.from(uniqMap.values());

  // Pull details for a larger pool then filter/sort
  const poolSize = Math.min(uniqList.length, Math.max(desired * CANDIDATE_FETCH_MULTIPLIER, 20));
  const pool = uniqList.slice(0, poolSize);

  const detailed = [];
  for (const r of pool) {
    const d = await placeDetails(r.place_id, { language });
    detailed.push(d);
  }

  // Compute open-at-time flag
  const enriched = detailed.map((d) => {
    const open = isOpenAtTime(d.opening_hours?.periods, dow, minutesOfDay);
    const base = computeScore(d, { genres: finalGenreList, preferOpen: !openAtStrict || open === true });
    const hitBoost = Math.min(0.6, Math.max(0, (uniqMap.get(d.place_id)?._hit_count || 1) - 1) * 0.2);
    return { d, openAtTime: open, score: base + hitBoost };
  });

  // Filter by openAtStrict if requested
  let filtered = enriched;
  if (openAtStrict) {
    filtered = enriched.filter((e) => e.openAtTime === true);
  }

  // Sort: open first, then score desc, then ratings desc
  filtered.sort((a, b) => {
    const oa = a.openAtTime === true ? 1 : 0;
    const ob = b.openAtTime === true ? 1 : 0;
    if (oa !== ob) return ob - oa;
    if (b.score !== a.score) return b.score - a.score;
    const ar = a.d.rating ?? 0;
    const br = b.d.rating ?? 0;
    if (br !== ar) return br - ar;
    const at = a.d.user_ratings_total ?? 0;
    const bt = b.d.user_ratings_total ?? 0;
    return bt - at;
  });

  // Create outputs with extras, then optionally enforce a 3000-6000 JPY price mix
  const allOutputs = filtered.map(({ d, openAtTime }) => {
    const meta = uniqMap.get(d.place_id) || {};
    const extras = {
      matched_genres: Array.from(meta._matched_genres_set || []),
      source_areas: Array.from(meta._sources || []),
      hit_count: meta._hit_count || 1,
    };
    return toOutput(d, openAtTime, { dow, minutesOfDay }, { includePhotoUrl, extras });
  });
  let picks;
  if (mixPrice_3000_6000) {
    picks = selectWithGenreAndPriceMix(allOutputs, desired, { genresPriority: finalGenreList, minYen: 3000, maxYen: 6000 });
  } else {
    picks = allOutputs.slice(0, desired);
  }

  let llmUsed = null;
  let llmModel = null;
  if (useClaudeResultOptimization && picks.length > 0) {
    const opt = await optimizeResultsWithLLM({
      query: { dateTime, areas: perAreaMeta.map(a => a.geocoded.formatted), genres: (finalGenreList || []), language },
      candidates: picks,
      claudeModel,
      geminiModel: DEFAULT_GEMINI_MODEL,
      maxReturn: desired,
    });
    if (opt?.recommendations?.length) {
      picks = opt.recommendations;
      llmUsed = opt._provider;
      llmModel = opt._model;
    } else {
      throw new Error('LLM optimization returned no recommendations');
    }
  }

  return {
    query: { dateTime, parsed: { year, month, day, hour, minute, dow }, area: perAreaMeta[0]?.geocoded.formatted, areas: perAreaMeta.map(a => a.geocoded.formatted), genres: finalGenreList, language, radius_m },
    area_normalization: useClaudeAreaNormalization ? perAreaMeta.map(a => ({ input: a.input, used_area: a.normalized, info: a.info })) : undefined,
    // Present only when LLM optimization successfully ran
    claude_optimization: llmUsed ? { used: true, provider: llmUsed, model: llmModel, size_in: picks.length } : undefined,
    station_center: preferStationCenter ? perAreaMeta.map(a => ({
      input: a.input,
      normalized: a.normalized,
      geocoded_center: { lat: a.geocoded.lat, lng: a.geocoded.lng },
      station: a.stationInfo,
      radius_m: station_search_radius_m,
    })) : undefined,
    results: picks,
  };
}

function computeScore(d, { genre, keyword, genres, preferOpen }) {
  let s = 0;
  const name = (d.name || '').toLowerCase();
  const types = Array.isArray(d.types) ? d.types.join(' ') : '';
  const rating = d.rating ?? 0;
  const count = d.user_ratings_total ?? 0;
  if (keyword && name.includes(String(keyword).toLowerCase())) s += 1.0;
  if (genre && name.includes(String(genre).toLowerCase())) s += 0.6;
  if (Array.isArray(genres) && genres.length) {
    const gl = genres.map((g) => String(g).toLowerCase());
    let matches = 0;
    for (const g of gl) {
      if (name.includes(g)) matches++;
    }
    if (matches > 0) s += Math.min(1.2, 0.7 + (matches - 1) * 0.2);
  }
  if (types.includes('restaurant')) s += 0.2;
  if (types.includes('bar')) s += 0.1;
  s += Math.min(1.5, rating / 3.5); // 0..~1.7
  s += Math.min(1.0, Math.log10(Math.max(1, count)) / 3); // 0..~1
  if (preferOpen) s += 0.5;
  return s;
}

function photoUrlFromRef(photoRef, { maxwidth = 800 } = {}) {
  if (!photoRef) return null;
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const usp = new URLSearchParams({ maxwidth: String(maxwidth), photo_reference: photoRef, key });
  return `https://maps.googleapis.com/maps/api/place/photo?${usp.toString()}`;
}

function formatPriceBand(price_level) {
  const band = priceLevelIndicativeYen(price_level);
  if (!band) return null;
  if (band.min === 0 && band.max === 1000) return '〜¥1,000';
  if (band.max >= 999999) return '¥12,000〜';
  return `¥${band.min.toLocaleString()}〜¥${band.max.toLocaleString()}`;
}

function buildReasonShort({ name, rating, user_ratings_total, is_open_at_scheduled_time, price_level, matched_genres = [], source_areas = [], hit_count }) {
  const bits = [];
  if (is_open_at_scheduled_time === true) bits.push('指定時刻に営業中');
  if (rating != null && user_ratings_total != null) bits.push(`評価${rating.toFixed(1)}(${user_ratings_total}件)`);
  const pb = formatPriceBand(price_level);
  if (pb) bits.push(`価格帯${pb}`);
  if (Array.isArray(matched_genres) && matched_genres.length) bits.push(`ジャンル: ${matched_genres.slice(0,2).join('/')}`);
  if ((hit_count || 0) > 1) bits.push('複数エリアでヒット');
  return bits.slice(0, 3).join('・');
}

function buildReasonCatchy(item) {
  try {
    const time = item?.schedule_context?.time_local || null;
    const open = item?.is_open_at_scheduled_time === true;
    const rating = item?.rating;
    const count = item?.user_ratings_total;
    const genre = Array.isArray(item?.matched_genres) && item.matched_genres.length ? item.matched_genres[0] : null;
    const pb = formatPriceBand(item?.price_level);
    const parts = [];
    if (open && time) parts.push(`${time}も営業中`);
    if (rating != null && count != null) parts.push(`評価${rating.toFixed(1)}・${count}件`);
    if (pb) parts.push(`予算${pb}目安`);
    if (genre) parts.push(`${genre}好きに`);
    const s = parts.join('、');
    return s ? `${s}にちょうど良さそう。` : '立地・評価・予算のバランスが良く、使いやすい一軒です。';
  } catch {
    return '雰囲気と利便性のバランスが良い一軒です。';
  }
}

function toOutput(d, openAtTime, { dow, minutesOfDay }, { includePhotoUrl = true, extras = {} } = {}) {
  const weekdayText = Array.isArray(d.opening_hours?.weekday_text) ? d.opening_hours.weekday_text : undefined;
  const minutesStr = `${String(Math.floor(minutesOfDay / 60)).padStart(2, '0')}:${String(minutesOfDay % 60).padStart(2, '0')}`;
  let imageUrl = null;
  let imageAttributions = undefined;
  if (includePhotoUrl && Array.isArray(d.photos) && d.photos.length) {
    imageUrl = photoUrlFromRef(d.photos[0].photo_reference, { maxwidth: 800 });
    imageAttributions = d.photos[0].html_attributions;
  }
  const matched_genres = Array.isArray(extras.matched_genres) ? extras.matched_genres : [];
  const source_areas = Array.isArray(extras.source_areas) ? extras.source_areas : [];
  const hit_count = extras.hit_count ?? null;
  const base = {
    place_id: d.place_id,
    name: d.name,
    address: d.formatted_address,
    location: d.geometry?.location,
    rating: d.rating ?? null,
    user_ratings_total: d.user_ratings_total ?? null,
    price_level: d.price_level ?? null,
    is_open_at_scheduled_time: openAtTime,
    schedule_context: {
      weekday_index: dow, // 0=Sun..6=Sat
      time_local: minutesStr,
      weekday_text: weekdayText,
    },
    website: d.website ?? null,
    google_maps_url: d.url ?? null,
    phone: d.formatted_phone_number ?? null,
    types: d.types ?? [],
    matched_genres,
    source_areas,
    image_url: imageUrl,
    image_attributions: imageAttributions,
  };
  const reason = buildReasonShort({ ...base, hit_count });
  return { ...base, reason_short: reason };
}

// Favor items whose price_level implies 3000-6000 JPY, with graceful fallback
function selectWithPriceMix(items, desired, { minYen, maxYen }) {
  const inRange = [];
  const nearRange = [];
  const unknown = [];
  for (const it of items) {
    const pl = it.price_level;
    if (pl == null) unknown.push(it);
    else if (inYenRange(pl, minYen, maxYen)) inRange.push(it);
    else nearRange.push(it);
  }
  const result = [];
  const targetInRange = Math.min(inRange.length, Math.max(Math.ceil(desired * 0.6), 1));
  result.push(...inRange.slice(0, targetInRange));
  if (result.length < desired) result.push(...nearRange.slice(0, desired - result.length));
  if (result.length < desired) result.push(...unknown.slice(0, desired - result.length));
  return result.slice(0, desired);
}

// Ensure genre diversity while favoring a target price range
function selectWithGenreAndPriceMix(items, desired, { genresPriority = [], minYen, maxYen }) {
  const prio = genresPriority.map(String);
  // Determine primary genre for each item
  const groups = new Map();
  const otherKey = '__other__';
  for (const it of items) {
    const mg = Array.isArray(it.matched_genres) ? it.matched_genres : [];
    let primary = mg.find((g) => prio.includes(String(g))) || mg[0] || otherKey;
    if (!groups.has(primary)) groups.set(primary, []);
    groups.get(primary).push(it);
  }
  // Helper to pop next best from a group, preferring in-range price first
  function popFromGroup(list) {
    if (!list.length) return null;
    let idx = list.findIndex((x) => inYenRange(x.price_level, minYen, maxYen));
    if (idx === -1) idx = 0;
    return list.splice(idx, 1)[0];
  }
  // Round-robin across genres priority
  const order = prio.filter((g) => groups.has(g));
  if (groups.has(otherKey)) order.push(otherKey);
  const result = [];
  while (result.length < desired && order.length) {
    let progressed = false;
    for (const g of order) {
      if (result.length >= desired) break;
      const pick = popFromGroup(groups.get(g) || []);
      if (pick) {
        result.push(pick);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  // Fill remaining from all leftovers maintaining original order
  if (result.length < desired) {
    const leftovers = [];
    for (const [g, arr] of groups) {
      leftovers.push(...arr);
    }
    // Prefer in-range then others
    const inR = leftovers.filter((x) => inYenRange(x.price_level, minYen, maxYen));
    const outR = leftovers.filter((x) => !inYenRange(x.price_level, minYen, maxYen));
    result.push(...inR.slice(0, desired - result.length));
    if (result.length < desired) result.push(...outR.slice(0, desired - result.length));
  }
  return result.slice(0, desired);
}

