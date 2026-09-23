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

  it("rejects documents that fan out into excessive resolver work", async () => {
    const fields = Array.from({ length: 201 }, (_, index) => `field${index}: __typename`).join(" ");
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `{ ${fields} }` })
      .expect(400);

    expect(response.body.errors).toEqual([
      expect.objectContaining({ message: "GRAPHQL_DOCUMENT_FIELD_LIMIT_EXCEEDED" }),
    ]);
  });

  it("enforces GraphQL schema contracts", async () => {
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

    const queryType = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: '{ __type(name: "Query") { fields { name } } }' })
      .expect(200);
    expect(queryType.body.data.__type.fields.map((field: { name: string }) => field.name)).not.toContain("signed");
  });

  it("does not expose retired authentication, email, matching, or community roots", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query:
          '{ query: __type(name: "Query") { fields { name } } mutation: __type(name: "Mutation") { fields { name } } }',
      })
      .expect(200);
    const queryFields = response.body.data.query.fields.map((field: { name: string }) => field.name);
    const mutationFields = response.body.data.mutation.fields.map((field: { name: string }) => field.name);

    for (const retiredField of ["blackMatchCandidates", "communityProfile"]) {
      expect(queryFields).not.toContain(retiredField);
    }
    for (const retiredField of ["signup", "signin", "updateEmail", "updateCommunityProfile"]) {
      expect(mutationFields).not.toContain(retiredField);
    }
  });
});
