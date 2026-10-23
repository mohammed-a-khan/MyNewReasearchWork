-- connection: ledger
-- description: Customers onboarded on or after a day (YYYY-MM-DD)
-- params: since
SELECT customer_id, customer_name, onboarded_on
  FROM ezt_ledger_customers
 WHERE onboarded_on >= TO_DATE(:since, 'YYYY-MM-DD')
   AND onboarded_on <= SYSDATE
 ORDER BY customer_id
