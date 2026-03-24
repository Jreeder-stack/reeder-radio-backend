#!/bin/bash
set -euo pipefail

DB_NAME="${1:-command_comms}"
DB_USER="${2:-command_comms}"

if [[ ! "$DB_NAME" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "ERROR: Invalid database name. Use only letters, numbers, and underscores."
  exit 1
fi
if [[ ! "$DB_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "ERROR: Invalid username. Use only letters, numbers, and underscores."
  exit 1
fi

echo "=== PostgreSQL Database Initialization ==="
echo "Database: $DB_NAME"
echo "User:     $DB_USER"
echo ""

read -sp "Enter password for database user '$DB_USER': " DB_PASS
echo ""

if [ -z "$DB_PASS" ]; then
  echo "ERROR: Password cannot be empty."
  exit 1
fi

ESCAPED_PASS=$(printf '%s' "$DB_PASS" | sed "s/'/''/g")

sudo -u postgres psql <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${ESCAPED_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${ESCAPED_PASS}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
\c ${DB_NAME}
GRANT ALL ON SCHEMA public TO ${DB_USER};
EOF

echo ""
echo "Database '$DB_NAME' ready with user '$DB_USER'."
echo ""
echo "Your DATABASE_URL is:"
echo "  postgresql://${DB_USER}:<password>@localhost:5432/${DB_NAME}"
echo ""
echo "Add this to your .env file. The app will create all tables on first start."
