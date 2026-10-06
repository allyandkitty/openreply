import { NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";
import { getFacebookAuthorizeUrl } from "@/lib/facebook/graph";
import { getFacebookAppId, getFacebookLoginConfigId } from "@/lib/facebook/config";

// TYE: start "Connect Facebook Page".
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${getBaseUrl()}/login`);
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?facebook=forbidden`);
  }
  const redirectUri = `${getBaseUrl()}/api/facebook/callback`;
  return NextResponse.redirect(
    getFacebookAuthorizeUrl({
      appId: getFacebookAppId(),
      redirectUri,
      state: createOAuthState(context.workspaceId),
      configId: getFacebookLoginConfigId(),
    })
  );
}
