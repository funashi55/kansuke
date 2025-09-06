import axios from 'axios';
import dayjs from 'dayjs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

export async function extractCandidateDates(query) {
  // If no API key, return fallback
  if (!ANTHROPIC_API_KEY) {
    return fallbackWeekendCandidates(query);
  }

  const system = `You are a Japanese scheduling assistant. Given a free-form Japanese request like \"8月の土日\", output a concise JSON array of candidate dates.
Rules:
- Timezone: Asia/Tokyo
- Today: ${dayjs().format('YYYY-MM-DD')}
- Prefer upcoming/future dates. If month specified, use the nearest upcoming year.
- Output strictly JSON with this shape: [{"date":"YYYY-MM-DD","label":"M/D(曜)"}, ...]
- Use Japanese weekday like (月)(火)(水)(木)(金)(土)(日)
- Limit to at most 10 items, sorted ascending by date.`;

  const user = `リクエスト: ${query}\n候補日リストを出力して。`;

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
    // Try to parse as JSON directly; if the model added code fencing, strip it
    const cleaned = content
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) throw new Error('Claude did not return an array');
    return arr
      .filter((x) => x?.date)
      .slice(0, 10)
      .map((x) => ({
        date: x.date,
        label: x.label || dayjs(x.date).format('M/D'),
      }));
  } catch (e) {
    console.warn('Claude parse failed, using fallback. Error:', e.message);
    return fallbackWeekendCandidates(query);
  }
}

// Tool-calling helper
// Runs a single-turn conversation with optional tool use.
// If the assistant triggers tool_use:update_event_candidates, returns { tool: { name, input, id }, messages: [...], text }
export async function runWithTools({ sessionId, userText, now = dayjs(), titleHint }) {
  if (!ANTHROPIC_API_KEY) {
    // Fallback: no tool calling without API key
    const candidates = fallbackWeekendCandidates(userText);
    return { text: '候補日をいくつか提案しました。', tool: { name: 'update_event_candidates', input: { session_id: sessionId, title: titleHint || '日程候補', candidates }, id: 'local-fallback' }, messages: [] };
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
1) まず自然な返信文を考えます（丁寧・簡潔）。
2) ユーザーが希望する候補日が明確に特定できた場合のみ、ツール update_event_candidates を呼び出して候補を確定します。
3) 候補が確定できない場合は追加の確認質問を行い、ツールは呼び出しません。
ルール:
- タイムゾーン: Asia/Tokyo, 今日: ${now.format('YYYY-MM-DD')}
- 候補日は未来寄りに解釈
- 不要なコードブロックやJSONは返さず、日本語テキスト中心。
`;

  const messages = [
    { role: 'user', content: userText },
  ];

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
}
