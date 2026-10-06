// TYE: the Facebook app is the same Meta app as Instagram ("TYE OpenReply").
// The App ID is public (it appears in every login URL), so a fallback is fine.
export function getFacebookAppId(): string {
  return process.env.FACEBOOK_APP_ID ?? "2370054363762430";
}

// Optional: a Facebook Login for Business configuration ID. When set, the login
// dialog uses it instead of the scope list.
export function getFacebookLoginConfigId(): string | undefined {
  return process.env.FACEBOOK_LOGIN_CONFIG_ID || undefined;
}
