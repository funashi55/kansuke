import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import * as line from '@line/bot-sdk';
import { initDB } from './lib/db.js';
import { handleEventFactory } from './lib/line.js';
import { verifyLiffIdToken } from './lib/auth.js';
import { subscribe, publish } from './lib/sse.js';

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('Missing LINE credentials. Set LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET.');
}

const app = express();

// Health check
app.get('/health', (_req, res) => res.send('ok'));

// Initialize DB
const db = initDB();

// LINE client and webhook
const client = new line.Client({ channelAccessToken: config.channelAccessToken });
const runtime = { botUserId: process.env.BOT_USER_ID || '' };
const promptedClosePolls = new Set();
// Try to fetch bot's userId automatically (so BOT_USER_ID env is optional)
(async () => {
  try {
    const info = await client.getBotInfo();
    if (info?.userId) {
      runtime.botUserId = info.userId;
      console.log(`[BOOT] Resolved botUserId: ${runtime.botUserId}`);
    }
  } catch (e) {
    console.warn('[BOOT] getBotInfo failed; fallback to BOT_USER_ID env. Reason:', e?.response?.data || e.message);
  }
})();
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const handleEvent = handleEventFactory({ client, db, botUserId: runtime.botUserId });
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

// JSON body for our APIs
app.use('/api', express.json());

// Serve LIFF HTML with server-side LIFF_ID injection for robustness on mobile
app.get('/liff/index.html', (_req, res) => {
  try {
    const filePath = path.join(process.cwd(), 'public', 'liff', 'index.html');
    let html = fs.readFileSync(filePath, 'utf8');
    const inj = `<script>window.__LIFF_ID__=${JSON.stringify(process.env.LIFF_ID || '')};</script>`;
    html = html.replace(/<\/head>/i, `${inj}</head>`);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    console.error('Failed to serve LIFF index:', e.message);
    res.status(500).send('LIFF page not available');
  }
});

// Generic handler to inject LIFF_ID into any /liff/*.html (e.g., debug.html)
app.get(/^\/liff\/.+\.html$/, (req, res, next) => {
  try {
    const root = path.join(process.cwd(), 'public', 'liff');
    // Normalize and ensure path is under public/liff
    const rel = req.path.replace(/^\/liff\//, '');
    const filePath = path.join(root, rel);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(root))) return res.status(403).send('Forbidden');
    if (!fs.existsSync(resolved)) return next();
    let html = fs.readFileSync(resolved, 'utf8');
    const inj = `<script>window.__LIFF_ID__=${JSON.stringify(process.env.LIFF_ID || '')};</script>`;
    html = html.replace(/<\/head>/i, `${inj}</head>`);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    console.error('Failed to serve LIFF html:', e.message);
    next();
  }
});

// Static files (LIFF assets and others)
app.use('/liff', express.static('public/liff'));

// Public config for frontend (non-sensitive)
app.get('/api/public-config', (_req, res) => {
  res.json({
    liffId: process.env.LIFF_ID || '',
    loginChannelId: process.env.LINE_LOGIN_CHANNEL_ID || '',
  });
});

// LIFF APIs
app.get('/api/polls/:pollId', async (req, res) => {
  try {
    const pollId = req.params.pollId;
    const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    let login = null;
    try {
      login = await verifyLiffIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'unauthorized', detail: e.message });
    }
    const uid = login.sub;
    const profileName = login.name || null;
    const data = db.getPoll(pollId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const tally3 = db.getPollTally3(pollId);
    const userChoices = db.getUserChoices3({ pollId, userId: uid });
    res.json({ poll: data.poll, options: data.options, tally: tally3, userChoices, user: { id: uid, name: profileName } });
  } catch (e) {
    console.error('GET /api/polls error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/polls/:pollId/votes3', async (req, res) => {
  try {
    const pollId = req.params.pollId;
    const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    let login = null;
    try {
      login = await verifyLiffIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'unauthorized', detail: e.message });
    }
    const uid = login.sub;
    const name = login.name || null;
    const { poll } = db.getPoll(pollId) || {};
    if (!poll) return res.status(404).json({ error: 'not_found' });
    if (poll.status !== 'open') return res.status(403).json({ error: 'poll_closed' });
    if (poll.deadline && Date.now() > Number(poll.deadline)) return res.status(403).json({ error: 'deadline_passed' });
    const choices = Array.isArray(req.body?.choices) ? req.body.choices : [];
    db.upsertVotes3({ pollId, userId: uid, userName: name, choices });
    const tally3 = db.getPollTally3(pollId);
    publish(pollId, { type: 'tally', tally: tally3 });
    // Check completion and possibly prompt to close
    checkAndPromptClose({ pollId }).catch((e) => console.warn('checkAndPromptClose error', e.message));
    res.json({ ok: true, tally: tally3 });
  } catch (e) {
    console.error('POST /api/polls votes3 error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/polls/:pollId/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const pollId = req.params.pollId;
  subscribe(pollId, res);
  // Send initial ping
  res.write('data: {"type":"ping"}\n\n');
});

// Admin: set deadline (requires ADMIN_SECRET in header Authorization: Bearer ...)
app.post('/api/polls/:pollId/deadline', express.json(), (req, res) => {
  try {
    const auth = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
    if (!ADMIN_SECRET || auth !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
    const pollId = req.params.pollId;
    const { deadline } = req.body || {}; // accept number(ms) or ISO string
    let ts = null;
    if (deadline != null) {
      ts = typeof deadline === 'number' ? deadline : Date.parse(deadline);
      if (Number.isNaN(ts)) return res.status(400).json({ error: 'invalid_deadline' });
    }
    const data = db.getPoll(pollId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    db.setPollDeadline(pollId, ts);
    res.json({ ok: true, deadline: ts });
  } catch (e) {
    console.error('deadline set error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Helpers
async function getAllMemberIds(groupOrRoomId) {
  // Try group first, then room. SDK v9 returns string[] directly (pagination handled internally).
  try {
    const ids = await client.getGroupMemberIds(groupOrRoomId);
    if (Array.isArray(ids) && ids.length) return ids;
  } catch (_) {}
  try {
    const ids = await client.getRoomMemberIds(groupOrRoomId);
    if (Array.isArray(ids) && ids.length) return ids;
  } catch (_) {}
  return [];
}

async function getHumanMemberCount(groupOrRoomId) {
  // Prefer official count API which includes users who haven't friended the bot and excludes the bot automatically.
  try {
    const res = await client.getGroupMembersCount(groupOrRoomId);
    if (res && typeof res.count === 'number') {
      return res.count;
    }
  } catch (_) {}
  try {
    const res = await client.getRoomMembersCount(groupOrRoomId);
    if (res && typeof res.count === 'number') {
      return res.count;
    }
  } catch (_) {}
  return null;
}

async function checkAndPromptClose({ pollId }) {
  const data = db.getPoll(pollId);
  if (!data) return;
  const { poll, options } = data;
  if (!poll || poll.status !== 'open') return;
  if (promptedClosePolls.has(pollId)) return; // avoid spamming
  if (!poll.group_id) return;
  const nOpts = options.length;
  if (nOpts === 0) return;
  // まずはメンバーの総数（Bot除外済みの人数）が取得できるか試す
  const memberCount = await getHumanMemberCount(poll.group_id);
  const counts = db.getAnswerCountsByUser(pollId); // [{ user_id, cnt }]
  const byUser = new Map(counts.map((r) => [r.user_id, Number(r.cnt) || 0]));
  const completedUsers = counts.filter((r) => Number(r.cnt) >= nOpts).map((r) => r.user_id);
  let allAnswered = false;
  let humanIds = null;
  if (typeof memberCount === 'number' && memberCount > 0) {
    // 公式の人数と「全候補を埋めたユーザー数」を比較
    allAnswered = completedUsers.length >= memberCount;
  } else {
    // 旧来のIDベース（取得できる場合）
    const memberIds = await getAllMemberIds(poll.group_id);
    if (!memberIds || memberIds.length === 0) {
      // no-op
    }
    humanIds = memberIds.filter((id) => id && id !== runtime.botUserId);
    allAnswered = humanIds.length > 0 && humanIds.every((uid) => (byUser.get(uid) || 0) >= nOpts);
    // さらにダメなら最終フォールバック（投票に参加した人全員が完了 && 2人以上）
    if (!allAnswered) {
      const voters = counts.map((r) => r.user_id).filter(Boolean);
      const uniqueVoters = Array.from(new Set(voters));
      const votersAllDone = uniqueVoters.length > 0 && uniqueVoters.every((uid) => (byUser.get(uid) || 0) >= nOpts);
      if (votersAllDone && uniqueVoters.length >= 2) {
        allAnswered = true;
      }
    }
  }
  if (!allAnswered) return;

  // Build confirm template
  const messages = [
    {
      type: 'template',
      altText: '全員の回答が揃いました。締め切りますか？',
      template: {
        type: 'confirm',
        text: '全員の回答が揃いました。締め切りますか？',
        actions: [
          { type: 'postback', label: 'はい', data: `close:${pollId}:yes` },
          { type: 'postback', label: 'いいえ', data: `close:${pollId}:no` },
        ],
      },
    },
  ];
  try {
    await client.pushMessage(poll.group_id, messages);
    promptedClosePolls.add(pollId);
  } catch (e) {
    console.warn('push confirm failed', e?.response?.data || e.message);
  }
}
