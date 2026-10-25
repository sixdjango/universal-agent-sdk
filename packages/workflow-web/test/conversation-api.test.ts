import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationReader } from '../src/api';

describe('conversation HTTP reader', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('scopes and encodes node calls, forwards pagination and AbortSignal, and only reads', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversations: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await conversationReader.list({ runId: 'run/1', nodeId: 'worker & read', scopeKey: '$root/each:item_2' }, { afterId: 'call/first', limit: 100 }, signal);
    const [path, options] = fetch.mock.calls[0];
    const url = new URL(path, 'http://localhost/');
    expect(url.pathname).toBe('/api/runs/run%2F1/conversations');
    expect(Object.fromEntries(url.searchParams)).toEqual({ nodeId: 'worker & read', scopeKey: '$root/each:item_2', afterId: 'call/first', limit: '100' });
    expect(options.signal).toBe(signal);
    expect(options.method).toBeUndefined();
    fetch.mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: 200 }), { status: 200 }));
    await conversationReader.events('call/1', { after: 100, limit: 100 }, signal);
    expect(fetch.mock.calls[1][0]).toBe('./api/conversations/call%2F1/events?after=100&limit=100');
  });
  it('surfaces unavailable history as an error, not an empty successful conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'History unavailable' }), { status: 503 })));
    await expect(conversationReader.get('missing', new AbortController().signal)).rejects.toMatchObject({ status: 503, message: 'History unavailable' });
  });
});
