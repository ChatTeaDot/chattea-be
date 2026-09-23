import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module";
import { Logger } from "@nestjs/common";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import passport from "passport";
import { randomUUID } from "crypto";
import { parseTrustedProxy } from "src/common/config/environment";
import { DatadogLogger } from "src/common/logging/datadog-logger";
import { enableApiShutdownHooks } from "src/application-shutdown";

const bootstrap = async () => {
  const app = await NestFactory.create(AppModule, {
    logger: new DatadogLogger(),
    bodyParser: false,
  });
  enableApiShutdownHooks(app);
  const logger = new Logger("Http");

  app.use(
    express.json({
      verify: (req: Request & { rawBody?: Buffer }, _res, buffer) => {
        req.rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", parseTrustedProxy(process.env.TRUST_PROXY) ?? false);
  app.use(cookieParser());
  app.use(passport.initialize());
  app.getHttpAdapter().get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = String(req.headers["x-request-id"] ?? randomUUID());
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      logger.log(
        JSON.stringify({
          event: "http_request",
          requestId,
          deviceId: req.headers["x-device-id"] ?? null,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
    next();
  });

  app.enableCors({
    origin: process.env.CLIENT_URL,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  await app.listen(Number(process.env.PORT ?? 4000));
};

bootstrap();
