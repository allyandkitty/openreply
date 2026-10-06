import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl, requireEnv } from "@/lib/env";
import { encryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";
import { exchangeFacebookCode, listFacebookPages, subscribePageToWebhooks } from "@/lib/facebook/graph";
import { getFacebookAppId } from "@/lib/facebook/config";

// TYE: finish "Connect Facebook Page". Links each connected Instagram account
// to the Facebook Page it belongs to and subscribes the Page to webhooks.
export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl();
  const code = request.nextUrl.searchParams.get("code");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  if (request.nextUrl.searchParams.get("error")) return NextResponse.redirect(`${baseUrl}/settings?facebook=denied`);
  if (!code || !state) return NextResponse.redirect(`${baseUrl}/settings?facebook=invalid`);

  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=forbidden`);
  }

  try {
    const userToken = await exchangeFacebookCode({
      appId: getFacebookAppId(),
      appSecret: requireEnv("FACEBOOK_APP_SECRET"),
      redirectUri: `${baseUrl}/api/facebook/callback`,
      code,
    });
    const pages = await listFacebookPages(userToken);
    const accounts = await prisma.instagramAccount.findMany({ where: { workspaceId: state.workspaceId } });

    const linked: string[] = [];
    for (const account of accounts) {
      const page = pages.find((p) => p.instagram_business_account?.id === account.instagramId);
      if (!page) continue;
      let subscribed = false;
      try {
        subscribed = Boolean((await subscribePageToWebhooks(page.id, page.access_token)).success);
      } catch (error) {
        await prisma.operationalEvent
          .create({ data: { source: "SYSTEM", level: "WARNING", workspaceId: state.workspaceId, message: "Facebook Page webhook subscription failed", payload: { page: page.name, reason: String(error) } } })
          .catch(() => {});
      }
      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: { facebookPageId: page.id, facebookPageName: page.name, facebookPageToken: encryptToken(page.access_token) },
      });
      linked.push(`${page.name}${subscribed ? "" : " (webhook pending)"}`);
    }

    if (!linked.length) {
      const names = pages.map((p) => p.name).join(", ") || "none";
      return NextResponse.redirect(
        `${baseUrl}/settings?facebook=no_match&pages=${encodeURIComponent(names.slice(0, 200))}`
      );
    }
    return NextResponse.redirect(`${baseUrl}/settings?facebook=connected&pages=${encodeURIComponent(linked.join(", "))}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.operationalEvent
      .create({ data: { source: "SYSTEM", level: "ERROR", workspaceId: state.workspaceId, message: "Facebook Page connection failed", payload: { reason: message } } })
      .catch(() => {});
    return NextResponse.redirect(`${baseUrl}/settings?facebook=failed&reason=${encodeURIComponent(message.slice(0, 200))}`);
  }
}
