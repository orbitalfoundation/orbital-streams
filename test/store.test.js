import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMemoryMessages } from '../src/store/memory.js';
import { makeFileMessages } from '../src/store/file.js';

function contract(name, makeStore) {
  test(`${name}: append assigns per-room seq; tail slices ascending`, async () => {
    const s = makeStore();
    await s.append('/a', { author: 'x', body: 'one' });
    await s.append('/b', { author: 'y', body: 'other room' });
    const m = await s.append('/a', { author: 'x', body: 'two' });
    assert.equal(m.seq, 2); // per-room, not global

    assert.deepEqual((await s.tail('/a')).map((x) => x.body), ['one', 'two']);
    assert.deepEqual((await s.tail('/a', { after: 1 })).map((x) => x.seq), [2]);
    assert.deepEqual((await s.tail('/a', { limit: 1 })).map((x) => x.body), ['two']);
    assert.deepEqual(await s.tail('/silent'), []);
    assert.deepEqual((await s.rooms()).sort(), ['/a', '/b']);
  });
}

contract('memory', () => makeMemoryMessages());

let n = 0;
contract('file', () => makeFileMessages(join(mkdtempSync(join(tmpdir(), `streams-${n++}-`)), 'messages.jsonl')));

test('file: the log replays across reopen and keeps counting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'streams-reopen-'));
  const path = join(dir, 'messages.jsonl');
  try {
    const a = makeFileMessages(path);
    await a.append('/room', { author: 'x', body: 'before restart' });

    const b = makeFileMessages(path);
    assert.deepEqual((await b.tail('/room')).map((m) => m.body), ['before restart']);
    const next = await b.append('/room', { author: 'x', body: 'after restart' });
    assert.equal(next.seq, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
