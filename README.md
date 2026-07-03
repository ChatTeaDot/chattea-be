<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="200" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://coveralls.io/github/nestjs/nest?branch=master" target="_blank"><img src="https://coveralls.io/repos/github/nestjs/nest/badge.svg?branch=master#9" alt="Coverage" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Installation

```bash
$ npm install
```

## Migrations

Start local Postgres with Docker:

```bash
$ pnpm db:up
```

Run database migrations during deploy, before starting the new app version. CI/CD or the release operator should run this once per deploy:

```bash
$ pnpm migrate
```

The runner applies `migrations/*.sql` in filename order and records checksums in `_migrations`. If an applied SQL file changes, deploy fails instead of re-running it.

Set `POSTGRES_SSL=true` for managed Postgres providers that require SSL.

### Migration Rehearsal

Use staging or a production snapshot before the production deploy:

```bash
$ POSTGRES_DATABASE=staging_db pnpm migrate
$ psql "$DATABASE_URL" -c 'select "name", "appliedAt" from "_migrations" order by "name";'
$ npm run start:prod
```

Rollback plan: restore the DB snapshot or managed-provider point-in-time backup. Do not edit an already-applied SQL file; add a new migration instead.

## SMS Provider

Set `SMS_PROVIDER_URL` to enable the HTTP SMS sender. In production, `SMS_PROVIDER_AUTHORIZATION` is required.

The default HTTP payload is generic:

```json
{ "to": "+821012345678", "text": "[Demo] 인증번호는 123456입니다.", "senderId": "sender" }
```

Match this payload and headers to the actual provider before production.

## Datadog Logs

The app writes JSON logs to stdout/stderr with Datadog-friendly fields:

```bash
DD_SERVICE=demo-backend
DD_ENV=production
DD_VERSION=<git-sha-or-release>
```

Configure the Datadog Agent or platform log drain to collect container stdout/stderr. No app-side Datadog API key is needed for log collection.

## Running the app

```bash
# local DB
$ pnpm db:up
$ pnpm migrate

# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

`src/modules/auth/auth-flows.spec.ts` is service-flow coverage for phone signup, signin/refresh/logout, and Kakao phone signup. It is not HTTP e2e; it does not verify GraphQL resolver wiring, cookies, guards, or CORS.

`test/auth-flows.e2e-spec.ts` is HTTP e2e coverage for GraphQL auth flows, cookies, refresh guard wiring, Kakao OAuth state rejection, and CORS headers.

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://kamilmysliwiec.com)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](LICENSE).
