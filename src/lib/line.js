import dayjs from 'dayjs';
import { runWithTools, continueAfterToolResult } from './claude.js';
import { buildPollFlex } from './flex.js';
import { publish } from './sse.js';

function extractQueryFromText(message) {
  const text = message.text || '';
  // Remove mention ranges if present
  const mention = message.mention;
  if (mention?.mentionees?.length) {
    // Replace mention segments with empty string based on index/length
    let out = '';
    let cursor = 0;
    const sorted = [...mention.mentionees].sort((a, b) => a.index - b.index);
    for (const m of sorted) {
      out += text.slice(cursor, m.index);
      cursor = m.index + m.length;
    }
    out += text.slice(cursor);
    return out.trim();
  }
  return text.trim();
}

function isBotMentioned(message, botUserId) {
  if (!botUserId) return false;
  const mentionees = message.mention?.mentionees || [];
  return mentionees.some((m) => m.userId === botUserId);
}

function looksLikeScheduleRequest(text) {
  return /日程|スケジュール|候補|poll|土日|曜日/.test(text);
}

export function handleEventFactory({ client, db, botUserId }) {
  return async function handleEvent(event) {
    try {
      if (event.type === 'message' && event.message?.type === 'text') {
        return handleTextMessage({ client, db, event, botUserId });
      }
      if (event.type === 'postback') {
        return handlePostback({ client, db, event });
      }
    } catch (e) {
      console.error('handleEvent error:', e);
    }
  };
}

async function handleTextMessage({ client, db, event, botUserId }) {
  const message = event.message;
  const groupId = event.source.groupId || event.source.roomId || event.source.userId;
  const envBotUserId = process.env.BOT_USER_ID || '';
  const resolvedBotUserId = botUserId || envBotUserId;
  const mentioned = isBotMentioned(message, resolvedBotUserId);
  const text = message.text || '';
  const query = extractQueryFromText(message);

  if (!mentioned) {
    return; // Only react to messages that mention the bot
  }
  const replyToken = event.replyToken;

  if (mentioned) {
    // Log mention event details
    const senderName = await getDisplayNameSafe(client, event.source);
    try {
      const mentionees = message.mention?.mentionees || [];
      console.log(
        `[MENTION] ${new Date().toISOString()} group=${groupId} user=${event.source.userId || 'unknown'}(${senderName || ''}) text="${text}" query="${query}" mentionees=${JSON.stringify(mentionees)} BOT_USER_ID=${resolvedBotUserId}`
      );
    } catch (_) {
      // ignore logging errors
    }
    // Advanced flow: send to Claude, allow tool-calling to update candidates, then create poll
    const sessionId = db.createSession({ groupId, title: null });
    const { text: assistantText, tool, messages, fallbackReason } = await runWithTools({ sessionId, userText: query || text, titleHint: null });

    // If LLMs are unavailable/errored, always return error (no poll)
    if (fallbackReason) {
      const errMsg = 'エラーです。時間を空けてご利用ください。';
      await safeSend(client, replyToken, groupId, [{ type: 'text', text: errMsg }]);
      return;
    }

    let outgoing = [];
    let pollFlex = null;

    if (tool && tool.name === 'update_event_candidates') {
      const input = tool.input || {};
      const rawCandidates = Array.isArray(input.candidates) ? input.candidates : [];
      // Normalize candidates
      const candidates = rawCandidates
        .filter((c) => c && c.date)
        .map((c) => ({ date: c.date, label: c.label || c.date }));

      if (candidates.length > 0) {
        // Update session state
        db.updateSessionCandidates({ sessionId, candidates });
        db.setSessionStatus({ sessionId, status: 'candidates_ready', title: input.title || null });

        // Create poll immediately
        const title = input.title || (query || text || '日程候補');
        const pollId = db.createPoll({ groupId, title, options: candidates });
        console.log(`[MENTION] tool_use:update_event_candidates -> created poll ${pollId} with ${candidates.length} candidates`);
        const { options } = db.getPoll(pollId);
        pollFlex = buildPollFlex({
          pollId,
          title: shorten(title, 60),
          options: options.map((o) => ({ id: o.id, label: o.label })),
        });

        // Let Claude know tool succeeded and get final short message (skip if fallback)
        let finalText = assistantText || '候補日でアンケートを作成しました。';
        if (!fallbackReason && tool.id !== 'local-fallback' && tool.id !== 'error-fallback') {
          const cont = await continueAfterToolResult({ messages, toolUseId: tool.id, resultText: 'ok' });
          finalText = cont.text || finalText;
        }
        outgoing = [{ type: 'text', text: finalText }];
      }
    }

    if (!pollFlex) {
      // No tool use -> return the LLM-crafted guidance; do not create poll
      const msg = assistantText && assistantText.trim() ? assistantText : '候補の日付が分かるように、具体的な日付または期間を教えてください。';
      outgoing = [{ type: 'text', text: msg }];
    }

    const messagesToSend = pollFlex ? [...outgoing, pollFlex] : outgoing;
    await safeSend(client, replyToken, groupId, messagesToSend);
    return;
  }
}

async function handlePostback({ client, db, event }) {
  const data = event.postback?.data || '';
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const userName = await getDisplayNameSafe(client, event.source);

  if (data.startsWith('vote:')) {
    const [, pollId, optionId] = data.split(':');
    try {
      // If already marked as ○ for this option, don't upsert again
      const current = db.getUserChoice3({ pollId, userId, optionId });
      if (current && Number(current.choice) === 2) {
        await safeReply(client, replyToken, [{ type: 'text', text: 'この候補への○は既に記録されています。' }]);
        return;
      }
      // Record as ○ in ternary votes
      db.upsertVotes3({ pollId, userId, userName, choices: [{ optionId, choice: 2 }] });
      const tally = db.getPollTally3(pollId);
      const summary = formatTally3(tally);
      publish(pollId, { type: 'tally', tally });
      await safeReply(client, replyToken, [
        { type: 'text', text: `投票を記録しました (${userName || 'ユーザー'})` },
        { type: 'text', text: `現在の集計\n${summary}` },
      ]);
    } catch (e) {
      await safeReply(client, replyToken, [{ type: 'text', text: `投票に失敗: ${e.message}` }]);
    }
    return;
  }

  if (data.startsWith('summary:')) {
    const [, pollId] = data.split(':');
    const tally = db.getPollTally3(pollId);
    const summary = formatTally3(tally);
    await safeReply(client, replyToken, [{ type: 'text', text: `現在の集計\n${summary}` }]);
    return;
  }

  if (data.startsWith('close:')) {
    const [, pollId, yn] = data.split(':');
    const d = db.getPoll(pollId);
    if (!d) {
      await safeReply(client, replyToken, [{ type: 'text', text: '対象の投票が見つかりませんでした。' }]);
      return;
    }
    const { poll, options } = d;
    // After someone answered 'yes', mark as 'closing' so further yes/no are ignored
    if (poll.status === 'closing' || poll.status === 'closed') {
      await safeReply(client, replyToken, [{ type: 'text', text: poll.status === 'closed' ? 'すでに確定済みです。' : 'すでに締切処理中です。' }]);
      return;
    }

    if (yn === 'yes') {
      // switch to closing and offer choices
      db.setPollStatus(pollId, 'closing');
      // Present candidate options as a Flex with buttons to finalize
      const tally = db.getPollTally3(pollId);
      // Sort by yes desc, maybe desc, no asc
      const byId = new Map(tally.map((t) => [t.option_id, t]));
      const sorted = [...options].sort((a, b) => {
        const ta = byId.get(a.id) || { yes_count: 0, maybe_count: 0, no_count: 0 };
        const tb = byId.get(b.id) || { yes_count: 0, maybe_count: 0, no_count: 0 };
        if (tb.yes_count !== ta.yes_count) return tb.yes_count - ta.yes_count;
        if (tb.maybe_count !== ta.maybe_count) return tb.maybe_count - ta.maybe_count;
        return ta.no_count - tb.no_count;
      });
      const bubbles = sorted.slice(0, 10).map((opt) => {
        const t = byId.get(opt.id) || { yes_count: 0, maybe_count: 0, no_count: 0 };
        return {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: poll.title || '候補日', weight: 'bold', size: 'sm', color: '#888888' },
              { type: 'text', text: opt.label, weight: 'bold', size: 'md', wrap: true },
              { type: 'text', text: `○${t.yes_count} / △${t.maybe_count} / ×${t.no_count}`, size: 'sm', color: '#666666' },
            ],
          },
          footer: {
            type: 'box', layout: 'vertical', contents: [
              { type: 'button', style: 'primary', height: 'sm', color: '#00c300', action: { type: 'postback', label: 'この日にする', data: `finalize:${pollId}:${opt.id}` } }
            ]
          }
        };
      });
      const flex = { type: 'flex', altText: '候補日の選択', contents: { type: 'carousel', contents: bubbles.length ? bubbles : [{ type: 'bubble', body: { type: 'box', layout:'vertical', contents: [{ type: 'text', text: '候補がありません' }] } }] } };
      await safeReply(client, replyToken, [
        { type: 'text', text: '締め切りの承認ありがとうございます。最終候補を選んでください。' },
        flex,
      ]);
    } else {
      // no は現状スルー（再通知はしない）。
      await safeReply(client, replyToken, [{ type: 'text', text: '了解しました。引き続き投票を受け付けます。' }]);
    }
    return;
  }

  if (data.startsWith('finalize:')) {
    const [, pollId, optionId] = data.split(':');
    try {
      const d = db.getPoll(pollId);
      if (!d) throw new Error('poll_not_found');
      const { poll, options } = d;
      if (poll.status === 'closed') {
        await safeReply(client, replyToken, [{ type: 'text', text: 'すでに確定済みです。' }]);
        return;
      }
      const opt = options.find((o) => o.id === optionId);
      if (!opt) throw new Error('option_not_found');
      db.setPollStatus(pollId, 'closed');
      const text = `「${poll.title}」は ${opt.label} に確定しました。`; 
      // Notify group
      if (poll.group_id) {
        await safePush(client, poll.group_id, [{ type: 'text', text }]);
      }
      // Ack to the user
      await safeReply(client, replyToken, [{ type: 'text', text: '確定しました。グループに通知しました。' }]);
    } catch (e) {
      await safeReply(client, replyToken, [{ type: 'text', text: `確定に失敗: ${e.message}` }]);
    }
    return;
  }
}

async function safeReply(client, replyToken, messages) {
  try {
    if (!replyToken) return;
    await client.replyMessage(replyToken, messages);
  } catch (e) {
    console.error('reply failed:', e?.response?.data || e.message);
  }
}

async function safePush(client, to, messages) {
  try {
    await client.pushMessage(to, messages);
  } catch (e) {
    console.error('push failed:', e?.response?.data || e.message);
  }
}

// Try reply first; if token invalid/expired, push to group instead
async function safeSend(client, replyToken, groupId, messages) {
  try {
    await client.replyMessage(replyToken, messages);
  } catch (e) {
    const data = e?.response?.data;
    const msg = data?.message || e.message || '';
    if (String(msg).toLowerCase().includes('invalid reply token') || String(msg).includes('expired')) {
      const to = groupId || null;
      if (to) return safePush(client, to, messages);
    }
    console.error('send failed:', data || e.message);
  }
}

async function getDisplayNameSafe(client, source) {
  try {
    if (source.groupId && source.userId) {
      const prof = await client.getGroupMemberProfile(source.groupId, source.userId);
      return prof.displayName;
    }
    if (source.roomId && source.userId) {
      const prof = await client.getRoomMemberProfile(source.roomId, source.userId);
      return prof.displayName;
    }
    if (source.userId) {
      const prof = await client.getProfile(source.userId);
      return prof.displayName;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function formatTally(rows) {
  return rows.map((r) => `${r.label}: ${r.votes}票`).join('\n');
}

function formatTally3(rows) {
  return rows
    .map((r) => `${r.label}: ○${r.yes_count} / △${r.maybe_count} / ×${r.no_count}`)
    .join('\n');
}

function shorten(s, max) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
