import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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
app.use(cors());
// JSONボディ上限を25MBに拡大（base64画像添付対応）
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.use("/api", router);

// JSON形式のグローバルエラーハンドラ（413等のExpressエラーを含む）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { status?: number; statusCode?: number }).statusCode
    ?? 500;

  let message: string;
  if (status === 413 || (err as { type?: string }).type === "entity.too.large") {
    message = "ファイルが大きすぎます。15MB以下の画像を添付してください。";
  } else if (status === 400) {
    message = `リクエストが不正です: ${err.message}`;
  } else {
    message = err.message || "サーバーエラーが発生しました。";
  }

  logger.error({ err, status }, "Unhandled request error");
  res.status(status).json({ error: message });
});

export default app;
