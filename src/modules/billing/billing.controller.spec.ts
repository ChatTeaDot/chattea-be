import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { createHmac } from "crypto";
import express, { Request } from "express";
import { NotificationService } from "src/modules/notification/notification.service";
import request from "supertest";
import { BillingController } from "./billing.controller";
import { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";

describe("BillingController", () => {
  const secret = "webhook-secret";
  let app: INestApplication;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it("accepts the official RevenueCat signature header and verifies the exact raw JSON body", async () => {
    const timestamp = 1787932800;
    jest.spyOn(Date, "now").mockReturnValue(timestamp * 1000);
    const rawBody = `{
  "event": {"id":"event-1","type":"INITIAL_PURCHASE","event_timestamp_ms":1767225601000,"app_user_id":"5f29b801-2c88-4b0a-97db-f68bbfa03270","product_id":"chattea_basic_monthly","original_transaction_id":"transaction-1"}
}`;
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const applyRevenueCatEvent = jest.fn<BillingRepository["applyRevenueCatEvent"]>().mockResolvedValue({
      outcome: "applied",
      balanceDelta: { boostCredits: 0, superLikeCredits: 0 },
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        BillingService,
        { provide: BillingRepository, useValue: { applyRevenueCatEvent } },
        { provide: NotificationService, useValue: { notify: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => secret } },
      ],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false, logger: false });
    app.use(
      express.json({
        verify: (req: Request & { rawBody?: Buffer }, _res, buffer) => {
          req.rawBody = Buffer.from(buffer);
        },
      }),
    );
    await app.init();

    await request(app.getHttpServer())
      .post("/webhooks/revenuecat")
      .set("Content-Type", "application/json")
      .set("X-RevenueCat-Webhook-Signature", `t=${timestamp},v1=${signature}`)
      .send(rawBody)
      .expect(200, { accepted: true, duplicate: false });
    expect(applyRevenueCatEvent).toHaveBeenCalledTimes(1);
  });

  it("returns 401 for an invalid signature instead of reporting a server failure", async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        BillingService,
        { provide: BillingRepository, useValue: { applyRevenueCatEvent: jest.fn() } },
        { provide: NotificationService, useValue: { notify: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => secret } },
      ],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false, logger: false });
    app.use(
      express.json({
        verify: (req: Request & { rawBody?: Buffer }, _res, buffer) => {
          req.rawBody = Buffer.from(buffer);
        },
      }),
    );
    await app.init();

    await request(app.getHttpServer())
      .post("/webhooks/revenuecat")
      .set("Content-Type", "application/json")
      .set("X-RevenueCat-Webhook-Signature", "invalid")
      .send({ event: {} })
      .expect(401);
  });

  it("returns 400 for a correctly signed malformed event", async () => {
    const timestamp = 1787932800;
    jest.spyOn(Date, "now").mockReturnValue(timestamp * 1000);
    const rawBody = JSON.stringify({ event: { type: 42 } });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const moduleFixture = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        BillingService,
        { provide: BillingRepository, useValue: { applyRevenueCatEvent: jest.fn() } },
        { provide: NotificationService, useValue: { notify: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => secret } },
      ],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false, logger: false });
    app.use(
      express.json({
        verify: (req: Request & { rawBody?: Buffer }, _res, buffer) => {
          req.rawBody = Buffer.from(buffer);
        },
      }),
    );
    await app.init();

    await request(app.getHttpServer())
      .post("/webhooks/revenuecat")
      .set("Content-Type", "application/json")
      .set("X-RevenueCat-Webhook-Signature", `t=${timestamp},v1=${signature}`)
      .send(rawBody)
      .expect(400);
  });
});
