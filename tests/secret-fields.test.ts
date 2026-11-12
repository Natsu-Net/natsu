import { describe, expect, test } from "bun:test";
import { CSRF_FIELD, looksSecret, valuesOf } from "../src/pages/actions.ts";

const SECRET_NAMES = [
	"password",
	"Password",
	"PASSWORD",
	"newPassword",
	"newpassword",
	"currentPassword",
	"password_confirmation",
	"passwordConfirm",
	"password2",
	"passwd",
	"passphrase",
	"passcode",
	"pwd",
	"newpwd",
	"pass",
	"pass2",
	"pass_confirm",
	"newPass",
	"old_pass",
	"userpass",
	"emailPass",
	"signin.password",
	"items[0][password]",
	"f.pass",
	"n_pin",
	"secret",
	"clientSecret",
	"client_secret",
	"webhookSecret",
	"secretKey",
	"token",
	"apiToken",
	"publicToken",
	"bottoken",
	"access_token",
	"refreshToken",
	"_csrf",
	"csrf",
	"csrfToken",
	"xsrf-token",
	"otp",
	"totp",
	"smsOtp",
	"otpCode",
	"2FACode",
	"2fa_code",
	"mfa_code",
	"MFACode",
	"twoFactorCode",
	"oneTimeCode",
	"one_time_code",
	"verificationCode",
	"verifyCode",
	"authCode",
	"oauthCode",
	"resetCode",
	"recoveryCodes",
	"backupCodes",
	"securityCode",
	"accessCode",
	"loginCode",
	"smsCode",
	"pinCode",
	"cvc",
	"cvv",
	"cvv2",
	"csc",
	"cardCvc",
	"cardNumber",
	"card_number",
	"cardnumber",
	"cardNo",
	"cardNum",
	"ccNumber",
	"cc-num",
	"cc_number",
	"creditCard",
	"credit_card_number",
	"debitCard",
	"pin",
	"newPin",
	"atmPin",
	"pinConfirm",
	"pin_number",
	"apiKey",
	"api_key",
	"APIKey",
	"apikey",
	"privateKey",
	"privatekey",
	"accessKey",
	"signingKey",
	"encryptionKey",
	"credentials",
];

const ECHOED_NAMES = [
	"title",
	"q",
	"value",
	"name",
	"description",
	"code",
	"codes",
	"InviteCode",
	"inviteCode",
	"postalCode",
	"postal_code",
	"zipCode",
	"barcode",
	"discordCode",
	"promoCode",
	"couponCode",
	"countryCode",
	"languageCode",
	"presetCode",
	"colorCode",
	"sourceCode",
	"unicode",
	"RankCardBackground",
	"cardTitle",
	"cardColor",
	"giftCard",
	"Bypass",
	"BypassRoles",
	"bypassCooldown",
	"passport",
	"compass",
	"passenger",
	"inPass",
	"battlePass",
	"seasonPass",
	"hotpath",
	"laptop",
	"footprint",
	"despot",
	"maxTokens",
	"DailyTokenBudget",
	"tokenId",
	"tokenizer",
	"secretary",
	"pinned",
	"pinMessages",
	"spinner",
	"key",
	"keys",
	"productKey",
	"itemKey",
	"sortKey",
	"hotkey",
	"monkey",
	"number",
	"phoneNumber",
	"vatNumber",
	"orderNo",
	"piano",
	"slot.1",
	"f.locale",
];

const LEBOT_SECRET_FIELDS = [
	"token", "f.AiApiKey", "f.AiBearerToken", "f.SpotifyClientSecret", "f_client_secret", "f_api_key", "f_client_secret_override",
];

const LEBOT_ECHOED_FIELDS = [
	"type", "key", "back", "_back", "_resource", "_item", "_parent", "_fields", "_revs", "_rev", "_run", "_mode", "_base", "_changed", "_touched",
	"_cells", "confirm", "op", "test", "free", "step", "expected", "revision", "baseRevision", "list", "mode", "target", "guild", "guildId", "id",
	"slotId", "accountId", "paymentId", "grantId", "userId", "bot", "asset", "design", "template", "slot", "module", "platform", "provider", "flow",
	"scope", "server", "currency", "quantity", "enable", "enabled", "priority", "quota", "keep", "plan", "plans", "price", "usdAmount", "tiers",
	"usdTiers", "amount", "productKey", "refundable", "revoke", "until", "days", "reason", "note", "when", "addOns", "field", "value", "family",
	"rarity", "sort", "q", "preset", "glyph", "label", "metric", "game", "threshold", "points", "sortOrder", "active", "hidden", "nameEn", "nameFr",
	"descriptionEn", "descriptionFr", "featured", "owner", "slots", "inPass", "includedIn", "announceChannel", "announceDm", "targetKind", "targetId",
	"itemType", "itemKey", "item", "user", "language", "channelId", "lang", "f.channel", "f.locale", "f.from", "f.to", "f.sent", "modules", "emoji",
	"name", "description", "title", "slug", "summary", "bodyMarkdown", "tags", "pinned", "kind", "file", "locale", "version", "url", "body",
	"publishNow", "effectiveAt", "legalForm", "registration", "vatNumber", "address", "directorName", "contactEmail", "supportUrl", "hostName",
	"hostAddress", "headline", "message", "targetAt", "autoOpen", "retryMinutes", "linkKind", "linkLabel", "linkUrl", "allowStaff", "testers", "code",
	"percent", "duration", "months", "appliesTo", "max", "firstTimeOnly", "role", "rank", "permissions", "slot.rank", "slot.levelup", "slot.welcome",
	"slot.profile", "piece.badge", "piece.title", "piece.effect", "actm_0", "actw_0", "actc_0", "guildChallengerPer", "guildChallengerMin",
	"guildChallengerMax", "guildGrandmasterPer", "guildGrandmasterMin", "guildGrandmasterMax", "guildMasterPer", "guildMasterMin", "guildMasterMax",
	"globalChallenger", "globalGrandmaster", "globalMaster", "decayDays", "decayAmount", "minMembers", "minAgeDays", "minActiveHumans",
	"achievementPoints", "achievementCap", "activityDailyCap", "activityWindowDays", "staffname.moderator", "staffname.admin", "staff.moderator",
	"staff.admin", "f.Channel", "f.AiProvider", "f.AiModel", "f.AiWebSearch", "f.AiReasoningEffort", "f.AiEffortRangeMin", "f.AiEffortRangeMax",
	"f.DailyTokenBudget", "f.RestyleAutoBackup", "f.RestyleBackupNotice", "f.ChannelId", "f.ResetStartDay", "f.ResetIntervalDays",
	"f.MessageLogChannel", "f.MemberLogChannel", "f.MemberJoinLogMessage", "f.MemberLeaveLogMessage", "f.ServerLogChannel", "f.VoiceLogChannel",
	"f.SanctionMuteLogChannel", "f.SanctionBanLogChannel", "f.SanctionKickLogChannel", "f.SanctionWarnLogChannel", "f.IgnoredChannels",
	"f.IgnoredRoles", "f.IgnoredMembers", "f.IgnoreBots", "f.IgnoredEvents", "f.BirthdayChannel", "f.AnnounceHour", "f.BirthdayMessage",
	"f.CanvasAnimationsEnabled", "f.CanvasMaxFileSizeMb", "f.MemberCountChannel", "f.MemberCountFormat", "f.VoiceCountChannel", "f.VoiceCountFormat",
	"f.HubChannelId", "f.CategoryChannelId", "f.DefaultUserLimit", "f.LeashRequireConsent", "f.LeashDefaultLimit", "f.LeashMaxDuration",
	"f.LeashRenameDogs", "f.LeashNicknameTemplate", "f.Language", "f.Timezone", "f.DefaultRoles", "f.InviteFakeAccountAgeDays", "f.InviteCountRejoins",
	"f.InviteRewardMode", "f.InviteRemoveRewardsOnDrop", "f.MessageXpMin", "f.MessageXpMax", "f.XpMessageCooldown", "f.XpMinMessageLength",
	"f.VoiceXpPerMinute", "f.VoiceXpRequireUnmuted", "f.VoiceXpRequireUndeafened", "f.VoiceXpRequireCompany", "f.VoiceXpIgnoreAfk",
	"f.XpExcludedChannels", "f.XpExcludedRoles", "f.LevelingDifficulty", "f.LevelingRewardMode", "f.LevelAnnounceMode", "f.LevelAnnounceChannel",
	"f.LevelAnnounceMessage", "f.LevelAnnounceEveryLevels", "f.RankMessage", "f.MentionRoles", "f.MiniGameChannels", "f.MiniGameRewardWin",
	"f.MiniGameRewardDraw", "f.MiniGameRewardParticipation", "f.MiniGameCooldownSeconds", "f.MiniGameSessionTimeoutMinutes",
	"f.MiniGameMaxActiveSessions", "f.MiniGameAnimationsEnabled", "f.MiniGameAnimationSpeed", "f.MiniGameBotDifficulty", "f.MiniGameFirstPlayer",
	"f.MiniGameRecordsChannelId", "f.DjRole", "f.MaxQueueLength", "f.MaxTrackSeconds", "f.AnnounceTracks", "f.ChannelStatus", "f.LeaveWhenAloneSeconds",
	"f.StayConnected", "f.RadioEnabled", "f.RadioChannel", "f.RadioSource", "f.RadioShuffle", "f.RadioBot", "f.MainBotFallback", "f.DisabledBots",
	"f.LyricsEnabled", "f.LyricsShowOnStart", "f.LyricsMode", "f.LyricsAnimated", "f.LyricsLeadMs", "f.LyricsLanguage", "f.SpotifyClientId",
	"f.YoutubeCookies", "f.MusicEnabled", "f.GreetingChannel", "f.GreetingMessage", "f.GoodbyeChannel", "f.GoodbyeMessage",
	"f.ReturningGreetingMessage", "f.BoostChannel", "f.BoostMessage", "f.Nickname", "f.Avatar", "f.Banner", "f.Bio", "f.EmbedColor", "f.EmbedFooter",
	"f.BumpChannel", "f.BumpMentionRole", "f.MuteRole", "f.WarnEscalationWindow", "f.SecurityAlertChannel", "f.SecurityAlertRole", "f.MinAccountAge",
	"f.RaidDetection", "f.RaidJoinThreshold", "f.RaidJoinWindow", "f.RaidModeDuration", "f.AntiNuke", "f.AntiNukeThreshold", "f.AntiNukeWindow",
	"f.AntiNukeTrustedRoles", "f.SuggestionChannel", "f.SuggestionAutoThread", "f.SuggestionAllowVoteChange", "f.SuggestionNotifyAuthor",
	"f.SuggestionMaxOpenPerMember", "f.SuggestionCooldownSeconds", "f.StaffRoles", "f.LogChannel", "f.MaxOpenTickets", "f.PanelMessage",
	"f.TrackMessages", "f.TrackVoice", "f.ExcludedTextChannels", "f.ExcludedVoiceChannels", "f.DataRetentionDays", "f.LockRole", "f.VerifiedRole",
	"f.VerifyChannel", "f.VerifyKickDelay", "f.name", "f.description", "f.type", "f.count", "f.duration", "f.resetMonthly", "f.rewardRole", "f.rarity",
	"f.glyph", "f.label", "f.enabled", "f.mode", "f.time", "f.runDate", "f.weekdays", "f.monthDay", "f.cron", "f.message", "f.nextRun",
	"f.firstMessage", "f.kind", "f.contexts", "f.defaults", "f.src", "f.contentType", "f.size", "f.animated", "f.preset", "f.data", "f.usages",
	"f.platform", "f.source", "f.displayName", "f.kinds", "f.pingRole", "f.status", "f.lastSentAt", "f.group", "f.maxLeashes", "f.roles",
	"f.permissions", "f.command", "f.maxCount", "f.window", "f.invites", "f.role", "f.level", "f.targetType", "f.percent", "f.variants", "f.module",
	"f.actions", "f.usedBy", "f.listVariants", "f.listDefaults", "f.allowConsecutive", "f.allowMath", "f.chatter", "f.resetOnFail", "f.reactions",
	"f.failRole", "f.failMessage", "f.xpPerCount", "f.milestoneEvery", "f.milestoneXp", "f.pointsPerCount", "f.current", "f.tries", "f.fails",
	"f.record", "f.emoji", "f.multiSelect", "f.nullable", "f.reason", "f.warns", "f.trigger", "f.keywords", "f.regexPatterns", "f.presets",
	"f.allowList", "f.mentionLimit", "f.mentionRaidProtection", "f.blockMessage", "f.blockMessageText", "f.alertChannel", "f.timeout", "f.exemptRoles",
	"f.exemptChannels", "f.threshold", "f.excludedChannels", "f.selfStar", "f.allowNsfw", "f.user", "f.addedBy", "f.maxTickets", "f_client_id",
	"f_market", "f_endpoint", "f_quality", "f_retries", "f_lyrics", "f_notes", "f_weird", "f_region", "f_client_id_override", "f_strict", "f_arl",
];

const ANTEIKU_SECRET_FIELDS = [
	"clientSecret", "apiToken", "publicToken", "webhookSecret", "privateKey",
];

const ANTEIKU_ECHOED_FIELDS = [
	"_action", "key", "value", "id", "role", "rank", "parent", "grant", "required", "sort", "mode", "skipCloudflare", "plan", "extraRoles", "active",
	"autoAssign", "grantsRoles", "price", "currency", "durationDays", "tebexPackageId", "description", "name", "note", "score", "spoiler", "body",
	"search", "from", "to", "season", "airdate", "title", "startdate", "slug", "year", "minRating", "status", "subtype", "categories", "ageRating",
	"episodesMin", "episodesMax", "clientId", "zoneId", "site", "media", "webhookIps",
];

describe("the field names of the apps that use natsu", () => {
	const misjudged = (names: string[], secret: boolean) => names.filter((name) => looksSecret(name) !== secret);

	test("LeBot dashboard: its secrets stay hidden, every other field is drawn again", () => {
		expect(misjudged(LEBOT_SECRET_FIELDS, true)).toEqual([]);
		expect(misjudged(LEBOT_ECHOED_FIELDS, false)).toEqual([]);
	});

	test("anteiku: its secrets stay hidden, every other field is drawn again", () => {
		expect(misjudged(ANTEIKU_SECRET_FIELDS, true)).toEqual([]);
		expect(misjudged(ANTEIKU_ECHOED_FIELDS, false)).toEqual([]);
	});
});

describe("which field names a refused form keeps to itself", () => {
	test.each(SECRET_NAMES)("%s is secret", (name) => {
		expect(looksSecret(name)).toBe(true);
		expect(valuesOf({ [name]: "x" })).toEqual({});
	});

	test.each(ECHOED_NAMES)("%s is drawn again", (name) => {
		expect(looksSecret(name)).toBe(false);
		expect(valuesOf({ [name]: "x" })).toEqual({ [name]: "x" });
	});

	test("an app may hide more fields and draw again ones the name rule hides", () => {
		const input = { motto: "a", pin: "b", title: "c" };
		expect(valuesOf(input, { secret: ["motto"], echo: ["pin"] })).toEqual({ pin: "b", title: "c" });
	});

	test("a field both hidden and drawn again stays hidden", () => {
		expect(valuesOf({ motto: "a" }, { secret: ["motto"], echo: ["motto"] })).toEqual({});
	});

	test("the framework's own CSRF field is never drawn again, whatever an app says", () => {
		expect(valuesOf({ [CSRF_FIELD]: "t" }, { echo: [CSRF_FIELD] })).toEqual({});
	});
});
