import type { Config } from "../config.js";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const TOKEN_EXPIRY_BUFFER_MS = 60_000;

export class CheckmarxAuth {
  private readonly iamUrl: string;
  private readonly tenant: string;
  private readonly apiKey: string;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(config: Config) {
    this.iamUrl = config.checkmarx.iamUrl.replace(/\/+$/, "");
    this.tenant = config.checkmarx.tenant;
    this.apiKey = config.checkmarx.apiKey;
  }

  async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private async refreshToken(): Promise<string> {
    const tokenUrl = `${this.iamUrl}/auth/realms/${this.tenant}/protocol/openid-connect/token`;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "ast-app",
      refresh_token: this.apiKey,
    });

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("Checkmarx auth request timed out after 30s");
      }
      throw new Error(`Checkmarx auth request failed: ${message}`);
    }

    if (!response.ok) {
      let detail: string;
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        const desc = errorBody.error_description;
        const errType = errorBody.error;
        const parts: string[] = [];
        if (typeof errType === "string") parts.push(errType);
        if (typeof desc === "string") parts.push(desc);
        detail = parts.length > 0 ? parts.join(": ") : JSON.stringify(errorBody);
      } catch {
        detail = response.statusText;
      }

      throw new Error(
        `Checkmarx auth failed (HTTP ${response.status}): ${detail}. ` +
          `Verify CHECKMARX_API_KEY, CHECKMARX_TENANT, and CHECKMARX_IAM_URL (${this.iamUrl}).`,
      );
    }

    let data: TokenResponse;
    try {
      data = (await response.json()) as TokenResponse;
    } catch (error) {
      throw new Error("Checkmarx auth returned invalid JSON in success response");
    }

    if (!data.access_token || typeof data.access_token !== "string") {
      throw new Error("Checkmarx auth returned empty or missing access_token");
    }

    if (typeof data.expires_in !== "number" || data.expires_in <= 0) {
      throw new Error(`Checkmarx auth returned invalid expires_in: ${data.expires_in}`);
    }

    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS;

    return this.cachedToken;
  }

  invalidateToken(): void {
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }
}
