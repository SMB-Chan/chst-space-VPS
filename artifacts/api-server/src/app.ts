import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import healthRouter from "./routes/health";
import { logger } from "./lib/logger";
import { DEFAULT_JSON_LIMIT, LARGE_JSON_LIMIT, LARGE_JSON_PATHS } from "./lib/json-limits";
import { publicHttpError } from "./lib/public-error";
import { apiSecurityHeaders } from "./middlewares/apiSecurityHeaders";
import { requireAuth } from "./middlewares/requireAuth";
import { sharedAiUsageGuard } from "./middlewares/sharedAiUsageGuard";
import { isAllowedCorsOrigin, parseAllowedOrigins } from "./lib/cors-origins";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
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
      callback(null, isAllowedCorsOrigin(origin, allowedOrigins, allowAnyDevelopmentOrigin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);

// Apply conservative document/cache defaults to API responses only. Clerk's
// own reverse-proxy path above is intentionally not modified by this policy.
app.use("/api", apiSecurityHeaders);

// Health checks are mounted before Clerk so deployment probes never depend on auth.
app.use("/api", healthRouter);

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Attachment requests may carry base64 image data. Authenticate and acquire
// the shared per-user AI budget before the expensive 30MB parser so anonymous
// or over-limit clients cannot force large allocations first.
app.post(
  [...LARGE_JSON_PATHS],
  requireAuth,
  sharedAiUsageGuard,
  express.json({ limit: LARGE_JSON_LIMIT }),
  express.urlencoded({ extended: true, limit: LARGE_JSON_LIMIT }),
);
app.use(express.json({ limit: DEFAULT_JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: DEFAULT_JSON_LIMIT }));

app.use("/api", router);

// Explicit 404 for unknown API paths so deployment health checks and missing
// routes return JSON instead of Express' default HTML response.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// JSON形式のグローバルエラーハンドラ（413等のExpressエラーを含む）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const { status, message } = publicHttpError(err);
  logger.error({ err, status }, "Unhandled request error");
  res.status(status).json({ error: message });
});

export default app;