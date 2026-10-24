-- connection: ledger
-- description: One price-list row as the shop's order-lines table shows it (one unit)
-- params: sku
SELECT p.sku AS "SKU", p.item AS "Item", 1 AS "Qty", p.unit_price AS "Unit Price", p.unit_price AS "Line Total"
  FROM ezt_ledger_products p
 WHERE p.sku = :sku
