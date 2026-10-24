-- connection: claims
-- description: A customer's claims shaped like the MyCover "My claims" grid (same columns and labels)
-- params: customer_id
SELECT c.id AS "Claim",
       c.policy_id AS "Policy",
       c.type AS "Type",
       c.incident_date AS "Incident date",
       printf('%.2f', c.amount_claimed) AS "Amount",
       CASE c.status
         WHEN 'SUBMITTED' THEN 'Submitted'
         WHEN 'IN_REVIEW' THEN 'In review'
         WHEN 'REFERRED' THEN 'Referred'
         WHEN 'APPROVED' THEN 'Approved'
         WHEN 'REJECTED' THEN 'Rejected'
         WHEN 'SETTLEMENT_ACCEPTED' THEN 'Settlement accepted'
         WHEN 'SETTLED' THEN 'Settled'
       END AS "Status"
  FROM claims c
 WHERE c.customer_id = :customer_id
 ORDER BY c.reported_at DESC, c.id DESC
