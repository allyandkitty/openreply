/**
 * Facebook Page Graph API helpers (TYE addition).
 *
 * Comments on the Facebook Page's cross-posts get the same campaign as the
 * Instagram post, delivered as a Messenger "private reply" with real,
 * tappable link buttons.
 */
import { getMetaGraphApiVersion } from "@/lib/env";

const GRAPH = "https://graph.facebook.com";

export class FacebookApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
    this.name = "FacebookApiError";
  }
}

async function graphRequest<T>(
  path: string,
  token: string,
  init?: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> }
): Promise<T> {
  const url = new URL(`${GRAPH}/${getMetaGraphApiVersion()}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v);
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok || json?.error) {
    throw new FacebookApiError(
      json?.error?.message ?? `Facebook API ${response.status}`,
      response.status,
      json
    );
  }
  return json;
}

export type FbButton =
  | { type: "web_url"; url: string; title: string }
  | { type: "postback"; payload: string; title: string };

type Recipient = { comment_id: string } | { id: string };

function buttonMessage(text: string, buttons: FbButton[]) {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        // Messenger button templates cap text at 640 characters.
        text: text.slice(0, 640),
        buttons: buttons.slice(0, 3).map((b) => ({ ...b, title: b.title.slice(0, 20) })),
      },
    },
  };
}

export async function sendPageMessage({
  pageId,
  pageToken,
  recipient,
  text,
  buttons,
}: {
  pageId: string;
  pageToken: string;
  recipient: Recipient;
  text: string;
  buttons?: FbButton[];
}) {
  const message = buttons && buttons.length ? buttonMessage(text, buttons) : { text: text.slice(0, 2000) };
  return graphRequest<{ recipient_id?: string; message_id?: string }>(`${pageId}/messages`, pageToken, {
    method: "POST",
    body: { recipient, message, messaging_type: "RESPONSE" },
  });
}

export async function replyToComment({ commentId, pageToken, message }: { commentId: string; pageToken: string; message: string }) {
  return graphRequest<{ id: string }>(`${commentId}/comments`, pageToken, {
    method: "POST",
    body: { message },
  });
}

/** Caption of a Page post (or description of a Page video/reel). */
export async function getPagePostText(postId: string, pageToken: string): Promise<string> {
  try {
    const post = await graphRequest<{ message?: string }>(postId, pageToken, { query: { fields: "message" } });
    if (post.message) return post.message;
  } catch {
    // Reels/videos are not "posts" — fall through to the video description.
  }
  try {
    const video = await graphRequest<{ description?: string }>(postId, pageToken, { query: { fields: "description" } });
    return video.description ?? "";
  } catch {
    return "";
  }
}

export async function getInstagramCaption(mediaId: string, instagramToken: string): Promise<string> {
  const url = new URL(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${mediaId}`);
  url.searchParams.set("fields", "caption");
  url.searchParams.set("access_token", instagramToken);
  const response = await fetch(url);
  if (!response.ok) return "";
  const json = (await response.json().catch(() => ({}))) as { caption?: string };
  return json.caption ?? "";
}

/** Cross-posts share their caption. Compare the start of each, ignoring spacing, case and emoji. */
export function captionsMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .slice(0, 80);
  const x = norm(a);
  const y = norm(b);
  if (x.length < 10 || y.length < 10) return false;
  return x.startsWith(y.slice(0, 40)) || y.startsWith(x.slice(0, 40));
}

// ─── OAuth (Facebook Login) ────────────────────────────────────────────────────

export const FACEBOOK_PAGE_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
  "pages_manage_engagement",
  "business_management",
  // TYE: without instagram_basic, me/accounts leaves out instagram_business_account,
  // so no Page can be matched to the Instagram account (facebook=no_match).
  "instagram_basic",
];

export function getFacebookAuthorizeUrl({ appId, redirectUri, state, configId }: { appId: string; redirectUri: string; state: string; configId?: string }) {
  const params = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, response_type: "code" });
  if (configId) params.set("config_id", configId);
  else params.set("scope", FACEBOOK_PAGE_SCOPES.join(","));
  return `https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth?${params.toString()}`;
}

export async function exchangeFacebookCode({ appId, appSecret, redirectUri, code }: { appId: string; appSecret: string; redirectUri: string; code: string }) {
  const url = new URL(`${GRAPH}/${getMetaGraphApiVersion()}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);
  const short = await fetch(url).then((r) => r.json() as Promise<{ access_token?: string; error?: { message?: string } }>);
  if (!short.access_token) throw new Error(short.error?.message ?? "Facebook code exchange failed");
  // Long-lived user token → Page tokens fetched with it do not expire.
  const ll = new URL(`${GRAPH}/${getMetaGraphApiVersion()}/oauth/access_token`);
  ll.searchParams.set("grant_type", "fb_exchange_token");
  ll.searchParams.set("client_id", appId);
  ll.searchParams.set("client_secret", appSecret);
  ll.searchParams.set("fb_exchange_token", short.access_token);
  const long = await fetch(ll).then((r) => r.json() as Promise<{ access_token?: string }>);
  return long.access_token ?? short.access_token;
}

export type FacebookPage = { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } };

export async function listFacebookPages(userToken: string): Promise<FacebookPage[]> {
  const res = await graphRequest<{ data: FacebookPage[] }>("me/accounts", userToken, {
    // TYE: ask for the username too, so the callback can match on it if the IDs differ.
    query: { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100" },
  });
  return res.data ?? [];
}

export async function subscribePageToWebhooks(pageId: string, pageToken: string) {
  return graphRequest<{ success?: boolean }>(`${pageId}/subscribed_apps`, pageToken, {
    method: "POST",
    query: { subscribed_fields: "feed,messages,messaging_postbacks" },
  });
}
