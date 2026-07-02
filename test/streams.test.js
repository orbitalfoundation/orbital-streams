// streams over a real bus with a real filespace: the message log is gated by
// filespace policy (the reserved `post` verb finally earns its seat), privacy
// hides history, and posts announce for room-scoped fan-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { attach as attachFilespace, makeMemoryStore, newIdentity, signAction } from '@orbitalfoundation/filespace';
import { attach as attachStreams } from '../src/streams.js';
import { makeMemoryMessages } from '../src/store/memory.js';

function setup({ authenticate = true } = {}) {
  const bus = createBus({ description: 'streams-test' });
  const fs = attachFilespace(bus, { store: makeMemoryStore(), enforce: true, authenticate });
  const st = attachStreams(bus, { messages: makeMemoryMessages(), enforce: true, authenticate });
  return { bus, fs, st };
}

const cmd = (bus, envelope) => bus.resolve({ streams: { command: envelope } });
const qry = (bus, req) => bus.resolve({ streams: { query: req } });

test('post + tail in a public room, signed end-to-end', async () => {
  const { bus } = setup();
  const alice = newIdentity();
  await bus.resolve({ filespace: { command: await signAction(alice, 'claim', { slug: '/alice', policy: 'public' }) } });

  const a = await cmd(bus, signAction(alice, 'post', { slug: '/alice', body: 'first!', label: 'alice' }));
  assert.equal(a.ok, true);
  assert.equal(a.message.seq, 1);
  assert.equal(a.message.author, alice.publicKey);

  const eve = newIdentity(); // a signed guest — public rooms welcome posts
  const b = await cmd(bus, signAction(eve, 'post', { slug: '/alice', body: 'hello from a passerby' }));
  assert.equal(b.ok, true);
  assert.equal(b.message.seq, 2);

  const log = await qry(bus, { op: 'tail', slug: '/alice' });
  assert.deepEqual(log.map((m) => m.body), ['first!', 'hello from a passerby']);
});

test('protected rooms: guests read history but cannot post; members can', async () => {
  const { bus } = setup();
  const alice = newIdentity();
  const bob = newIdentity();
  const eve = newIdentity();
  await bus.resolve({ filespace: { command: signAction(alice, 'claim', { slug: '/alice', policy: 'protected' }) } });
  await bus.resolve({ filespace: { command: signAction(alice, 'invite', { slug: '/alice', who: bob.publicKey }) } });
  await cmd(bus, signAction(alice, 'post', { slug: '/alice', body: 'members only mic' }));

  const denied = await cmd(bus, signAction(eve, 'post', { slug: '/alice', body: 'let me in' }));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');

  assert.equal((await cmd(bus, signAction(bob, 'post', { slug: '/alice', body: 'bob here' }))).ok, true);
  assert.deepEqual((await qry(bus, { op: 'tail', slug: '/alice' })).map((m) => m.body), ['members only mic', 'bob here']);
});

test('private rooms: history is invisible to outsiders, visible to members', async () => {
  const { bus } = setup();
  const alice = newIdentity();
  const bob = newIdentity();
  await bus.resolve({ filespace: { command: signAction(alice, 'claim', { slug: '/alice', policy: 'private' }) } });
  await bus.resolve({ filespace: { command: signAction(alice, 'create', { slug: '/alice/proj' }) } });
  await bus.resolve({ filespace: { command: signAction(alice, 'invite', { slug: '/alice/proj', who: bob.publicKey }) } });
  await cmd(bus, signAction(alice, 'post', { slug: '/alice/proj', body: 'secret plans' }));

  assert.deepEqual(await qry(bus, { op: 'tail', slug: '/alice/proj' }), []); // anonymous: nothing, not even 403
  const eve = newIdentity();
  assert.deepEqual(await qry(bus, signAction(eve, 'tail', { slug: '/alice/proj' })), []);

  // bob was invited to the PROJECT (chain membership) — he sees and speaks
  const log = await qry(bus, signAction(bob, 'tail', { slug: '/alice/proj' }));
  assert.deepEqual(log.map((m) => m.body), ['secret plans']);
  assert.equal((await cmd(bus, signAction(bob, 'post', { slug: '/alice/proj', body: 'on it' }))).ok, true);
});

test('unsigned posts are rejected when authenticate is on; body is validated', async () => {
  const { bus } = setup();
  const alice = newIdentity();
  await bus.resolve({ filespace: { command: signAction(alice, 'claim', { slug: '/alice' }) } });

  const unsigned = await cmd(bus, { op: 'post', slug: '/alice', body: 'sneaky', principal: alice.publicKey });
  assert.equal(unsigned.ok, false);
  assert.match(unsigned.error, /signed envelope required/);

  assert.equal((await cmd(bus, signAction(alice, 'post', { slug: '/alice', body: '' }))).ok, false);
  assert.equal((await cmd(bus, signAction(alice, 'post', { slug: '/alice', body: 'x'.repeat(5000) }))).ok, false);
  assert.equal((await cmd(bus, signAction(alice, 'post', { slug: '/nowhere', body: 'hi' }))).ok, false);
});

test('successful posts announce { streams: { changed } } for fan-out', async () => {
  const { bus } = setup();
  const seen = [];
  bus.register({
    id: 'test.watcher',
    resolve(e) {
      const c = e?.streams?.changed;
      if (c) seen.push(`${c.op} ${c.slug} #${c.message.seq}`);
    },
  });
  const alice = newIdentity();
  await bus.resolve({ filespace: { command: signAction(alice, 'claim', { slug: '/alice' }) } });
  await cmd(bus, signAction(alice, 'post', { slug: '/alice', body: 'one' }));
  await cmd(bus, signAction(alice, 'post', { slug: '/alice', body: 'two' }));
  const eve = newIdentity();
  await cmd(bus, signAction(eve, 'post', { slug: '/alice/nope', body: 'nope' })); // denied → no announce
  assert.deepEqual(seen, ['post /alice #1', 'post /alice #2']);
});

test('tail pagination: after + limit', async () => {
  const { bus } = setup({ authenticate: false }); // unsigned principals, authorization still on
  await bus.resolve({ filespace: { command: { op: 'claim', slug: '/room', principal: 'host' } } });
  for (let i = 1; i <= 10; i++) await cmd(bus, { op: 'post', slug: '/room', body: `m${i}`, principal: 'host' });

  const last3 = await qry(bus, { op: 'tail', slug: '/room', limit: 3 });
  assert.deepEqual(last3.map((m) => m.body), ['m8', 'm9', 'm10']);
  const after7 = await qry(bus, { op: 'tail', slug: '/room', after: 7 });
  assert.deepEqual(after7.map((m) => m.seq), [8, 9, 10]);
});
