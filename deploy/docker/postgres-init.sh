#!/bin/sh
set -eu
# psql variable quoting handles password values without constructing SQL in the shell.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv owner_password POSTGRES_OWNER_PASSWORD
\getenv runtime_password POSTGRES_RUNTIME_PASSWORD
CREATE ROLE directory_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER SCHEMA public OWNER TO directory_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE directory_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE directory_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
SQL
