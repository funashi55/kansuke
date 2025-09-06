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
    .replace(/[\s]*(ごろ|頃)[　]*$/i, '');

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

// ---------------- Summarize final top via LLM ----------------
async function summarizeTopWithClaude({ system, user, model = DEFAULT_CLAUDE_MODEL, max_tokens = 512, temperature = 0 }) {
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

async function summarizeTopWithGemini({ system, user, model = DEFAULT_GEMINI_MODEL, maxOutputTokens = 30000, temperature = 0.1, responseSchema = null }) {
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

async function summarizeTopWithLLM({ nl, items, model = DEFAULT_CLAUDE_MODEL, language = DEFAULT_LANGUAGE }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Top-5 summarization failed: no items to summarize');
  }
  const errors = [];
  if (getAnthropicKey()) {
    try {
      const r = await summarizeTopWithClaude({ nl, items, model, language });
      return { ...r, _provider: 'claude', _model: model };
    } catch (e) {
      errors.push(`Claude: ${e?.message || e}`);
    }
  }
  if (getGeminiKey()) {
    try {
      const r = await summarizeTopWithGemini({ nl, items, model, language });
      return { ...r, _provider: 'gemini', _model: model };
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
    '  "areas": ["..."],',
    '  "genres": ["..."],',
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
  let dateTime = (plan.datetime && String(plan.datetime).trim() ? String(plan.datetime).trim() : null) || date;
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
    return {
      nl: nl,
      nl_plan: {},
      top5_structured: { recommendations: [] }
    };
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

async function findPlaceAny(text, { language = DEFAULT_LANGUAGE } = {}) {
  const fields = 'place_id,name,formatted_address,types,geometry'.split(',');
  const params = {
    input: text,
    inputtype: 'textquery',
    language,
    fields: fields.join(','),
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

async function resolveStationCenter({ areaText, geocode, language = DEFAULT_LANGUAGE, radius = DEFAULT_STATION_SEARCH_RADIUS_M }) {
  // No fallbacks: must resolve a station via Find Place near geocoded center
  const fp = await findPlaceStation(areaText, geocode.lat, geocode.lng, { language, radius });
  if (fp && isStationTypes(fp.types)) {
    return { ...fp, distance_m: haversineMeters(geocode, fp.location) };
  }
  throw new Error(`Failed to resolve station center for area "${areaText}"`);
}

async function findPlaceStation(text, biasLat, biasLng, { language = DEFAULT_LANGUAGE, radius = DEFAULT_STATION_SEARCH_RADIUS_M } = {}) {
  const fields = 'place_id,name,formatted_address,types,geometry'.split(',');
  const params = {
    input: text,
    inputtype: 'textquery',
    language,
    fields: fields.join(','),
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

async function nearbySearch({ lat, lng, radius, type, keyword, language = DEFAULT_LANGUAGE, price_level = null, maxPages = 2 }) {
  const paramsBase = {
    location: `${lat},${lng}`,
    radius: String(radius),
    type,
    keyword,
    language,
  };
  if (price_level != null) {
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

function computeScore(d, { genres, preferOpen }) {
  let s = 0;
  const name = (d.name || '').toLowerCase();
  const types = Array.isArray(d.types) ? d.types.join(' ') : '';
  const rating = d.rating ?? 0;
  const count = d.user_ratings_total ?? 0;

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
  return { ...base };
}
