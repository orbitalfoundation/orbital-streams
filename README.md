# @orbitalfoundation/streams

Room-based conversation over an [orbital filespace](../orbital-filespace) — a durable per-area **message log**, exposed as a single listener on the orbital bus.

A chat room is not a new concept here: it is a filespace node whose message log this service owns. Permissions are not reinvented — they are filespace's, consulted live:

- **tail** (read history): you may read a room's log iff you may read the node — privacy and ancestor-chain inheritance included. Hidden rooms have no history, as far as you can tell.
- **post**: filespace's reserved `post` verb — guests may post in *public* rooms, members anywhere they belong. This is the verb the policy table held open for exactly this layer.

One reserved bus key, mirroring filespace:

```js
{ streams: { query:   { op: 'tail', slug, after?, limit? } } }
{ streams: { command: { op: 'post', slug, body, label?, principal, auth } } }
{ streams: { changed: { op: 'post', slug, message } } }   // announced after a post
```

Authentication reuses filespace's signed-envelope guard verbatim. A message is `{ seq, slug, author, label, body, at }` — `seq` is a server-assigned per-room sequence (order and backfill), `author` is the signer's public key, `label` is a display name.

## Messages are not entities

Different churn, different shape, different store. The message store contract is three methods (`append`, `tail`, `rooms`) with two adapters: `memory`, and `file` — **JSONL**, because a conversation *is* an append-only log (one line per message; replayed at boot; no rewrite-the-world per post).

## Presence is deliberately not here

The other half of "streams" — who's in the room, cursors, typing, live markers — is ephemeral, per-connection, latest-wins state. It belongs to the transport ([@orbitalfoundation/server](../orbital-server) keeps it in memory against socket.io rooms), never to the bus or a store. The coarse-unit principle: a wiggle is not a bus event.

## Use

```js
import { createBus } from '@orbitalfoundation/bus';
import { attach as filespace, makeFileStore } from '@orbitalfoundation/filespace';
import { attach as streams, makeFileMessages } from '@orbitalfoundation/streams';

const bus = createBus();
filespace(bus, { store: makeFileStore('.filespace/nodes.json'), authenticate: true }); // first
streams(bus, { messages: makeFileMessages('.filespace/messages.jsonl'), authenticate: true });

await bus.resolve({ streams: { command: signAction(macy, 'post', { slug: '/lounge', body: 'hi' }) } });
await bus.resolve({ streams: { query: { op: 'tail', slug: '/lounge' } } });
```

```sh
npm test   # store contract, policy gating end-to-end, privacy, announce, pagination
```

## Later, deliberately

Edit/delete/reactions, `msg:chunk` streaming deltas (agent output), search over logs, per-room retention.
