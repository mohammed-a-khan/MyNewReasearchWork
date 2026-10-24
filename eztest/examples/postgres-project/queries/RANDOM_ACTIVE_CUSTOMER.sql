-- connection: ledger
-- description: Any one active customer (test data picked at run time)
SELECT c.customer_id, c.customer_name, c.region
  FROM ezt_ledger_customers c
 WHERE 1 = 1
   {{> active_only}}
 ORDER BY random()
 LIMIT 1
