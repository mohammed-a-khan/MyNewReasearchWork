-- connection: claims
-- description: The payments of one settlement batch, shaped like the bank file the batch drops
-- params: batch_id
SELECT p.id AS payment_id,
       p.claim_id,
       c.policy_id,
       c.customer_id,
       cu.full_name AS payee_name,
       substr(p.iban, 1, 4) || substr('******************', 1, length(p.iban) - 8) || substr(p.iban, -4) AS iban_masked,
       printf('%.2f', p.amount) AS amount,
       'GBP' AS currency,
       p.business_date
  FROM payments p
  JOIN claims c ON c.id = p.claim_id
  JOIN customers cu ON cu.id = c.customer_id
 WHERE p.batch_id = :batch_id
 ORDER BY p.claim_id
