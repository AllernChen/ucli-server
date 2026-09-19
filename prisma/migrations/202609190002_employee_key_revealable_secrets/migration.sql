ALTER TABLE "employee_api_keys"
  ADD COLUMN "secret_ciphertext" TEXT,
  ADD COLUMN "secret_iv" TEXT,
  ADD COLUMN "secret_tag" TEXT;
