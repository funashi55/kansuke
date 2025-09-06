import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DB_PATH = process.env.DB_PATH || './data/app.sqlite';

export function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS options (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL,
      label TEXT NOT NULL,
      date TEXT,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS votes (
      poll_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      voted_at INTEGER NOT NULL,
      PRIMARY KEY (poll_id, user_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES options(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      label TEXT,
      date TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    -- Ternary votes for LIFF (0:×, 1:△, 2:○)
    CREATE TABLE IF NOT EXISTS votes3 (
      poll_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      choice INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (poll_id, option_id, user_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES options(id) ON DELETE CASCADE
    );
  `);

  // Add deadline column to polls if missing
  try {
    const cols = db.prepare("PRAGMA table_info('polls')").all();
    if (!cols.some((c) => c.name === 'deadline')) {
      db.exec("ALTER TABLE polls ADD COLUMN deadline INTEGER");
    }
    if (!cols.some((c) => c.name === 'follow_up_state')) {
      db.exec("ALTER TABLE polls ADD COLUMN follow_up_state TEXT");
    }
    if (!cols.some((c) => c.name === 'finalized_date')) {
      db.exec("ALTER TABLE polls ADD COLUMN finalized_date TEXT");
    }
  } catch {}

  return {
    db,
    getLatestPollForGroup(groupId) {
      return db
        .prepare('SELECT * FROM polls WHERE group_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(groupId);
    },
    setPollFinalizedDate(pollId, date) {
      db.prepare('UPDATE polls SET finalized_date = ? WHERE id = ?').run(date, pollId);
    },
    setPollFollowUpState(pollId, state) {
      db.prepare('UPDATE polls SET follow_up_state = ? WHERE id = ?').run(state, pollId);
    },
    // Event/session state
    createSession({ groupId, title }) {
      const id = crypto.randomUUID();
      const now = Date.now();
      db.prepare(
        'INSERT INTO sessions (id, group_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, groupId, title || null, 'open', now, now);
      return id;
    },
    setSessionStatus({ sessionId, status, title }) {
      const now = Date.now();
      db.prepare('UPDATE sessions SET status = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?')
        .run(status, title || null, now, sessionId);
    },
    updateSessionCandidates({ sessionId, candidates }) {
      const del = db.prepare('DELETE FROM session_candidates WHERE session_id = ?');
      const ins = db.prepare('INSERT INTO session_candidates (id, session_id, label, date) VALUES (?, ?, ?, ?)');
      const tx = db.transaction(() => {
        del.run(sessionId);
        for (const c of candidates) {
          ins.run(crypto.randomUUID(), sessionId, c.label || null, c.date);
        }
        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
      });
      tx();
    },
    getSession(sessionId) {
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      if (!s) return null;
      const cands = db.prepare('SELECT * FROM session_candidates WHERE session_id = ? ORDER BY rowid ASC').all(sessionId);
      return { session: s, candidates: cands };
    },
    createPoll({ groupId, title, options }) {
      const pollId = crypto.randomUUID();
      const now = Date.now();
      const insertPoll = db.prepare(
        'INSERT INTO polls (id, group_id, title, created_at, status) VALUES (?, ?, ?, ?, ?)' 
      );
      const insertOpt = db.prepare(
        'INSERT INTO options (id, poll_id, label, date) VALUES (?, ?, ?, ?)'
      );
      const tx = db.transaction(() => {
        insertPoll.run(pollId, groupId, title, now, 'open');
        for (const opt of options) {
          const id = crypto.randomUUID();
          insertOpt.run(id, pollId, opt.label, opt.date || null);
        }
      });
      tx();
      return pollId;
    },
    getPoll(pollId) {
      const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
      if (!poll) return null;
      const options = db
        .prepare('SELECT * FROM options WHERE poll_id = ? ORDER BY rowid ASC')
        .all(pollId);
      return { poll, options };
    },
    setPollStatus(pollId, status) {
      db.prepare('UPDATE polls SET status = ? WHERE id = ?').run(status, pollId);
    },
    setPollDeadline(pollId, deadlineTs) {
      db.prepare('UPDATE polls SET deadline = ? WHERE id = ?').run(deadlineTs || null, pollId);
    },
    getPollTally(pollId) {
      const rows = db
        .prepare(
          `SELECT o.id as option_id, o.label as label, COUNT(v.user_id) as votes
           FROM options o
           LEFT JOIN votes v ON v.option_id = o.id
           WHERE o.poll_id = ?
           GROUP BY o.id
           ORDER BY rowid ASC`
        )
        .all(pollId);
      return rows;
    },
    getPollTally3(pollId) {
      const rows = db
        .prepare(
          `SELECT o.id as option_id, o.label as label,
                  SUM(CASE WHEN v.choice = 2 THEN 1 ELSE 0 END) as yes_count,
                  SUM(CASE WHEN v.choice = 1 THEN 1 ELSE 0 END) as maybe_count,
                  SUM(CASE WHEN v.choice = 0 THEN 1 ELSE 0 END) as no_count
           FROM options o
           LEFT JOIN votes3 v ON v.option_id = o.id AND v.poll_id = o.poll_id
           WHERE o.poll_id = ?
           GROUP BY o.id
           ORDER BY o.rowid ASC`
        )
        .all(pollId);
      return rows;
    },
    getUserChoices3({ pollId, userId }) {
      return db
        .prepare('SELECT option_id, choice FROM votes3 WHERE poll_id = ? AND user_id = ?')
        .all(pollId, userId);
    },
    getUserChoice3({ pollId, userId, optionId }) {
      return db
        .prepare('SELECT option_id, choice FROM votes3 WHERE poll_id = ? AND user_id = ? AND option_id = ?')
        .get(pollId, userId, optionId) || null;
    },
    getAnswerCountsByUser(pollId) {
      return db
        .prepare('SELECT user_id, COUNT(*) as cnt FROM votes3 WHERE poll_id = ? GROUP BY user_id')
        .all(pollId);
    },
    upsertVotes3({ pollId, userId, userName, choices }) {
      const now = Date.now();
      const stmt = db.prepare(
        `INSERT INTO votes3 (poll_id, option_id, user_id, user_name, choice, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(poll_id, option_id, user_id) DO UPDATE SET choice = excluded.choice, user_name = excluded.user_name, updated_at = excluded.updated_at`
      );
      const tx = db.transaction(() => {
        const seen = new Set();
        for (const ch of choices) {
          if (!('optionId' in ch) || typeof ch.optionId !== 'string') continue;
          const choice = Number(ch.choice);
          if (![0, 1, 2].includes(choice)) continue;
          if (seen.has(ch.optionId)) continue;
          seen.add(ch.optionId);
          stmt.run(pollId, ch.optionId, userId, userName || null, choice, now);
        }
      });
      tx();
    },
    voteSingle({ pollId, optionId, userId, userName }) {
      const now = Date.now();
      const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
      if (!poll) throw new Error('Poll not found');
      if (poll.status !== 'open') throw new Error('Poll closed');
      const del = db.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ?');
      const ins = db.prepare(
        'INSERT INTO votes (poll_id, option_id, user_id, user_name, voted_at) VALUES (?, ?, ?, ?, ?)'
      );
      const tx = db.transaction(() => {
        del.run(pollId, userId);
        ins.run(pollId, optionId, userId, userName || null, now);
      });
      tx();
    },
  };
}
