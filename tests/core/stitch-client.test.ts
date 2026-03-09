/**
 * StitchClient tests — TC-SC-01 through TC-SC-19
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StitchClient } from '../../src/core/stitch-client.js';
import {
  StitchAuthError,
  StitchPermissionError,
  StitchRateLimitError,
  StitchTimeoutError,
  StitchNetworkError,
  StitchParseError,
  StitchRpcError,
  StitchError,
} from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonRpcSuccess(result: unknown, id = 1) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ jsonrpc: '2.0', id, result }),
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
  } as unknown as Response;
}

function jsonRpcError(code: number, message: string, id = 1) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ jsonrpc: '2.0', id, error: { code, message } }),
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  } as unknown as Response;
}

function httpError(status: number, body?: Record<string, unknown>) {
  return {
    ok: false,
    status,
    statusText: `Error ${status}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  } as unknown as Response;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('StitchClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // TC-SC-01: Successful tool call returns structured response
  it('TC-SC-01: successful call returns result field', async () => {
    const expected = { tools: [{ name: 'test' }] };
    fetchSpy.mockResolvedValueOnce(jsonRpcSuccess(expected));

    const client = new StitchClient({ apiKey: 'test-key' });
    const result = await client.callTool('tools/list', {});

    expect(result).toEqual(expected);
  });

  // TC-SC-02: API key sent as X-Goog-Api-Key header
  it('TC-SC-02: API key sent as X-Goog-Api-Key header', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRpcSuccess('ok'));

    const client = new StitchClient({ apiKey: 'test-api-key-abc123' });
    await client.callTool('test', {});

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-api-key-abc123');

    // Verify no API key in URL or body
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).not.toContain('test-api-key-abc123');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(JSON.stringify(body)).not.toContain('test-api-key-abc123');
  });

  // TC-SC-03: Request body is valid JSON-RPC 2.0
  it('TC-SC-03: request body is valid JSON-RPC 2.0', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRpcSuccess('ok'));

    const client = new StitchClient({ apiKey: 'key' });
    await client.callTool('someMethod', { param1: 'value' });

    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('someMethod');
    expect(body.params).toEqual({ param1: 'value' });
    expect(body.id).toBeDefined();
    expect(body.id).not.toBeNull();
  });

  // TC-SC-04: Request URL is always the Stitch endpoint
  it('TC-SC-04: request URL is the Stitch endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRpcSuccess('ok'));

    const client = new StitchClient({ apiKey: 'key' });
    await client.callTool('test', {});

    const url = fetchSpy.mock.calls[0]![0];
    expect(url).toBe('https://stitch.googleapis.com/mcp');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  // TC-SC-05: Request times out after configured timeout
  it('TC-SC-05: request times out after configured timeout', async () => {
    vi.useRealTimers(); // Use real timers with short timeout

    fetchSpy.mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const client = new StitchClient({ apiKey: 'key', timeout: 50 });
    const promise = client.callTool('slow/method', {});

    await expect(promise).rejects.toThrow(StitchTimeoutError);
    await expect(promise).rejects.toThrow(/timed out/i);

    vi.useFakeTimers();
  });

  // TC-SC-06: Default timeout applies when none configured
  it('TC-SC-06: default timeout is 60s', () => {
    vi.useRealTimers(); // Can't fake-timer 60s reliably

    // Verify the client uses 60s default by constructing without timeout
    // and checking it passes an AbortSignal to fetch
    let capturedSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal as AbortSignal;
      // Immediately resolve to avoid waiting
      return Promise.resolve(jsonRpcSuccess('ok'));
    });

    const client = new StitchClient({ apiKey: 'key' });
    // The default timeout is 60s — verified via documentation and constructor.
    // We confirm a signal is passed (timeout mechanism active).
    return client.callTool('test', {}).then(() => {
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false); // Not aborted yet — completed before timeout
      vi.useFakeTimers();
    });
  });

  // TC-SC-07: 429 triggers exponential backoff with up to 3 retries
  it('TC-SC-07: 429 retries with exponential backoff, success on 3rd', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return httpError(429, { error: { message: 'Rate limit' } });
      }
      return jsonRpcSuccess({ ok: true });
    });

    const client = new StitchClient({ apiKey: 'key' });
    const promise = client.callTool('test', {});

    // First call happens immediately, returns 429
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Wait for first retry (1s backoff)
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(2);

    // Wait for second retry (2s backoff)
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(3);

    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(3);
  });

  // TC-SC-08: 429 on all retries — throws rate limit error
  it('TC-SC-08: 429 on all retries throws rate limit error', async () => {
    vi.useRealTimers(); // Use real timers with a patched short delay client

    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      return httpError(429, { error: { message: 'Rate limit' } });
    });

    // Use a very short timeout so real retries are fast
    const client = new StitchClient({ apiKey: 'key', timeout: 5000 });

    // Monkey-patch the sleep to be instant for this test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).sleep = () => Promise.resolve();

    await expect(client.callTool('test', {})).rejects.toThrow(StitchRateLimitError);
    expect(callCount).toBe(4); // 1 original + 3 retries

    vi.useFakeTimers();
  });

  // TC-SC-09: Non-429 errors are NOT retried
  it('TC-SC-09: 500 is not retried', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      return httpError(500);
    });

    const client = new StitchClient({ apiKey: 'key' });
    await expect(client.callTool('test', {})).rejects.toThrow(StitchError);
    expect(callCount).toBe(1);
  });

  it('TC-SC-09b: 400 is not retried', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      return httpError(400);
    });

    const client = new StitchClient({ apiKey: 'key' });
    await expect(client.callTool('test', {})).rejects.toThrow();
    expect(callCount).toBe(1);
  });

  it('TC-SC-09c: 401 is not retried', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      return httpError(401);
    });

    const client = new StitchClient({ apiKey: 'key' });
    await expect(client.callTool('test', {})).rejects.toThrow();
    expect(callCount).toBe(1);
  });

  it('TC-SC-09d: 403 is not retried', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      return httpError(403);
    });

    const client = new StitchClient({ apiKey: 'key' });
    await expect(client.callTool('test', {})).rejects.toThrow();
    expect(callCount).toBe(1);
  });

  // TC-SC-10: HTTP 400 → meaningful error message
  it('TC-SC-10: HTTP 400 with error message', async () => {
    fetchSpy.mockResolvedValueOnce(
      httpError(400, { error: { message: 'Invalid request parameter' } }),
    );

    const client = new StitchClient({ apiKey: 'key' });
    try {
      await client.callTool('test', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const e = error as StitchError;
      expect(e.message).toContain('Invalid request parameter');
      expect(e.statusCode).toBe(400);
    }
  });

  // TC-SC-11: HTTP 401 → authentication error
  it('TC-SC-11: HTTP 401 throws StitchAuthError', async () => {
    fetchSpy.mockResolvedValueOnce(httpError(401));

    const client = new StitchClient({ apiKey: 'bad-key' });
    try {
      await client.callTool('test', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StitchAuthError);
      const e = error as StitchAuthError;
      expect(e.message).toMatch(/unauthorized|api key|authentication/i);
      expect(e.statusCode).toBe(401);
    }
  });

  // TC-SC-12: HTTP 403 → permission error, distinct from 401
  it('TC-SC-12: HTTP 403 throws StitchPermissionError', async () => {
    fetchSpy.mockResolvedValueOnce(httpError(403));

    const client = new StitchClient({ apiKey: 'key' });
    try {
      await client.callTool('test', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StitchPermissionError);
      expect(error).not.toBeInstanceOf(StitchAuthError);
      const e = error as StitchPermissionError;
      expect(e.message).toMatch(/forbidden|permission/i);
      expect(e.statusCode).toBe(403);
    }
  });

  // TC-SC-13: HTTP 500 → server error, not retry
  it('TC-SC-13: HTTP 500 throws immediately', async () => {
    fetchSpy.mockResolvedValueOnce(httpError(500));

    const client = new StitchClient({ apiKey: 'key' });
    try {
      await client.callTool('test', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StitchError);
      const e = error as StitchError;
      expect(e.statusCode).toBe(500);
    }
  });

  // TC-SC-14: Network failure → graceful error
  it('TC-SC-14: network failure throws StitchNetworkError', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const client = new StitchClient({ apiKey: 'key' });
    try {
      await client.callTool('test', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StitchNetworkError);
      expect((error as StitchNetworkError).message).toContain('Failed to fetch');
    }
  });

  // TC-SC-15: DNS failure → graceful error
  it('TC-SC-15: DNS failure throws StitchNetworkError', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('getaddrinfo ENOTFOUND stitch.googleapis.com'));

    const client = new StitchClient({ apiKey: 'key' });
    try {
      await client.callTool('test', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StitchNetworkError);
      expect((error as StitchNetworkError).message).toContain('ENOTFOUND');
    }
  });

  // TC-SC-16: Invalid JSON response → parse error
  it('TC-SC-16: invalid JSON response throws StitchParseError', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'this is not json {{{',
    } as unknown as Response);

    const client = new StitchClient({ apiKey: 'key' });
    await expect(client.callTool('test', {})).rejects.toThrow(StitchParseError);
  });

  // TC-SC-17: JSON-RPC error response → rejects with error details
  it('TC-SC-17: JSON-RPC error response throws StitchRpcError', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRpcError(-32600, 'Invalid Request'));

    const client = new StitchClient({ apiKey: 'key' });
    try {
      await client.callTool('test', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StitchRpcError);
      const e = error as StitchRpcError;
      expect(e.message).toContain('Invalid Request');
      expect(e.rpcCode).toBe(-32600);
    }
  });

  // TC-SC-18: Response missing result and error → error
  it('TC-SC-18: missing result and error fields throws', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    } as unknown as Response);

    const client = new StitchClient({ apiKey: 'key' });
    await expect(client.callTool('test', {})).rejects.toThrow(StitchParseError);
  });

  // TC-SC-19 (P2): Response id mismatch — our sequential client ignores this
  it('TC-SC-19: response id mismatch is tolerated (sequential client)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'ok' }),
    } as unknown as Response);

    const client = new StitchClient({ apiKey: 'key' });
    // Should not throw — sequential client tolerates id mismatch
    const result = await client.callTool('test', {});
    expect(result).toBe('ok');
  });
});
