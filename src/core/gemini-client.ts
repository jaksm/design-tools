/**
 * GeminiVisionClient — Sends images + prompts to Gemini Vision API.
 * Native fetch, no external dependencies. Rate-limited with exponential backoff on 429.
 */

// ── Error Classes ───────────────────────────────────────────────────────────

export class GeminiError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, options?: { statusCode?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'GeminiError';
    this.statusCode = options?.statusCode;
  }
}

export class GeminiAuthError extends GeminiError {
  constructor(message: string, statusCode: number) {
    super(message, { statusCode });
    this.name = 'GeminiAuthError';
  }
}

export class GeminiRateLimitError extends GeminiError {
  constructor(message: string) {
    super(message, { statusCode: 429 });
    this.name = 'GeminiRateLimitError';
  }
}

export class GeminiApiError extends GeminiError {
  constructor(message: string, statusCode: number) {
    super(message, { statusCode });
    this.name = 'GeminiApiError';
  }
}

export class GeminiNetworkError extends GeminiError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'GeminiNetworkError';
  }
}

export class GeminiParseError extends GeminiError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'GeminiParseError';
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface GeminiClientConfig {
  apiKey: string;
  model?: string;
  maxRetries?: number;
  rateLimitPerDay?: number;
}

export interface GeminiResponse {
  text: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface UsageState {
  date: string;
  count: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-2.5-pro-preview-06-05';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RATE_LIMIT_PER_DAY = 500;
const RATE_LIMIT_WARNING_THRESHOLD = 450;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Magic Bytes → MIME Type ─────────────────────────────────────────────────

function detectMimeType(buffer: Buffer): string {
  if (buffer.length < 4) {
    return 'image/png'; // fallback
  }

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }

  // WEBP: RIFF....WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return 'image/png'; // fallback for unknown formats
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Client ──────────────────────────────────────────────────────────────────

export class GeminiVisionClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly rateLimitPerDay: number;
  private usageState: UsageState;

  constructor(config: GeminiClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.rateLimitPerDay = config.rateLimitPerDay ?? DEFAULT_RATE_LIMIT_PER_DAY;
    this.usageState = { date: getUtcDateString(), count: 0 };
  }

  /**
   * Send an image + prompt to Gemini Vision API and return the text response.
   */
  async analyze(image: Buffer, prompt: string): Promise<GeminiResponse> {
    this.refreshUsageDate();

    // Check rate limit before making the call
    if (this.usageState.count >= this.rateLimitPerDay) {
      throw new GeminiRateLimitError(
        `Daily rate limit reached (${this.rateLimitPerDay} requests). Resets at midnight UTC.`,
      );
    }

    const mimeType = detectMimeType(image);
    const base64 = image.toString('base64');

    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      contents: [{
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: prompt },
        ],
      }],
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
        await sleep(delay);
      }

      try {
        const result = await this.executeRequest(url, body);
        return result;
      } catch (error) {
        if (error instanceof GeminiRateLimitError && attempt < this.maxRetries) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    // All retries exhausted on 429
    throw lastError ?? new GeminiRateLimitError('Rate limit exceeded after all retries (429)');
  }

  /**
   * Current usage stats for today.
   */
  get usage(): { today: number; limit: number; remaining: number; date: string } {
    this.refreshUsageDate();
    return {
      today: this.usageState.count,
      limit: this.rateLimitPerDay,
      remaining: Math.max(0, this.rateLimitPerDay - this.usageState.count),
      date: this.usageState.date,
    };
  }

  /**
   * Reset daily usage counter.
   */
  resetUsage(): void {
    this.usageState = { date: getUtcDateString(), count: 0 };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async executeRequest(
    url: string,
    body: Record<string, unknown>,
  ): Promise<GeminiResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GeminiNetworkError(`Network error: ${message}`, error);
    }

    if (!response.ok) {
      await this.handleHttpError(response);
    }

    // Track successful request
    this.usageState.count++;

    // Warn when approaching limit
    if (this.usageState.count >= RATE_LIMIT_WARNING_THRESHOLD) {
      console.warn(
        `[gemini-client] Approaching daily rate limit: ${this.usageState.count}/${this.rateLimitPerDay} requests used`,
      );
    }

    // Parse response
    let data: unknown;
    try {
      const text = await response.text();
      data = JSON.parse(text);
    } catch (error) {
      throw new GeminiParseError('Failed to parse Gemini API response as JSON', error);
    }

    return this.extractResponse(data);
  }

  private async handleHttpError(response: Response): Promise<never> {
    let errorMessage = '';
    try {
      const body = await response.json() as Record<string, unknown>;
      const error = body.error as Record<string, unknown> | undefined;
      errorMessage = (error?.message as string) ?? '';
    } catch {
      // Ignore JSON parse errors for error responses
    }

    switch (response.status) {
      case 401:
      case 403:
        throw new GeminiAuthError(
          `Gemini API key is invalid or expired. Set gemini.apiKey in plugin config or GEMINI_API_KEY environment variable.${errorMessage ? ` (API: ${errorMessage})` : ''}`,
          response.status,
        );
      case 429:
        throw new GeminiRateLimitError(
          errorMessage || 'Rate limit exceeded (429). Try again later.',
        );
      case 500:
        throw new GeminiApiError(
          errorMessage || 'Internal server error from Gemini API (500)',
          500,
        );
      default:
        throw new GeminiApiError(
          errorMessage || `Gemini API error: HTTP ${response.status} ${response.statusText}`,
          response.status,
        );
    }
  }

  private extractResponse(data: unknown): GeminiResponse {
    const obj = data as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') {
      throw new GeminiParseError('Gemini API returned a non-object response');
    }

    // Extract candidates
    const candidates = obj.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      throw new GeminiParseError('Gemini API response contains no candidates');
    }

    const firstCandidate = candidates[0];
    const content = firstCandidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;

    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      throw new GeminiParseError('Gemini API response candidate contains no parts');
    }

    // Find the first text part
    const textPart = parts.find((p) => typeof p.text === 'string');
    if (!textPart || typeof textPart.text !== 'string') {
      throw new GeminiParseError('Gemini API response contains no text in candidate parts');
    }

    // Extract usage metadata if present
    const rawUsage = obj.usageMetadata as Record<string, unknown> | undefined;
    const usageMetadata = rawUsage
      ? {
          promptTokenCount: rawUsage.promptTokenCount as number | undefined,
          candidatesTokenCount: rawUsage.candidatesTokenCount as number | undefined,
          totalTokenCount: rawUsage.totalTokenCount as number | undefined,
        }
      : undefined;

    return {
      text: textPart.text as string,
      usageMetadata,
    };
  }

  private refreshUsageDate(): void {
    const today = getUtcDateString();
    if (this.usageState.date !== today) {
      this.usageState = { date: today, count: 0 };
    }
  }
}
