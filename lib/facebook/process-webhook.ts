/**
 * Facebook Page webhooks (TYE addition).
 *
 * - feed / comment add  → find the matching OpenReply campaign and send one
 *   Messenger private reply (+ optional public reply under the comment).
 * - messaging postback  → the commenter tapped the opening-DM button: send the
 *   link message with tappable link buttons.
 *
 * Campaigns are shared with Instagram: an any-post campaign fires on every
 * Page post; a single-post campaign fires on the Page post whose caption
 * matches the Instagram post's caption (cross-posts share captions).
 */
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { buildTrackedUrl, renderMessageWithoutLink, renderMessageWithTracking } from "@/lib/tracking/message";
import { hashRecipientId } from "@/lib/tracking/server";
import {
  captionsMatch,
  getInstagramCaption,
  getPagePostText,
  replyToComment,
  sendPageMessage,
  type FbButton,
} from "@/lib/facebook/graph";

type FeedValue = {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  message?: string;
  from?: { id?: string; name?: string };
};
type PageEntry = {
  id: string;
  changes?: { field?: string; value?: FeedValue }[];
  messaging?: { sender?: { id?: string }; postback?: { payload?: string; title?: string } }[];
};
export type PageWebhookPayload = { object?: string; entry?: PageEntry[] };

const REVEAL_PREFIX = "fbreveal:";

async function loadAccount(pageId: string) {
  return prisma.instagramAccount.findUnique({ where: { facebookPageId: pageId } });
}

async function loadAutomations(instagramAccountId: string) {
  return prisma.automation.findMany({
    where: { instagramAccountId, isActive: true },
    include: { trackedLinks: { select: { slug: true, label: true, destinationUrl: true }, orderBy: TRACKED_LINK_ORDER } },
    orderBy: { createdAt: "asc" },
  });
}
type LoadedAutomation = Awaited<ReturnType<typeof loadAutomations>>[number];

function linkButtons(automation: LoadedAutomation, recipientToken: string): FbButton[] {
  return automation.trackedLinks.slice(0, 3).map((link, index) => ({
    type: "web_url" as const,
    url: buildTrackedUrl(link.slug, undefined, recipientToken),
    title: (index === 0 ? automation.linkButtonLabel : link.label) || link.label || "Open link",
  }));
}

/**
 * The link message. TYE: matches Instagram — wording without the raw tracking
 * URL, link behind the button only. The inline-link text is used only if Meta
 * rejects the button message.
 */
async function sendReveal({
  pageId,
  pageToken,
  recipient,
  automation,
  commenterName,
}: {
  pageId: string;
  pageToken: string;
  recipient: { comment_id: string } | { id: string };
  automation: LoadedAutomation;
  commenterName?: string | null;
}) {
  const recipientKey = "comment_id" in recipient ? recipient.comment_id : recipient.id;
  const token = hashRecipientId(`fb:${recipientKey}`);
  const buttons = linkButtons(automation, token);
  const withLink = renderMessageWithTracking({
    message: automation.dmMessage,
    commenterName,
    trackedLinks: automation.trackedLinks,
    recipientToken: token,
  });
  // TYE: button text without the raw link, same as the Instagram worker.
  const buttonText =
    renderMessageWithoutLink({ message: automation.dmMessage, commenterName }) ||
    "Here's your link:";
  if (buttons.length && buttonText.length <= 640) {
    try {
      return await sendPageMessage({ pageId, pageToken, recipient, text: buttonText, buttons });
    } catch (buttonError) {
      // Fall back to plain text below (links in Messenger text are still tappable).
      // TYE: log why, so a raw-link DM can be traced in the Vercel logs.
      console.warn("[facebook] button DM rejected, sending text with link instead:", buttonError);
    }
  }
  const text = buttons.length
    ? withLink
    : renderMessageWithoutLink({ message: automation.dmMessage, commenterName });
  return sendPageMessage({ pageId, pageToken, recipient, text });
}

async function pickAutomation({
  automations,
  commentText,
  postId,
  pageToken,
  instagramToken,
}: {
  automations: LoadedAutomation[];
  commentText: string;
  postId: string;
  pageToken: string;
  instagramToken: string | null;
}): Promise<{ automation: LoadedAutomation; keyword: string | null } | null> {
  const keywordHits = automations
    .map((automation) => {
      const match = automation.matchAnyWord
        ? { matched: true, matchedKeyword: null }
        : matchKeywords(commentText, automation.keywords, automation.wholeWordMatch);
      return match.matched ? { automation, keyword: match.matchedKeyword } : null;
    })
    .filter((x): x is { automation: LoadedAutomation; keyword: string | null } => Boolean(x));
  if (!keywordHits.length) return null;

  // Prefer a campaign bound to this exact post (caption match) over any-post ones.
  const specific = keywordHits.filter((h) => h.automation.postId && !h.automation.matchAnyPost);
  if (specific.length && instagramToken) {
    const pageText = await getPagePostText(postId, pageToken);
    if (pageText) {
      for (const hit of specific) {
        const caption = await getInstagramCaption(hit.automation.postId!, instagramToken);
        if (caption && captionsMatch(caption, pageText)) return hit;
      }
    }
  }
  return keywordHits.find((h) => h.automation.matchAnyPost) ?? null;
}

async function handleComment(pageId: string, value: FeedValue) {
  if (value.item !== "comment" || value.verb !== "add") return;
  const commentId = value.comment_id;
  const postId = value.post_id;
  const fromId = value.from?.id;
  const text = value.message ?? "";
  if (!commentId || !postId || !fromId || !text) return;
  if (fromId === pageId) return; // never reply to the Page's own comments

  const account = await loadAccount(pageId);
  if (!account?.facebookPageToken) return;
  const pageToken = decryptToken(account.facebookPageToken);
  let instagramToken: string | null = null;
  try {
    instagramToken = account.provider === "META" ? decryptToken(account.accessToken) : null;
  } catch {
    instagramToken = null;
  }

  const automations = await loadAutomations(account.id);
  const hit = await pickAutomation({ automations, commentText: text, postId, pageToken, instagramToken });
  if (!hit) return;
  const { automation, keyword } = hit;
  const logCommentId = `fb_${commentId}`;

  // Dedupe: Meta retries webhooks; only the first delivery creates the log.
  try {
    await prisma.dmLog.create({
      data: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: account.id,
        commenterId: `fb_${fromId}`,
        commenterName: value.from?.name ? `${value.from.name} (Facebook)` : "Facebook user",
        commentText: text,
        commentId: logCommentId,
        matchedKeyword: keyword,
        status: "PENDING",
      },
    });
  } catch {
    return;
  }

  const firstName = value.from?.name?.split(" ")[0] ?? null;
  let errorMessage: string | null = null;
  try {
    if (automation.openingDmEnabled && automation.openingDmMessage) {
      await sendPageMessage({
        pageId,
        pageToken,
        recipient: { comment_id: commentId },
        text: renderMessageWithoutLink({ message: automation.openingDmMessage, commenterName: firstName }),
        buttons: [
          {
            type: "postback",
            title: automation.openingDmButtonLabel || "Send me the link",
            payload: `${REVEAL_PREFIX}${automation.id}`,
          },
        ],
      });
    } else {
      await sendReveal({ pageId, pageToken, recipient: { comment_id: commentId }, automation, commenterName: firstName });
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Facebook send failed";
  }

  let publicReplySentAt: Date | null = null;
  let publicReplyError: string | null = null;
  const replies = automation.publicReplyMessages?.length
    ? automation.publicReplyMessages
    : automation.publicReplyMessage
      ? [automation.publicReplyMessage]
      : [];
  if (automation.publicReplyEnabled && replies.length) {
    try {
      await replyToComment({ commentId, pageToken, message: replies[Math.floor(Math.random() * replies.length)] });
      publicReplySentAt = new Date();
    } catch (error) {
      publicReplyError = error instanceof Error ? error.message : "Facebook public reply failed";
    }
  }

  await prisma.dmLog.update({
    where: { automationId_commentId: { automationId: automation.id, commentId: logCommentId } },
    data: {
      status: errorMessage ? "FAILED" : "SENT",
      attempts: 1,
      dmSentAt: errorMessage ? null : new Date(),
      errorMessage,
      publicReplySentAt,
      publicReplyError,
    },
  });
}

async function handlePostback(pageId: string, senderId: string, payload: string) {
  if (!payload.startsWith(REVEAL_PREFIX)) return;
  const automationId = payload.slice(REVEAL_PREFIX.length);
  const account = await loadAccount(pageId);
  if (!account?.facebookPageToken) return;
  const automation = (await loadAutomations(account.id)).find((a) => a.id === automationId);
  if (!automation) return;
  const pageToken = decryptToken(account.facebookPageToken);
  const tapId = `fb_tap_${senderId}`;
  try {
    await prisma.dmLog.create({
      data: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: account.id,
        commenterId: `fb_${senderId}`,
        commenterName: "Facebook user",
        commentText: "(button tap)",
        commentId: tapId,
        status: "PENDING",
      },
    });
  } catch {
    return; // already delivered to this person for this campaign
  }
  let errorMessage: string | null = null;
  try {
    await sendReveal({ pageId, pageToken, recipient: { id: senderId }, automation });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Facebook send failed";
  }
  await prisma.dmLog.update({
    where: { automationId_commentId: { automationId: automation.id, commentId: tapId } },
    data: { status: errorMessage ? "FAILED" : "SENT", attempts: 1, dmSentAt: errorMessage ? null : new Date(), errorMessage },
  });
}

export async function processFacebookPageWebhook(payload: PageWebhookPayload) {
  if (payload.object !== "page" || !Array.isArray(payload.entry)) return;
  for (const entry of payload.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field === "feed" && change.value) {
        await handleComment(entry.id, change.value).catch((error) =>
          prisma.operationalEvent
            .create({ data: { source: "SYSTEM", level: "ERROR", message: "Facebook comment failed", payload: { reason: String(error) } } })
            .catch(() => {})
        );
      }
    }
    for (const event of entry.messaging ?? []) {
      const senderId = event.sender?.id;
      const postback = event.postback?.payload;
      if (senderId && postback && senderId !== entry.id) {
        await handlePostback(entry.id, senderId, postback).catch(() => {});
      }
    }
  }
}
