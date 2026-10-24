-- connection: claims
-- description: The documents uploaded with a claim, oldest first
-- params: claim_id
SELECT filename, content_type, size, sha256
  FROM claim_documents
 WHERE claim_id = :claim_id
 ORDER BY id
