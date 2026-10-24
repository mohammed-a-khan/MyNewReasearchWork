-- connection: shop
-- description: Customers of a region, largest credit limit first
-- params: region
SELECT id, name, credit_limit
  FROM customers
 WHERE region = :region
 ORDER BY credit_limit DESC
