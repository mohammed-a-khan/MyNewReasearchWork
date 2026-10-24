-- connection: claims
-- description: A sample of active policies of direct customers in a region (home and motor), with what the rating engine needs
-- params: region, per_product:number = 4
SELECT * FROM (
  SELECT p.id AS policy_id, p.product, p.sum_insured, p.region, c.date_of_birth
    FROM policies p JOIN customers c ON c.id = p.customer_id
   WHERE p.region = :region AND p.status = 'ACTIVE' AND c.segment = 'DIRECT' AND p.product = 'HOME'
   ORDER BY p.id LIMIT :per_product
)
UNION ALL
SELECT * FROM (
  SELECT p.id AS policy_id, p.product, p.sum_insured, p.region, c.date_of_birth
    FROM policies p JOIN customers c ON c.id = p.customer_id
   WHERE p.region = :region AND p.status = 'ACTIVE' AND c.segment = 'DIRECT' AND p.product = 'MOTOR'
   ORDER BY p.id LIMIT :per_product
)
