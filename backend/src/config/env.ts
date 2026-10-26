import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('civickey-api'),
  JWT_AUDIENCE: z.string().default('civickey-app'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  /**
   * Keyed into the government-ID hash. Without it the API refuses full ID numbers and keeps only
   * the type and last 4 digits, since an unsalted hash of a 12-digit number is guessable.
   */
  ID_HASH_PEPPER: z.string().min(32, 'ID_HASH_PEPPER must be at least 32 characters').optional(),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  /** Failed credential attempts for one phone before it is locked for the window */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  /** Auth requests allowed from one IP in the window, counting malformed ones */
  LOGIN_RATE_LIMIT_IP_MAX: z.coerce.number().int().positive().default(30),
  /** Brevo transactional email. Unset means email is skipped rather than failed. */
  BREVO_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM_NAME: z.string().min(1).default('CivicKey'),
  EMAIL_FROM_ADDRESS: z.string().email().default('no-reply@civickey.local'),
  /** Web Push. Both unset means push is skipped; generate a pair with `npx web-push generate-vapid-keys`. */
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  /** How often the dispatcher and the scheduled jobs look for work. Zero switches them off. */
  DISPATCHER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(5),
  JOB_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(15),
  /** Keys the throttle buckets, so the table holds no phone numbers or addresses */
  AUTH_RATE_KEY: z.string().min(16).default('dev-only-auth-rate-key-change-me'),
  /**
   * Razorpay hosted checkout. Test credentials in development; live ones belong in the
   * deployment's secrets. With the key pair unset, checkout answers 503 and only cash works.
   * Without the webhook secret no webhook is ever trusted, so no payment can settle online.
   */
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Where uploaded photos are written. Private by design: nothing serves this directory. */
  FILE_STORAGE_DIR: z.string().min(1).default(fileURLToPath(new URL('../../var/uploads', import.meta.url))),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`)
  }
  return result.data
}

export const env = loadEnv()
export const isProduction = env.NODE_ENV === 'production'
