-- connection: ledger
-- description: Active customers of a region, one journey run per row (Examples: from query)
-- params: region
SELECT c.customer_id, c.customer_name
  FROM ezt_ledger_customers c
 WHERE c.region = :region
   {{> active_only}}
 ORDER BY c.customer_id
