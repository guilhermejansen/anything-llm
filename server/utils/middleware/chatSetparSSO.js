const JWT = require("jsonwebtoken");
const crypto = require("crypto");
const { User } = require("../../models/user");
const { SystemSettings } = require("../../models/systemSettings");
const { TemporaryAuthToken } = require("../../models/temporaryAuthToken");

function isTruthyEnv(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(normalized);
}

function legacyUsernameFromEmail(email = "") {
  return String(email)
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, "")
    .substring(0, 32);
}

function usernameFromPayload(payload = {}) {
  const stableExternalId = String(payload.userId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  if (stableExternalId) {
    return `setpar_${stableExternalId}`.substring(0, 32);
  }

  const fallbackFromEmail = legacyUsernameFromEmail(payload.email);
  if (!fallbackFromEmail) return null;
  return `setpar_${fallbackFromEmail}`.substring(0, 32);
}

function mapSetparRoleToAnything(payload = {}) {
  const isSetparSuperAdmin =
    payload.isSuperAdmin === true ||
    payload.isOwner === true ||
    payload.role === "superadmin";

  // Requested mapping:
  // - Chat Setpar super admin -> AnythingLLM manager
  // - Other users -> AnythingLLM default
  return isSetparSuperAdmin ? "manager" : "default";
}

async function enableMultiUserMode(reason = "unspecified") {
  const { success, error } = await SystemSettings._updateSettings({
    multi_user_mode: true,
    onboarding_complete: true,
  });

  if (!success) {
    console.error(
      `[ChatSetpar SSO] Failed to enable multi-user mode (${reason}):`,
      error || "Unknown error",
    );
    return false;
  }

  console.log(`[ChatSetpar SSO] Multi-user mode enabled (${reason}).`);
  return true;
}

async function ensureSetparDefaultMultiUserMode() {
  const alreadyEnabled = await SystemSettings.isMultiUserMode();
  if (alreadyEnabled) return true;

  if (!isTruthyEnv(process.env.CHAT_SETPAR_DEFAULT_MULTI_USER)) {
    return false;
  }

  return await enableMultiUserMode("CHAT_SETPAR_DEFAULT_MULTI_USER");
}

async function ensureMultiUserModeEnabled() {
  const alreadyEnabled = await SystemSettings.isMultiUserMode();
  if (alreadyEnabled) return true;

  // Optional boot-time default (checked first)
  if (isTruthyEnv(process.env.CHAT_SETPAR_DEFAULT_MULTI_USER)) {
    const enabledByDefault = await enableMultiUserMode(
      "CHAT_SETPAR_DEFAULT_MULTI_USER",
    );
    if (enabledByDefault) return true;
  }

  // Optional fallback: enable on first valid SSO request
  if (!isTruthyEnv(process.env.CHAT_SETPAR_AUTO_ENABLE_MULTI_USER)) {
    return false;
  }

  return await enableMultiUserMode("CHAT_SETPAR_AUTO_ENABLE_MULTI_USER");
}

/**
 * Middleware that handles SSO authentication from Chat Setpar via iframe.
 * Intercepts requests with `?sso_token=<jwt>` query parameter,
 * validates the JWT, creates/updates the user in AnythingLLM,
 * and redirects through /sso/simple to bootstrap localStorage auth.
 */
async function chatSetparSSO(req, res, next) {
  const ssoToken = req.query.sso_token;
  if (!ssoToken) return next();

  const jwtSecret = process.env.CHAT_SETPAR_JWT_SECRET;
  if (!jwtSecret) {
    console.error("[ChatSetpar SSO] CHAT_SETPAR_JWT_SECRET is not configured.");
    return next();
  }

  try {
    const payload = JWT.verify(ssoToken, jwtSecret);
    const { userId, email } = payload;

    if (!userId || !email) {
      console.error("[ChatSetpar SSO] Invalid token payload - missing userId or email.");
      return res.status(401).json({ error: "Invalid SSO token payload." });
    }

    const multiUserMode = await ensureMultiUserModeEnabled();
    if (!multiUserMode) {
      console.error(
        "[ChatSetpar SSO] Multi-user mode is not enabled. Set CHAT_SETPAR_DEFAULT_MULTI_USER=true or CHAT_SETPAR_AUTO_ENABLE_MULTI_USER=true.",
      );
      return res.status(403).json({
        error: "Multi-user mode must be enabled for SSO.",
      });
    }

    const username = usernameFromPayload(payload);
    if (!username) {
      console.error("[ChatSetpar SSO] Could not derive username from payload.");
      return res.status(401).json({ error: "Invalid SSO token payload." });
    }

    const mappedRole = mapSetparRoleToAnything(payload);

    // Primary lookup: deterministic username based on external userId.
    let user = await User.get({ username });

    // Backward compatibility: try legacy email-based username and migrate it.
    if (!user) {
      const legacyUsername = legacyUsernameFromEmail(email);
      if (legacyUsername && legacyUsername !== username) {
        const legacyUser = await User.get({ username: legacyUsername });
        if (legacyUser) {
          const usernameAlreadyTaken = await User.get({ username });
          if (!usernameAlreadyTaken) {
            const { user: renamedUser, message } = await User._update(legacyUser.id, {
              username,
            });
            if (renamedUser) {
              user = User.filterFields(renamedUser);
              console.log(
                `[ChatSetpar SSO] Migrated legacy username ${legacyUsername} -> ${username}.`,
              );
            } else {
              console.error("[ChatSetpar SSO] Failed to migrate legacy username:", message);
            }
          } else {
            user = legacyUser;
          }
        }
      }
    }

    if (!user) {
      // Create user with a random password (SSO-only flow)
      const randomPassword = crypto.randomBytes(32).toString("hex");

      const { user: newUser, error } = await User.create({
        username,
        password: randomPassword,
        role: mappedRole,
      });

      if (error) {
        console.error("[ChatSetpar SSO] Failed to create SSO user:", error);
        return res.status(500).json({ error: "Failed to create SSO user." });
      }

      user = newUser;
      console.log(
        `[ChatSetpar SSO] Created user: ${username} (mapped role: ${mappedRole})`,
      );
    } else if (user.role !== mappedRole) {
      const { user: updatedUser, message } = await User._update(user.id, {
        role: mappedRole,
      });

      if (!updatedUser) {
        console.error("[ChatSetpar SSO] Failed to update user role:", message);
        return res.status(500).json({ error: "Failed to sync SSO user role." });
      }

      user = User.filterFields(updatedUser);
      console.log(`[ChatSetpar SSO] Updated user role: ${username} -> ${mappedRole}`);
    }

    // Create a temporary auth token and redirect to the built-in simple SSO flow.
    // This ensures frontend localStorage auth is initialized correctly.
    const { token: tempToken, error: tempTokenError } =
      await TemporaryAuthToken.issue(user.id);

    if (tempTokenError || !tempToken) {
      console.error("[ChatSetpar SSO] Failed to issue temporary auth token:", tempTokenError);
      return res.status(500).json({ error: "Failed to create SSO session." });
    }

    const redirectTo = req.path && req.path !== "/sso/simple" ? req.path : "/";
    const redirectUrl = `/sso/simple?token=${encodeURIComponent(tempToken)}&redirectTo=${encodeURIComponent(redirectTo)}`;

    return res.redirect(302, redirectUrl);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      console.error("[ChatSetpar SSO] Token expired.");
      return res.status(401).json({ error: "SSO token expired." });
    }
    if (err.name === "JsonWebTokenError") {
      console.error("[ChatSetpar SSO] Invalid token:", err.message);
      return res.status(401).json({ error: "Invalid SSO token." });
    }
    console.error("[ChatSetpar SSO] Unexpected error:", err);
    return res.status(500).json({ error: "SSO authentication failed." });
  }
}

module.exports = {
  chatSetparSSO,
  ensureSetparDefaultMultiUserMode,
};
