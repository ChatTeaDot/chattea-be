import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { AppModule } from "src/modules/app.module";

describe("App (e2e)", () => {
  let app: INestApplication;

  beforeEach(async () => {
    process.env.KAKAO_CLIENT_ID = "test";
    process.env.KAKAO_CALLBACK_URL = "http://localhost/api/auth/kakao/callback";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("/graphql (POST)", async () => {
    const response = await request(app.getHttpServer()).post("/graphql").send({ query: "{ __typename }" }).expect(200);

    expect(response.body.data).toEqual({ __typename: "Query" });
  });
});
