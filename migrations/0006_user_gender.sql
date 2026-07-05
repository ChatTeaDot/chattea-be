ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" varchar(20);

UPDATE "users"
SET "gender" = CASE
  WHEN "gender" IN ('female', '여자', '여성') THEN 'female'
  WHEN "gender" IN ('male', '남자', '남성') THEN 'male'
  ELSE 'male'
END;

ALTER TABLE "users" ALTER COLUMN "gender" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "gender" SET DEFAULT 'male';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_gender_check' AND conrelid = '"users"'::regclass
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT users_gender_check CHECK ("gender" IN ('male', 'female'));
  END IF;
END
$$;
