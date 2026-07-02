// memory message store — the reference implementation of the message-log
// contract. Messages are NOT filespace entities: different churn, different
// shape, different store. Append-only per room (slug), server-assigned seq.
//
// The contract:
//   append(slug, {author, label, body, at}) -> message  (seq assigned here)
//   tail(slug, {after, limit})              -> message[] (ascending; the LAST
//                                              `limit` messages with seq > after)
//   rooms()                                 -> slug[]    (rooms with messages)

import { normalizeSlug } from '@orbitalfoundation/filespace/src/paths.js';

export function makeMemoryMessages({ onAppend = null } = {}) {
  const byRoom = new Map(); // slug -> [{seq, slug, author, label, body, at}]

  return {
    kind: 'memory',

    async append(slug, { author = null, label = null, body = '', at = Date.now() } = {}) {
      const s = normalizeSlug(slug);
      const log = byRoom.get(s) ?? [];
      const msg = { seq: (log.at(-1)?.seq ?? 0) + 1, slug: s, author, label, body, at };
      log.push(msg);
      byRoom.set(s, log);
      if (onAppend) onAppend(msg);
      return { ...msg };
    },

    async tail(slug, { after = 0, limit = 50 } = {}) {
      const log = byRoom.get(normalizeSlug(slug)) ?? [];
      const newer = log.filter((m) => m.seq > after);
      return newer.slice(Math.max(0, newer.length - limit)).map((m) => ({ ...m }));
    },

    async rooms() {
      return [...byRoom.keys()];
    },

    // load one message without firing onAppend — used by persistent adapters at boot
    _seed(msg) {
      const s = normalizeSlug(msg.slug);
      const log = byRoom.get(s) ?? [];
      log.push({ ...msg });
      byRoom.set(s, log);
    },
  };
}
