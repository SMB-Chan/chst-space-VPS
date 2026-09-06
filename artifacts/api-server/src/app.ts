import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getAllowedClerkHost,
  getConfiguredClerkHosts,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import healthRouter from "./routes/health";
import { logger } from "./lib/logger";
import {
  createSafeHttpAccessFields,
  createSafeHttpLogFields,
  httpLogLevel,
  logSafeHttpError,
  SAFE_HTTP_ACCESS_MESSAGE,
  SAFE_HTTP_ERROR_MESSAGE,
} from "./lib/http-error-observability";
import {
  DEFAULT_JSON_LIMIT,
  LARGE_JSON_LIMIT,
  LARGE_JSON_PATHS,
} from "./lib/json-limits";
import { publicHttpError } from "./lib/public-error";
import { apiSecurityHeaders } from "./middlewares/apiSecurityHeaders";
import { chatRunTrackingMiddleware } from "./middlewares/chatRunTrackingMiddleware";
import { requireAuth } from "./middlewares/requireAuth";
import { sharedAiUsageGuard } from "./middlewares/sharedAiUsageGuard";
import {
  TOKEN_PLAN_QUOTA_RESPONSE_HEADERS,
  tokenPlanQuotaPreflightGuard,
  tokenPlanQuotaStatusHeaders,
} from "./middlewares/tokenPlanQuotaPreflightGuard";
import { isAllowedCorsOrigin, parseAllowedOrigins } from "./lib/cors-origins";
import { requireStartupReadiness } from "./lib/startup-readiness";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: "requestId" },
    customLogLevel: (_req, res, error) => httpLogLevel(res.statusCode, error),
    customSuccessObject: (req, res) =>
      createSafeHttpAccessFields(req, res.statusCode),
    customErrorObject: (req, res, error) => {
      const { requestId: _requestId, ...fields } = createSafeHttpLogFields(
        req,
        res.statusCode,
        error,
      );
      return fields;
    },
    customSuccessMessage: () => SAFE_HTTP_ACCESS_MESSAGE,
    customErrorMessage: () => SAFE_HTTP_ERROR_MESSAGE,
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_URL);
const allowAnyDevelopmentOrigin =
  allowedOrigins.size === 0 && process.env.NODE_ENV !== "production";

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      // In production, an omitted FRONTEND_URL now fails closed for
      // cross-origin browser requests. Local development remains permissive.
      callback(
        null,
        isAllowedCorsOrigin(origin, allowedOrigins, allowAnyDevelopmentOrigin),
      );
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: [
      ...Object.values(TOKEN_PLAN_QUOTA_RESPONSE_HEADERS),
      "X-Chat-Space-Token-Plan-Remaining",
      "X-Chat-Space-Token-Plan-Window",
      "Retry-After",
    ],
  }),
);

// Apply conservative document/cache defaults to API responses only. Clerk's
// own reverse-proxy path above is intentionally not modified by this policy.
app.use("/api", apiSecurityHeaders);

// Health checks are mounted before Clerk so deployment probes never depend on auth.
app.use("/api", healthRouter);
// Keep the port reachable while startup migrations run, but do not allow
// application requests through until the schema initialization has completed.
app.use("/api", requireStartupReadiness);

const configuredClerkHosts = getConfiguredClerkHosts();

// Dynamic production publishable keys are only derived from a configured host
// allowlist. If no request host matches, fall back to the configured key rather
// than turning an arbitrary forwarded Host value into a new Clerk key.
app.use(
  clerkMiddleware((req) => {
    const fallbackKey = process.env.CLERK_PUBLISHABLE_KEY;
    const allowedHost = getAllowedClerkHost(req, configuredClerkHosts);
    return {
      publishableKey: allowedHost
        ? publishableKeyFromHost(allowedHost, fallbackKey)
        : fallbackKey,
    };
  }),
);

// Reuse the authenticated model-list request as a lightweight quota status
// surface. No new API contract is introduced: safe quota values are response
// headers and the route body remains the existing model catalog.
app.get("/api/openai/models", requireAuth, tokenPlanQuotaStatusHeaders);

// Realtime session issuance creates short-lived provider credentials. It does
// not use the large attachment parser, but it must share the same authenticated
// request budget as chat and media generation to prevent token-minting abuse.
app.post("/api/openai/realtime/session", requireAuth, sharedAiUsageGuard);

// Attachment requests may carry base64 image data. Authenticate and acquire
// the shared per-user AI budget before the expensive 30MB parser so anonymous
// or over-limit clients cannot force large allocations first. Once the bounded
// body is available, perform the Token Plan large-turn quota preflight before
// route-level web/vision/audit/file-generation work starts.
app.post(
  [...LARGE_JSON_PATHS],
  requireAuth,
  sharedAiUsageGuard,
  express.json({ limit: LARGE_JSON_LIMIT }),
  express.urlencoded({ extended: true, limit: LARGE_JSON_LIMIT }),
  tokenPlanQuotaPreflightGuard,
);
app.use(express.json({ limit: DEFAULT_JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: DEFAULT_JSON_LIMIT }));

// A chat is now one durable AI Run. This middleware is intentionally mounted
// after body parsing and existing quota/auth gates, while the route and SSE
// payload remain unchanged. Downstream stages inherit the Run through
// AsyncLocalStorage and can opt into executeRunStep() incrementally.
app.post(
  "/api/openai/conversations/:conversationId/messages",
  chatRunTrackingMiddleware,
);
app.post("/api/openai/ephemeral/messages", chatRunTrackingMiddleware);

app.use("/api", router);

// Explicit 404 for unknown API paths so deployment health checks and missing
// routes return JSON instead of Express' default HTML response.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// JSON形式のグローバルエラーハンドラ（413等のExpressエラーを含む）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(
  (
    err: Error & { status?: number; statusCode?: number; type?: string },
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const { status, message } = publicHttpError(err);
    logSafeHttpError(req, status, err);
    res.status(status).json({ error: message });
  },
);

export default app;
