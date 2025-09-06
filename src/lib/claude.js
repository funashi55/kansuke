import axios from 'axios';
import dayjs from 'dayjs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

function fallbackWeekendCandidates(query, limit = 6) {
  // Simple heuristic: next N Saturdays and Sundays
  const now = dayjs();
  let d = now.startOf('day');
  const out = [];
  while (out.length < limit) {
    d = d.add(1, 'day');
    const dow = d.day(); // 0=Sun,6=Sat
    if (dow === 0 || dow === 6) {
      out.push({
        date: d.format('YYYY-MM-DD'),
        label: d.format('M/D(dd)').replace('(Su)', '(日)').replace('(Sa)', '(土)'),
      });
    }
  }
  return out;
}

export async function extractCandidateDatesWithMeta(query) {
  // Try Anthropic first (if available), then Gemini as fallback before giving up
  if (ANTHROPIC_API_KEY) {
  const system = `You are a Japanese scheduling assistant. Extract a concise JSON array of candidate dates only when dates are explicitly specified. If ambiguous, return an empty array [].
Rules:
- Timezone: Asia/Tokyo
- Today: ${dayjs().format('YYYY-MM-DD')}
- Prefer upcoming/future dates but do not guess; avoid speculative inference.
- Output strictly JSON array: [{"date":"YYYY-MM-DD","label":"M/D(曜)"}, ...]
- Use Japanese weekday like (月)(火)(水)(木)(金)(土)(日)
- Max 10 items, sorted ascending by date.
- If dates are not explicit or clear, output [] (no extra text).`;
    const user = `リクエスト: ${query}\n明確に指定された候補日が無ければ空配列[]を返してください。`;
    try {
      const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-7-sonnet-20250219',
          max_tokens: 400,
          temperature: 0,
          system,
          messages: [{ role: 'user', content: user }],
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const content = (resp.data?.content?.[0]?.text || '').trim();
      const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr)) throw new Error('Claude did not return an array');
      const candidates = arr
        .filter((x) => x?.date)
        .slice(0, 10)
        .map((x) => ({ date: x.date, label: x.label || dayjs(x.date).format('M/D') }));
      return { candidates, source: 'anthropic' };
    } catch (_) {
      // fall through to Gemini
    }
  }

  // Try Gemini as secondary source
  const gem = await geminiExtractCandidates(query);
  if (gem && gem.length) {
    return { candidates: gem, source: 'gemini' };
  }
  // Give up (let caller decide to show error rather than creating a poll)
  return { candidates: [], source: 'fallback_error' };
}

// Backward-compatible simple version
export async function extractCandidateDates(query) {
  const { candidates } = await extractCandidateDatesWithMeta(query);
  return candidates;
}

// Tool-calling helper
// Runs a single-turn conversation with optional tool use.
// If the assistant triggers tool_use:update_event_candidates, returns { tool: { name, input, id }, messages: [...], text }
export async function runWithTools({ sessionId, userText, now = dayjs(), titleHint }) {
  // Helper to build a tool response from extracted candidates
  const makeTool = (cands) => ({
    name: 'update_event_candidates',
    input: { session_id: sessionId, title: titleHint || '日程候補', candidates: cands },
    id: 'gemini-fallback',
  });

  if (!ANTHROPIC_API_KEY) {
    // Try Gemini first when Anthropic is unavailable
    const gem = await geminiExtractCandidates(userText);
    if (gem && gem.length) {
      return { text: '候補日をいくつか提案しました。', tool: makeTool(gem), messages: [], fallbackReason: null };
    }
    // If Gemini couldn't extract dates, still try to produce a clarifying reply via Gemini
    const gemMsg = await geminiAskPrompt(userText);
    if (gemMsg) {
      return { text: gemMsg, tool: null, messages: [], fallbackReason: null };
    }
    // No Gemini either -> error
    return { text: 'エラーです。時間を空けてご利用ください。', tool: null, messages: [], fallbackReason: 'no_api_key' };
  }

  const tools = [
    {
      name: 'update_event_candidates',
      description: '候補日が確定したら、現在のセッションに候補日リストを保存して投票作成の準備をする。候補日は YYYY-MM-DD 形式の date と、表示用の label。',
      input_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '対象セッションのID' },
          title: { type: 'string', description: '投票タイトル（無ければ会話から推定）' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'YYYY-MM-DD' },
                label: { type: 'string', description: 'M/D(曜) など人間向け表示' },
              },
              required: ['date'],
            },
            minItems: 1,
          },
        },
        required: ['session_id', 'candidates'],
      },
    },
  ];

  const system = `あなたは日本語のスケジューリングアシスタントです。ユーザーの意図を理解し、
1) まず丁寧・簡潔な返信文を考えます。
2) ユーザーが\"明確に\"日付を指定している場合に限り、ツール update_event_candidates を呼び出します。
   - 明確の基準: YYYY-MM-DD, M/D, M/D-M/D, 10月5日, 10/1-10/11 の土日 など、解釈が一意に定まる表現。
   - 曖昧な表現（\"来月\"、\"そのうち\"、文脈不足など）の場合は絶対にツールを呼び出さないこと。
   - 曜日や\"今週末/来週末\"など相対的な表現は、今日が ${now.format('YYYY-MM-DD')} である前提で一意に定まる場合のみ許可。
3) ツールを呼び出さない場合は、日付の提示を促す確認メッセージを短く返します（具体例: 10/5, 10/12 や 10/1-10/11 の土日 など）。
ルール:
- タイムゾーン: Asia/Tokyo, 今日: ${now.format('YYYY-MM-DD')}
- 候補日は未来寄りに解釈。ただし不確かな推測はしない（想像で決めない）。
- 不要なコードブロックやJSONは返さず、日本語テキスト中心。
`;

  const messages = [
    { role: 'user', content: userText },
  ];

  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 600,
        temperature: 0,
        system,
        tools,
        messages,
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const content = resp.data?.content || [];
    const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
    const toolUse = content.find((c) => c.type === 'tool_use' && c.name === 'update_event_candidates');
    return {
      messages: [
        ...messages,
        { role: 'assistant', content },
      ],
      text: textParts.join('\n').trim(),
      tool: toolUse || null,
    };
  } catch (e) {
    console.warn('Anthropic API error; trying Gemini. Reason:', e?.response?.data || e.message);
    const gem = await geminiExtractCandidates(userText);
    if (gem && gem.length) {
      return { text: '候補日をいくつか提案しました。', tool: makeTool(gem), messages, fallbackReason: null };
    }
    // Try to produce a clarifying message via Gemini
    const gemMsg = await geminiAskPrompt(userText);
    if (gemMsg) {
      return { text: gemMsg, tool: null, messages, fallbackReason: null };
    }
    // Do not create a poll; let caller show an error message
    return { text: 'エラーです。時間を空けてご利用ください。', tool: null, messages, fallbackReason: 'api_error' };
  }
}

async function geminiExtractCandidates(query) {
  try {
    if (!GEMINI_API_KEY) {
      console.warn('Gemini fallback not configured (GEMINI_API_KEY missing)');
      return null;
    }
    const prompt = `あなたは日本語のスケジューリングアシスタントです。入力文から\"明確に指定された\"候補日だけを抽出し、JSON配列のみを返してください。曖昧な場合は空配列[]を返してください。
ルール:
- タイムゾーン: Asia/Tokyo
- 今日: ${dayjs().format('YYYY-MM-DD')}
- 未来寄りに解釈。ただし不確かな推測はしない（想像で補完しない）。
- 形式: [{"date":"YYYY-MM-DD","label":"M/D(曜)"}, ...]
- 最大10件、日付昇順。
- 出力は配列のみ。説明や余計なテキストは含めない。明確でない場合は [] を返す。

リクエスト: ${query}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const resp = await axios.post(
      url,
      { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      { timeout: 15000, headers: { 'content-type': 'application/json' } }
    );
    const parts = resp.data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text).filter(Boolean).join('\n').trim();
    if (!text) return null;
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return null;
    const mapped = arr
      .filter((x) => x?.date)
      .slice(0, 10)
      .map((x) => ({ date: x.date, label: x.label || dayjs(x.date).format('M/D') }));
    console.log('[GEMINI] extracted candidates:', mapped.length);
    return mapped;
  } catch (_) {
    console.warn('Gemini fallback error; no candidates');
    return null;
  }
}

async function geminiAskPrompt(userText) {
  try {
    if (!GEMINI_API_KEY) return null;
    const sys = `あなたは日本語のスケジューリングアシスタントです。`;
    const instr = `以下の発話に対して、必要な日付情報を丁寧かつ簡潔に確認してください。\n` +
      `- 1〜2文程度で、具体的な入力例（10/5, 10/12 や 10/1-10/11 の土日 など）を含める\n` +
      `- 余計な装飾やコードブロックは不要\n`;
    const prompt = `${sys}\n${instr}\n発話: ${userText}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const resp = await axios.post(
      url,
      { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      { timeout: 12000, headers: { 'content-type': 'application/json' } }
    );
    const parts = resp.data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text).filter(Boolean).join('\n').trim();
    return text || null;
  } catch (_) {
    return null;
  }
}

export async function continueAfterToolResult({ messages, toolUseId, resultText }) {
  if (!ANTHROPIC_API_KEY) {
    return { text: '候補日を反映し、アンケートを作成しました。' };
  }
  const nextMessages = [
    ...messages,
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: resultText || 'ok' },
      ],
    },
  ];
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 400,
        temperature: 0,
        messages: nextMessages,
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 15000,
      }
    );
    const content = resp.data?.content || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return { text };
  } catch (e) {
    console.warn('Anthropic API (continue) error; using default reply. Reason:', e?.response?.data || e.message);
    return { text: '候補日を反映しました。' };
  }
}
