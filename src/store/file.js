// file message store — JSONL, because a conversation IS an append-only log.
// One line per message, appended on write; the whole file is replayed into
// memory at boot. No rewrite-the-world on every post (unlike the filespace
// node store, which is a document set, a log wants a log).

import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeMemoryMessages } from './memory.js';

export function makeFileMessages(path) {
  const store = makeMemoryMessages({
    onAppend: (msg) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(msg) + '\n');
    },
  });

  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        store._seed(JSON.parse(line));
      } catch {
        console.warn(`[streams] skipping corrupt message line in ${path}`);
      }
    }
  }

  store.kind = 'file';
  store.path = path;
  return store;
}
