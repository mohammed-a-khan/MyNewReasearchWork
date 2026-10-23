-- connection: ledger
-- description: Active customers of a region at or above a credit limit
-- params: region, min_limit:number = 0
SELECT c.customer_id, c.customer_name, c.credit_limit
  FROM ezt_ledger_customers c
 WHERE c.region = :region
   AND c.credit_limit >= :min_limit
   {{> active_only}}
 ORDER BY c.customer_id
