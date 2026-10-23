-- connection: ledger
-- description: A customer's name by shop id
-- params: id:number
SELECT customer_name FROM ezt_ledger_customers WHERE customer_id = :id
