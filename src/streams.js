// streams — room-based conversation over a filespace, as ONE bus listener.
//
// A chat room is not a new concept: it is a filespace node whose message log
// this service owns. Streams reserves a single bus key, mirroring filespace:
//
//   { streams: { query:   { op: 'tail', slug, after?, limit? } } }
//   { streams: { command: { op: 'post', slug, body, label?, principal, auth } } }
//
// and announces successful posts (for a server to fan out room-scoped):
//
//   { streams: { changed: { op: 'post', slug, message } } }
//
// Permissions are NOT reinvented — they are filespace's, consulted live:
//   - tail: you may read a room's log iff you may read the node
//     (fs.get(slug, reader) already applies privacy + chain inheritance).
//   - post: filespace's reserved `post` verb — guests may post in PUBLIC
//     rooms, members anywhere they belong, chain rules included. This is the
//     verb the policy table has been holding open for exactly this layer.
//
// Authentication reuses filespace's signed-envelope guard verbatim: same
// envelope, same signing string, separate nonce set.
//
// Presence — the other half of "streams" — is deliberately NOT here. It is
// ephemeral, per-connection, latest-wins state that belongs to the transport
// (socket.io rooms in @orbitalfoundation/server), never to the bus or a store.
// The coarse-unit principle: a wiggle is not a bus event.

import { makeAuthGuard, policy } from '@orbitalfoundation/filespace';

const SCHEMA = { streams: true };
const deny = (error) => ({ ok: false, error });

const MAX_BODY = 4000;

export function makeStreams(messages, { enforce = true, authenticate = false, verify, now } = {}) {
  const guard = authenticate ? makeAuthGuard({ verify, now }) : null;
  let fs = null; // the filespace service, discovered from the bus at registration
  let bus = null;

  function announce(op, payload) {
    if (!bus) return;
    try {
      const r = bus.resolve({ streams: { changed: { op, ...payload } } });
      if (r?.catch) r.catch(() => {});
    } catch { /* observers must not break writes */ }
  }

  // The room is a filespace node; visibility is filespace's call. Passing the
  // reader through fs.get gives privacy + chain inheritance for free (null when
  // hidden — a private room and a nonexistent room look identical).
  async function room(slug, reader) {
    if (!fs) return null;
    return fs.get(slug, reader);
  }

  async function post({ slug, body, label = null, principal = null } = {}) {
    if (typeof body !== 'string' || !body.trim()) return deny('body required');
    if (body.length > MAX_BODY) return deny(`body too long (max ${MAX_BODY})`);
    const node = await room(slug, principal);
    if (!node) return deny('no such room (or not visible to you)');
    if (enforce && !policy.can(principal, 'post', node, { chain: await fs.ancestorsOf(node.slug) })) {
      return deny('forbidden');
    }
    const message = await messages.append(node.slug, { author: principal, label, body });
    announce('post', { slug: node.slug, message });
    return { ok: true, message };
  }

  async function tail({ slug, after = 0, limit = 50 } = {}, reader = null) {
    const node = await room(slug, reader);
    if (!node) return []; // hidden rooms have no history, as far as you know
    return messages.tail(node.slug, { after: Number(after) || 0, limit: Math.min(Number(limit) || 50, 200) });
  }

  async function command(req = {}) {
    const a = guard ? guard(req) : { ok: true };
    if (!a.ok) return deny(a.error);
    const { op, auth, ...params } = req;
    if (op === 'post') return post(params);
    return deny(`unknown command: ${op}`);
  }

  // Mirrors filespace: absent identity reads anonymously; a present-but-invalid
  // proof fails loudly rather than silently downgrading to guest.
  async function query(req = {}) {
    const { op, auth, principal, ...params } = req ?? {};
    let reader = null;
    if (principal) {
      if (authenticate) {
        const a = guard(req);
        if (!a.ok) return deny(a.error);
      }
      reader = principal;
    }
    if (op === 'tail') return tail(params, reader);
    return null;
  }

  return {
    query,
    command,
    post,
    tail,
    bindBus: (b) => {
      bus = b;
      fs = b?.filespace ?? null; // filespace must be attached first
    },
  };
}

export function createStreams({ messages, enforce = true, authenticate = false, verify, now } = {}) {
  if (!messages) throw new Error('createStreams requires a message store');
  const service = makeStreams(messages, { enforce, authenticate, verify, now });

  const entity = {
    id: 'bus.streams',
    resolve(event, bus) {
      if (event.registered) {
        bus.install?.('streams', service);
        service.bindBus(bus);
        bus.resolve?.({ schema: SCHEMA });
        return;
      }
      const req = event.streams;
      if (!req || typeof req !== 'object') return undefined;
      if ('query' in req) return service.query(req.query);
      if ('command' in req) return service.command(req.command);
      return undefined; // 'changed' announcements fall through to observers
    },
  };

  return { entity, service };
}

export function attach(bus, opts = {}) {
  const { entity, service } = createStreams(opts);
  bus.register(entity);
  return service;
}
