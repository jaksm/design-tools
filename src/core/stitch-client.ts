/**
 * StitchClient — Direct HTTP JSON-RPC 2.0 client for Google Stitch API.
 * No MCP SDK, no mcporter. Pure fetch.
 */

import {
  type StitchClientConfig,
  type JsonRpcRequest,
  type JsonRpcResponse,
  StitchError,
  StitchAuthError,
  StitchPermissionError,
  StitchRateLimitError,
  StitchTimeoutError,
  StitchNetworkError,
  StitchParseError,
  StitchRpcError,
} from './types.js';

const DEFAULT_BASE_URL = 'https://stitch.googleapis.com/mcp';
const DEFAULT_TIMEOUT = 60_000; // 60 seconds
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

export class StitchClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private requestId = 0;

  constructor(config: StitchClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Call a JSON-RPC method on the Stitch API.
   */
  async callTool(method: string, args: Record<string, unknown>): Promise<unknown> {
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params: args,
      id: ++this.requestId,
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }

      try {
        const result = await this.executeRequest(body);
        return result;
      } catch (error) {
        if (error instanceof StitchRateLimitError && attempt < MAX_RETRIES) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    // Should only reach here if all retries were rate-limited
    throw lastError ?? new StitchRateLimitError('Rate limit exceeded after all retries (429)');
  }

  private async executeRequest(body: JsonRpcRequest): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new StitchTimeoutError(`Request timed out after ${this.timeout}ms`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new StitchNetworkError(`Network error: ${message}`, error);
    } finally {
      clearTimeout(timeoutId);
    }

    // Handle HTTP-level errors
    if (!response.ok) {
      await this.handleHttpError(response);
    }

    // Parse JSON response
    let data: unknown;
    try {
      const text = await response.text();
      data = JSON.parse(text);
    } catch (error) {
      throw new StitchParseError('Failed to parse response as JSON', error);
    }

    // Validate JSON-RPC response
    return this.parseJsonRpcResponse(data as JsonRpcResponse);
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
        throw new StitchAuthError(
          errorMessage || 'Unauthorized — invalid or expired API key',
          401,
        );
      case 403:
        throw new StitchPermissionError(
          errorMessage || 'Forbidden — insufficient permissions',
          403,
        );
      case 429:
        throw new StitchRateLimitError(
          errorMessage || 'Rate limit exceeded (429)',
        );
      default:
        throw new StitchError(
          errorMessage || `HTTP ${response.status}: ${response.statusText}`,
          { statusCode: response.status },
        );
    }
  }

  private parseJsonRpcResponse(data: JsonRpcResponse): unknown {
    if ('error' in data && data.error) {
      throw new StitchRpcError(data.error.message, data.error.code);
    }

    if (!('result' in data)) {
      throw new StitchParseError('Invalid JSON-RPC response: missing both "result" and "error" fields');
    }

    return data.result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
