import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env["CHECKMARX_API_KEY"] = "test-api-key-12345";
    process.env["CHECKMARX_TENANT"] = "test-tenant";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads valid config with required vars", () => {
    const config = loadConfig();

    expect(config.checkmarx.apiKey).toBe("test-api-key-12345");
    expect(config.checkmarx.tenant).toBe("test-tenant");
    expect(config.checkmarx.baseUrl).toBe("https://ast.checkmarx.net");
    expect(config.checkmarx.iamUrl).toBe("https://iam.checkmarx.net");
    expect(config.checkmarx.projectId).toBeUndefined();
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
  });

  it("applies custom URLs and port", () => {
    process.env["CHECKMARX_BASE_URL"] = "https://eu.ast.checkmarx.net";
    process.env["CHECKMARX_IAM_URL"] = "https://eu.iam.checkmarx.net";
    process.env["PORT"] = "8080";
    process.env["TRANSPORT"] = "http";

    const config = loadConfig();

    expect(config.checkmarx.baseUrl).toBe("https://eu.ast.checkmarx.net");
    expect(config.checkmarx.iamUrl).toBe("https://eu.iam.checkmarx.net");
    expect(config.transport).toBe("http");
    expect(config.port).toBe(8080);
  });

  it("parses optional project ID", () => {
    process.env["CHECKMARX_PROJECT_ID"] = "550e8400-e29b-41d4-a716-446655440000";

    const config = loadConfig();

    expect(config.checkmarx.projectId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("throws on missing CHECKMARX_API_KEY", () => {
    delete process.env["CHECKMARX_API_KEY"];

    expect(() => loadConfig()).toThrow("checkmarx.apiKey");
  });

  it("throws on missing CHECKMARX_TENANT", () => {
    delete process.env["CHECKMARX_TENANT"];

    expect(() => loadConfig()).toThrow("checkmarx.tenant");
  });

  it("throws on invalid CHECKMARX_BASE_URL", () => {
    process.env["CHECKMARX_BASE_URL"] = "not-a-url";

    expect(() => loadConfig()).toThrow("checkmarx.baseUrl");
  });

  it("throws on invalid transport value", () => {
    process.env["TRANSPORT"] = "websocket";

    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("throws on invalid port number", () => {
    process.env["PORT"] = "99999";

    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("throws on invalid project ID format", () => {
    process.env["CHECKMARX_PROJECT_ID"] = "not-a-uuid";

    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("rejects whitespace-only API key", () => {
    process.env["CHECKMARX_API_KEY"] = "   ";

    expect(() => loadConfig()).toThrow("checkmarx.apiKey");
  });

  it("rejects whitespace-only tenant", () => {
    process.env["CHECKMARX_TENANT"] = "   ";

    expect(() => loadConfig()).toThrow("checkmarx.tenant");
  });

  it("treats empty CHECKMARX_PROJECT_ID as optional", () => {
    process.env["CHECKMARX_PROJECT_ID"] = "";

    const config = loadConfig();
    expect(config.checkmarx.projectId).toBeUndefined();
  });

  it("uses default when CHECKMARX_BASE_URL is empty", () => {
    process.env["CHECKMARX_BASE_URL"] = "";

    const config = loadConfig();
    expect(config.checkmarx.baseUrl).toBe("https://ast.checkmarx.net");
  });

  it("uses default when TRANSPORT is empty", () => {
    process.env["TRANSPORT"] = "";

    const config = loadConfig();
    expect(config.transport).toBe("stdio");
  });

  it("throws on non-numeric port", () => {
    process.env["PORT"] = "abc";

    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("includes all validation issues in error message", () => {
    delete process.env["CHECKMARX_API_KEY"];
    delete process.env["CHECKMARX_TENANT"];

    try {
      loadConfig();
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("checkmarx.apiKey");
      expect(message).toContain("checkmarx.tenant");
    }
  });
});
