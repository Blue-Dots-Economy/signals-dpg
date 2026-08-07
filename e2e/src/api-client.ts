import type { APIRequestContext, APIResponse } from '@playwright/test';

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: T;
  raw: APIResponse;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** better-auth session bearer token, for authenticated user calls. */
  bearer?: string | null;
  /** Two-header service auth (P5/P6): x-api-key + x-acting-org-id. */
  apiKey?: string | null;
  actingOrgId?: string | null;
  /** Extra default headers (e.g. Host for served-binding). */
  headers?: Record<string, string>;
}

/**
 * Thin typed wrapper over Playwright's APIRequestContext. All journey/API tests
 * talk to the running target through this — it centralizes base URL joining,
 * auth headers, and response parsing so specs stay about behavior.
 */
export class ApiClient {
  constructor(
    private readonly request: APIRequestContext,
    private readonly opts: ApiClientOptions,
  ) {}

  /** Return a copy of this client with different/added auth. */
  with(overrides: Partial<ApiClientOptions>): ApiClient {
    return new ApiClient(this.request, { ...this.opts, ...overrides });
  }

  private defaultHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.opts.headers ?? {}) };
    if (this.opts.bearer) h['authorization'] = `Bearer ${this.opts.bearer}`;
    if (this.opts.apiKey) h['x-api-key'] = this.opts.apiKey;
    if (this.opts.actingOrgId) h['x-acting-org-id'] = this.opts.actingOrgId;
    return h;
  }

  private url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return `${this.opts.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async wrap<T>(raw: APIResponse): Promise<ApiResult<T>> {
    let body: unknown = undefined;
    const text = await raw.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: raw.status(), ok: raw.ok(), headers: raw.headers(), body: body as T, raw };
  }

  async get<T = unknown>(path: string, opts?: { headers?: Record<string, string> }): Promise<ApiResult<T>> {
    const raw = await this.request.get(this.url(path), { headers: { ...this.defaultHeaders(), ...(opts?.headers ?? {}) } });
    return this.wrap<T>(raw);
  }

  async post<T = unknown>(path: string, data?: unknown, opts?: { headers?: Record<string, string> }): Promise<ApiResult<T>> {
    const raw = await this.request.post(this.url(path), {
      headers: { ...this.defaultHeaders(), ...(opts?.headers ?? {}) },
      data: data === undefined ? undefined : JSON.stringify(data),
    });
    return this.wrap<T>(raw);
  }

  async patch<T = unknown>(path: string, data?: unknown, opts?: { headers?: Record<string, string> }): Promise<ApiResult<T>> {
    const raw = await this.request.patch(this.url(path), {
      headers: { ...this.defaultHeaders(), ...(opts?.headers ?? {}) },
      data: data === undefined ? undefined : JSON.stringify(data),
    });
    return this.wrap<T>(raw);
  }

  async delete<T = unknown>(path: string, opts?: { headers?: Record<string, string> }): Promise<ApiResult<T>> {
    // No body ⇒ no content-type. Sending `application/json` with an empty body
    // makes Fastify reject the request with FST_ERR_CTP_EMPTY_JSON_BODY (400)
    // before the route is ever reached, so every DELETE looked like a 400
    // regardless of what the endpoint actually does.
    const { 'content-type': _drop, ...headers } = this.defaultHeaders();
    const raw = await this.request.delete(this.url(path), {
      headers: { ...headers, ...(opts?.headers ?? {}) },
    });
    return this.wrap<T>(raw);
  }
}
