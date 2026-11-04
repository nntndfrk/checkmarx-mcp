import { z } from "zod";

const TransportSchema = z.enum(["stdio", "http"]).default("stdio");

const ScaResolverSchema = z
  .object({
    mode: z
      .enum(["docker", "native"], {
        errorMap: () => ({ message: "CHECKMARX_SCA_RESOLVER must be 'docker' or 'native'" }),
      })
      .optional(),
    path: z.string().trim().min(1).optional(),
    version: z.string().trim().min(1).default("2.12.23"),
    image: z.string().trim().min(1).default("node:24.16.0-bookworm"),
    platform: z.string().trim().min(1).default("linux/amd64"),
    timeoutMs: z.coerce.number().int().positive().default(600_000),
    sha256: z
      .string()
      .trim()
      .regex(/^[a-fA-F0-9]{64}$/, "CHECKMARX_SCA_RESOLVER_SHA256 must be a SHA-256 hex digest")
      .optional(),
  })
  .refine((resolver) => resolver.mode !== "native" || resolver.path, {
    message: "CHECKMARX_SCA_RESOLVER_PATH is required when CHECKMARX_SCA_RESOLVER=native",
    path: ["path"],
  });

const ConfigSchema = z.object({
  checkmarx: z.object({
    apiKey: z.string().trim().min(1, "CHECKMARX_API_KEY is required"),
    tenant: z.string().trim().min(1, "CHECKMARX_TENANT is required"),
    baseUrl: z
      .string()
      .url("CHECKMARX_BASE_URL must be a valid URL")
      .default("https://ast.checkmarx.net"),
    iamUrl: z
      .string()
      .url("CHECKMARX_IAM_URL must be a valid URL")
      .default("https://iam.checkmarx.net"),
    projectId: z.string().uuid().optional(),
  }),
  scaResolver: ScaResolverSchema,
  transport: TransportSchema,
  port: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ScaResolverConfig = Config["scaResolver"];

export function loadConfig(): Config {
  const raw = {
    checkmarx: {
      apiKey: process.env.CHECKMARX_API_KEY ?? "",
      tenant: process.env.CHECKMARX_TENANT ?? "",
      baseUrl: process.env.CHECKMARX_BASE_URL || undefined,
      iamUrl: process.env.CHECKMARX_IAM_URL || undefined,
      projectId: process.env.CHECKMARX_PROJECT_ID || undefined,
    },
    scaResolver: {
      mode: process.env.CHECKMARX_SCA_RESOLVER || undefined,
      path: process.env.CHECKMARX_SCA_RESOLVER_PATH || undefined,
      version: process.env.CHECKMARX_SCA_RESOLVER_VERSION || undefined,
      image: process.env.CHECKMARX_SCA_RESOLVER_IMAGE || undefined,
      platform: process.env.CHECKMARX_SCA_RESOLVER_PLATFORM || undefined,
      timeoutMs: process.env.CHECKMARX_SCA_RESOLVER_TIMEOUT_MS || undefined,
      sha256: process.env.CHECKMARX_SCA_RESOLVER_SHA256 || undefined,
    },
    transport: process.env.TRANSPORT || undefined,
    port: process.env.PORT || undefined,
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
        return `  - ${path}${issue.message}`;
      })
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return result.data;
}
