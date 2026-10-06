-- TYE: link a Facebook Page to an Instagram account so campaigns also reply to
-- comments on the Page's cross-posts (Messenger private replies).
ALTER TABLE "InstagramAccount" ADD COLUMN IF NOT EXISTS "facebookPageId" TEXT;
ALTER TABLE "InstagramAccount" ADD COLUMN IF NOT EXISTS "facebookPageName" TEXT;
ALTER TABLE "InstagramAccount" ADD COLUMN IF NOT EXISTS "facebookPageToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "InstagramAccount_facebookPageId_key" ON "InstagramAccount"("facebookPageId");
