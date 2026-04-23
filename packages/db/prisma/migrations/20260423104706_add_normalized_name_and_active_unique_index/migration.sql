ALTER TABLE "Project"
ADD COLUMN "normalizedName" TEXT;

UPDATE "Project"
SET "normalizedName" = lower(
  regexp_replace(
    btrim("name"),
    '[[:space:]]+',
    ' ',
    'g'
  )
);

ALTER TABLE "Project"
ALTER COLUMN "normalizedName" SET NOT NULL;

CREATE UNIQUE INDEX "Project_ownerId_normalizedName_active_key"
ON "Project" ("ownerId", "normalizedName")
WHERE "deletedAt" IS NULL;