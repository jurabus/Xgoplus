#!/bin/bash
# Starts a local Supabase-like stack: Postgres (5433) + real GoTrue (9999)
# + real PostgREST (3000) + gateway with storage stand-in (54321).
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${XG_BIN:-/home/claude/e2e/bin}
export JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long
P="psql -h /tmp -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
pkill -f "$BIN/auth" 2>/dev/null || true; pkill -f "$BIN/postgrest" 2>/dev/null || true; pkill -f gateway.py 2>/dev/null || true
sleep 0.5
$P -c "drop database if exists xg_e2e" -c "create database xg_e2e"
$P -d xg_e2e <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'auth'; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin login superuser; end if;
  alter role supabase_auth_admin set search_path = auth;
end $$;
SQL
$P -d xg_e2e -f "$ROOT/tests/e2e/stub_no_auth.sql"
$P -d xg_e2e -c "grant anon, authenticated, service_role to authenticator; create schema if not exists auth;"
# GoTrue migrates the auth schema itself
( cd "$BIN" && \
  GOTRUE_DB_DRIVER=postgres DATABASE_URL="postgres://supabase_auth_admin@localhost:5433/xg_e2e?sslmode=disable&host=/tmp" \
  GOTRUE_DB_NAMESPACE=auth GOTRUE_DB_MIGRATIONS_PATH="$BIN/migrations" \
  GOTRUE_SITE_URL=http://localhost:8080 API_EXTERNAL_URL=http://localhost:54321/auth/v1 \
  GOTRUE_API_HOST=127.0.0.1 PORT=9999 \
  GOTRUE_JWT_SECRET=$JWT_SECRET GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated \
  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role \
  GOTRUE_MAILER_AUTOCONFIRM=true GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_DISABLE_SIGNUP=false \
  GOTRUE_EXTERNAL_PHONE_ENABLED=false GOTRUE_RATE_LIMIT_HEADER="" GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000 \
  GOTRUE_RATE_LIMIT_VERIFY=10000 GOTRUE_RATE_LIMIT_EMAIL_SENT=10000 GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=false \
  GOTRUE_LOG_LEVEL=warn setsid nohup "$BIN/auth" < /dev/null > /home/claude/e2e/auth.log 2>&1 & )
for i in $(seq 1 60); do curl -sf http://127.0.0.1:9999/health >/dev/null && break; sleep 0.5; done
curl -sf http://127.0.0.1:9999/health >/dev/null || { tail -20 /home/claude/e2e/auth.log; exit 1; }
for f in "$ROOT/supabase/schema.sql" "$ROOT"/supabase/migrations/0*.sql; do $P -d xg_e2e -f "$f"; done
( PGRST_DB_URI="postgres://authenticator:auth@localhost:5433/xg_e2e?host=/tmp" PGRST_DB_SCHEMAS=public \
  PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET=$JWT_SECRET PGRST_SERVER_PORT=3000 PGRST_SERVER_HOST=127.0.0.1 \
  PGRST_LOG_LEVEL=warn setsid nohup "$BIN/postgrest" < /dev/null > /home/claude/e2e/pgrst.log 2>&1 & )
( cd "$ROOT/tests/e2e" && setsid nohup python3 -I gateway.py < /dev/null > /home/claude/e2e/gateway.log 2>&1 & )
for i in $(seq 1 40); do curl -sf http://127.0.0.1:54321/rest/v1/ -H "apikey: x" >/dev/null 2>&1 && break; sleep 0.5; done
echo "stack up"
