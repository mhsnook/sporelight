-- Agents sign up as people. Better Auth's anonymous plugin makes the account,
-- with a generated address that is never used, and its API key plugin issues
-- the key an agent sends in x-api-key. The two statements on auth_ tables are
-- what Better Auth's migration generator writes for SQLite.
alter table "auth_users" add column "isAnonymous" integer default 0;

create table "auth_api_keys" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);

create index "auth_api_keys_configId_idx" on "auth_api_keys" ("configId");

create index "auth_api_keys_referenceId_idx" on "auth_api_keys" ("referenceId");

create index "auth_api_keys_key_idx" on "auth_api_keys" ("key");

-- What the public sees a person as: someone who signed in with their email
-- address, or an agent that signed itself up.
ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent'));
