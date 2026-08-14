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
    process.env.JWT_ACCESS_TOKEN_SECRET = "test-access-secret-at-least-32-bytes";
    process.env.JWT_REFRESH_TOKEN_SECRET = "test-refresh-secret-at-least-32-bytes";

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

  it("requires the upload byte length in the GraphQL schema", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: '{ __type(name: "CreateUploadInput") { inputFields { name type { kind name ofType { kind name } } } } }',
      })
      .expect(200);
    const sizeBytes = response.body.data.__type.inputFields.find(
      (field: { name: string }) => field.name === "sizeBytes",
    );

    expect(sizeBytes.type).toEqual({
      kind: "NON_NULL",
      name: null,
      ofType: { kind: "SCALAR", name: "Int" },
    });

    const paginationResponse = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: '{ __type(name: "ChatMessagesInput") { inputFields { name type { kind name } } } }',
      })
      .expect(200);
    const first = paginationResponse.body.data.__type.inputFields.find(
      (field: { name: string }) => field.name === "first",
    );

    expect(first.type).toEqual({ kind: "SCALAR", name: "Int" });
  });
});
