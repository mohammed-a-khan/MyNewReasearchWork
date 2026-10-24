-- connection: ledger
-- description: Customers onboarded on or after a day (YYYY-MM-DD)
-- params: since
SELECT customer_id, customer_name, onboarded_on
  FROM ezt_ledger_customers
 WHERE onboarded_on >= :since::date
   AND onboarded_on <= CURRENT_DATE
 ORDER BY customer_id
