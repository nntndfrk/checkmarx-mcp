import { z } from "zod";

const TransportSchema = z.enum(["stdio", "http"]).default("stdio");

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
  transport: TransportSchema,
  port: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const raw = {
    checkmarx: {
      apiKey: process.env.CHECKMARX_API_KEY ?? "",
      tenant: process.env.CHECKMARX_TENANT ?? "",
      baseUrl: process.env.CHECKMARX_BASE_URL || undefined,
      iamUrl: process.env.CHECKMARX_IAM_URL || undefined,
      projectId: process.env.CHECKMARX_PROJECT_ID || undefined,
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
