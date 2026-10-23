-- Fictional customer ledger for the EZ Shop demo (examples/demo-app).
-- Statements are separated by a line holding only "/". Run as the app user, e.g.:
--   docker exec -i ez-oracle sqlplus -s eztest/EzTest_1@FREEPDB1 < examples/oracle-project/setup.sql
BEGIN
  EXECUTE IMMEDIATE 'DROP TABLE ezt_ledger_customers PURGE';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF;
END;
/
CREATE TABLE ezt_ledger_customers (
  customer_id   NUMBER(10)   PRIMARY KEY,
  customer_name VARCHAR2(80) NOT NULL,
  region        VARCHAR2(8)  NOT NULL,
  credit_limit  NUMBER(12,2) NOT NULL,
  status        VARCHAR2(10) DEFAULT 'ACTIVE' NOT NULL,
  onboarded_on  DATE         NOT NULL,
  notes         CLOB
)
/
INSERT INTO ezt_ledger_customers VALUES (1, 'Contoso Ltd', 'EU', 25000, 'ACTIVE', DATE '2024-01-15', 'Key account')
/
INSERT INTO ezt_ledger_customers VALUES (2, 'Fabrikam Inc', 'US', 5000, 'ACTIVE', DATE '2024-06-01', NULL)
/
INSERT INTO ezt_ledger_customers VALUES (3, 'Northwind Traders', 'EU', 12000, 'ACTIVE', DATE '2025-02-20', NULL)
/
COMMIT
/
