import dayjs from 'dayjs';
import { extractCandidateDates, runWithTools, continueAfterToolResult } from './claude.js';
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
    const { text: assistantText, tool, messages } = await runWithTools({ sessionId, userText: query || text, titleHint: null });

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

        // Let Claude know tool succeeded and get final short message
        const cont = await continueAfterToolResult({ messages, toolUseId: tool.id, resultText: 'ok' });
        const finalText = cont.text || assistantText || '候補日でアンケートを作成しました。';
        outgoing = [{ type: 'text', text: finalText }];
      }
    }

    if (!pollFlex) {
      // Fallback to classic extraction if the tool was not used
      const extracted = await extractCandidateDates(query || text);
      if (extracted?.length) {
        const title = query || text || '日程候補';
        const pollId = db.createPoll({ groupId, title, options: extracted });
        console.log(`[MENTION] fallback extractor -> created poll ${pollId} with ${extracted.length} candidates`);
        const { options } = db.getPoll(pollId);
        pollFlex = buildPollFlex({
          pollId,
          title: shorten(title, 60),
          options: options.map((o) => ({ id: o.id, label: o.label })),
        });
      }
      const msg = assistantText || '候補日を提案しました。ご確認ください。';
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
      // Record as ○ in ternary votes, and keep legacy single-vote for compatibility
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
