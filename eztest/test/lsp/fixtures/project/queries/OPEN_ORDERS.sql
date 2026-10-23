-- connection: shop
-- description: Open orders of a customer
-- params: customer:number
SELECT id, total FROM orders WHERE customer_id = :customer AND status = 'Submitted'
