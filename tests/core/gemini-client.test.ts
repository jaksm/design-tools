/**
 * GeminiVisionClient unit tests
 * Tests the client in isolation — all HTTP calls are mocked via vi.stubGlobal('fetch').
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GeminiVisionClient,
  GeminiAuthError,
  GeminiRateLimitError,
  GeminiApiError,
  GeminiNetworkError,
  GeminiParseError,
} from '../../src/core/gemini-client.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-key-xyz';

function createClient(overrides: Record<string, unknown> = {}) {
  return new GeminiVisionClient({
    apiKey: TEST_API_KEY,
    maxRetries: 3,
    ...overrides,
  });
}

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Error ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function validGeminiResponse(text: string = '{"score": 8}') {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      totalTokenCount: 150,
    },
  };
}

const testImage = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, // PNG signature
  0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

// ── Setup / Teardown ────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// Construction & Config
// ═══════════════════════════════════════════════════════════════════════════

describe('construction', () => {
  it('creates with valid config', () => {
    const client = createClient();
    expect(client).toBeDefined();
    expect(client.usage.limit).toBe(500);
  });

  it('accepts custom model and rate limit', () => {
    const client = createClient({
      model: 'gemini-2.5-flash',
      rateLimitPerDay: 1000,
    });
    expect(client.usage.limit).toBe(1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Successful Analysis
// ═══════════════════════════════════════════════════════════════════════════

describe('analyze — success', () => {
  it('returns parsed text from Gemini response', async () => {
    const fetchMock = mockFetch(200, validGeminiResponse('{"result": "ok"}'));
    globalThis.fetch = fetchMock;

    const client = createClient();
    const result = await client.analyze(testImage, 'test prompt');

    expect(result.text).toBe('{"result": "ok"}');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends correct API URL with key', async () => {
    const fetchMock = mockFetch(200, validGeminiResponse());
    globalThis.fetch = fetchMock;

    const client = createClient();
    await client.analyze(testImage, 'test');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain(`key=${TEST_API_KEY}`);
    expect(url).toContain('generateContent');
  });

  it('sends image as base64 in request body', async () => {
    const fetchMock = mockFetch(200, validGeminiResponse());
    globalThis.fetch = fetchMock;

    const client = createClient();
    await client.analyze(testImage, 'test');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const parts = body.contents[0].parts;
    expect(parts[0].inlineData.data).toBe(testImage.toString('base64'));
    expect(parts[1].text).toBe('test');
  });

  it('returns usage metadata when present', async () => {
    const fetchMock = mockFetch(200, validGeminiResponse());
    globalThis.fetch = fetchMock;

    const client = createClient();
    const result = await client.analyze(testImage, 'test');

    expect(result.usageMetadata).toBeDefined();
    expect(result.usageMetadata?.totalTokenCount).toBe(150);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe('analyze — errors', () => {
  it('throws GeminiAuthError on 401', async () => {
    globalThis.fetch = mockFetch(401, { error: { message: 'Invalid API key' } });
    const client = createClient();

    await expect(client.analyze(testImage, 'test')).rejects.toThrow(GeminiAuthError);
  });

  it('throws GeminiAuthError on 403', async () => {
    globalThis.fetch = mockFetch(403, { error: { message: 'Forbidden' } });
    const client = createClient();

    await expect(client.analyze(testImage, 'test')).rejects.toThrow(GeminiAuthError);
  });

  it('auth error includes actionable message about API key', async () => {
    globalThis.fetch = mockFetch(401, { error: { message: 'Invalid' } });
    const client = createClient();

    try {
      await client.analyze(testImage, 'test');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/API key|apiKey|GEMINI_API_KEY/i);
    }
  });

  it('throws GeminiApiError on 500', async () => {
    globalThis.fetch = mockFetch(500, { error: { message: 'Internal' } });
    const client = createClient();

    await expect(client.analyze(testImage, 'test')).rejects.toThrow(GeminiApiError);
  });

  it('API error includes status code', async () => {
    globalThis.fetch = mockFetch(500, { error: { message: 'Internal' } });
    const client = createClient();

    try {
      await client.analyze(testImage, 'test');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as GeminiApiError).statusCode).toBe(500);
    }
  });

  it('throws GeminiNetworkError on fetch failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = createClient();

    await expect(client.analyze(testImage, 'test')).rejects.toThrow(GeminiNetworkError);
  });

  it('throws GeminiParseError when response has no candidates', async () => {
    globalThis.fetch = mockFetch(200, { candidates: [] });
    const client = createClient();

    await expect(client.analyze(testImage, 'test')).rejects.toThrow(GeminiParseError);
  });

  it('throws GeminiParseError when response has no text in parts', async () => {
    globalThis.fetch = mockFetch(200, {
      candidates: [{ content: { parts: [] } }],
    });
    const client = createClient();

    await expect(client.analyze(testImage, 'test')).rejects.toThrow(GeminiParseError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rate Limiting & Retry
// ═══════════════════════════════════════════════════════════════════════════

describe('rate limiting & retry', () => {
  it('retries on 429 with exponential backoff', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) , text: async () => '{}' };
      }
      return { ok: true, status: 200, json: async () => validGeminiResponse(), text: async () => JSON.stringify(validGeminiResponse()) };
    });

    const client = createClient({ maxRetries: 3 });
    const result = await client.analyze(testImage, 'test');

    expect(result.text).toBeDefined();
    expect(callCount).toBe(3);
  });

  it('throws GeminiRateLimitError after exhausting all retries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 429, statusText: 'Too Many Requests',
      json: async () => ({}), text: async () => '{}',
    });

    const client = createClient({ maxRetries: 2 });
    await expect(client.analyze(testImage, 'test')).rejects.toThrow(GeminiRateLimitError);
  });

  it('does not retry on non-429 errors', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return { ok: false, status: 500, statusText: 'Internal', json: async () => ({}), text: async () => '{}' };
    });

    const client = createClient({ maxRetries: 3 });
    await expect(client.analyze(testImage, 'test')).rejects.toThrow();
    expect(callCount).toBe(1); // No retries
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Usage Tracking
// ═══════════════════════════════════════════════════════════════════════════

describe('usage tracking', () => {
  it('increments usage counter on successful call', async () => {
    globalThis.fetch = mockFetch(200, validGeminiResponse());
    const client = createClient();

    expect(client.usage.today).toBe(0);
    await client.analyze(testImage, 'test');
    expect(client.usage.today).toBe(1);
    await client.analyze(testImage, 'test');
    expect(client.usage.today).toBe(2);
  });

  it('resets usage on new day', async () => {
    globalThis.fetch = mockFetch(200, validGeminiResponse());
    const client = createClient();

    await client.analyze(testImage, 'test');
    expect(client.usage.today).toBe(1);

    // Simulate day change by resetting
    client.resetUsage();
    expect(client.usage.today).toBe(0);
  });

  it('reports remaining correctly', async () => {
    globalThis.fetch = mockFetch(200, validGeminiResponse());
    const client = createClient({ rateLimitPerDay: 100 });

    await client.analyze(testImage, 'test');
    expect(client.usage.remaining).toBe(99);
    expect(client.usage.limit).toBe(100);
  });

  it('usage date is YYYY-MM-DD format', async () => {
    globalThis.fetch = mockFetch(200, validGeminiResponse());
    const client = createClient();

    await client.analyze(testImage, 'test');
    expect(client.usage.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MIME Type Detection
// ═══════════════════════════════════════════════════════════════════════════

describe('MIME type detection', () => {
  it('detects PNG from magic bytes', async () => {
    const fetchMock = mockFetch(200, validGeminiResponse());
    globalThis.fetch = fetchMock;
    const client = createClient();

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await client.analyze(png, 'test');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('image/png');
  });

  it('detects JPEG from magic bytes', async () => {
    const fetchMock = mockFetch(200, validGeminiResponse());
    globalThis.fetch = fetchMock;
    const client = createClient();

    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    await client.analyze(jpeg, 'test');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg');
  });

  it('defaults to image/png for unknown magic bytes', async () => {
    const fetchMock = mockFetch(200, validGeminiResponse());
    globalThis.fetch = fetchMock;
    const client = createClient();

    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    await client.analyze(unknown, 'test');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('image/png');
  });
});
