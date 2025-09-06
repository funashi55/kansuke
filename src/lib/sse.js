const channels = new Map(); // pollId -> Set(res)

export function subscribe(pollId, res) {
  if (!channels.has(pollId)) channels.set(pollId, new Set());
  const set = channels.get(pollId);
  set.add(res);
  res.on('close', () => {
    set.delete(res);
  });
}

export function publish(pollId, event) {
  const set = channels.get(pollId);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      // ignore broken pipe
    }
  }
}

