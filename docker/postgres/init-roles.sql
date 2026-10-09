-- Executed once by the official postgres image on first boot (docker-entrypoint-initdb.d).
-- Two roles with different privileges:
--   wagering_migrator: owns the schema, runs DDL (migrations only)
--   wagering_app:      runtime role, DML only; UPDATE/DELETE on append-only tables is revoked by migrations
-- Passwords here are local development defaults, overridden via env in any real environment.
CREATE ROLE wagering_migrator WITH LOGIN PASSWORD 'migrator_dev_password';
CREATE ROLE wagering_app WITH LOGIN PASSWORD 'app_dev_password';

CREATE DATABASE wagering OWNER wagering_migrator;
REVOKE ALL ON DATABASE wagering FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE wagering TO wagering_app;

-- Test suites clone isolated databases from a migrated template, so the migrator may create databases.
ALTER ROLE wagering_migrator CREATEDB;

\connect wagering
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO wagering_migrator;
GRANT USAGE ON SCHEMA public TO wagering_app;
