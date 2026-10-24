-- Fictional customer ledger for the EZ Shop demo (examples/demo-app), on PostgreSQL.
--   psql postgres://eztest:EzPg_Pass1@localhost:5432/eztest -f examples/postgres-project/setup.sql
DROP TABLE IF EXISTS ezt_ledger_customers;
CREATE TABLE ezt_ledger_customers (
  customer_id   integer       PRIMARY KEY,
  customer_name varchar(80)   NOT NULL,
  region        varchar(8)    NOT NULL,
  credit_limit  numeric(12,2) NOT NULL,
  status        varchar(10)   NOT NULL DEFAULT 'ACTIVE',
  onboarded_on  date          NOT NULL,
  notes         text
);
INSERT INTO ezt_ledger_customers VALUES (1, 'Contoso Ltd', 'EU', 25000, 'ACTIVE', DATE '2024-01-15', 'Key account');
INSERT INTO ezt_ledger_customers VALUES (2, 'Fabrikam Inc', 'US', 5000, 'ACTIVE', DATE '2024-06-01', NULL);
INSERT INTO ezt_ledger_customers VALUES (3, 'Northwind Traders', 'EU', 12000, 'ACTIVE', DATE '2025-02-20', NULL);
DROP TABLE IF EXISTS ezt_ledger_products;
CREATE TABLE ezt_ledger_products (
  sku        varchar(12)   PRIMARY KEY,
  item       varchar(40)   NOT NULL,
  unit_price numeric(10,2) NOT NULL
);
INSERT INTO ezt_ledger_products VALUES ('SKU-100', 'Widget', 19.99), ('SKU-200', 'Gadget', 49.50), ('SKU-300', 'Doohickey', 5.25);
