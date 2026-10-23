-- connection: ledger
-- description: Every customer in the ledger, in shop id order
SELECT c.customer_id AS id,
       c.customer_name AS name,
       c.region,
       c.credit_limit
  FROM ezt_ledger_customers c
 ORDER BY c.customer_id
