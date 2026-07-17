import { downloadAsset, prepareImage } from "./media.js";
import { truncateToBskyLimit } from "./text.js";

const PROFILE_META_KEY = "profile_state";
const PROFILE_PARTS = ["avatar", "banner", "bio", "name", "pinned"];

function avatarDownloadUrl(url) {
  if (!url || url.startsWith("data:")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(
      /_(?:normal|bigger|mini|x96)(?=\.[^./]+$)/i,
      "_400x400",
    );
    return parsed.toString();
  } catch {
    return url.replace(
      /_(?:normal|bigger|mini|x96)(?=\.[^./?#]+(?:[?#]|$))/i,
      "_400x400",
    );
  }
}

function storedProfileState(value) {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function uploadImage(agent, url, useFullSizeAvatar) {
  let asset;
  if (useFullSizeAvatar) {
    const fullSizeUrl = avatarDownloadUrl(url);
    try {
      asset = await downloadAsset(fullSizeUrl);
    } catch (error) {
      if (fullSizeUrl === url) {
        throw error;
      }
      asset = await downloadAsset(url);
    }
  } else {
    asset = await downloadAsset(url);
  }
  const prepared = await prepareImage(asset.buffer, asset.contentType);
  const response = await agent.uploadBlob(prepared.buffer, {
    encoding: prepared.encoding,
  });
  return response.data.blob;
}

export async function syncProfile(
  database,
  client,
  agent,
  ownUserId,
  options = {},
) {
  const dryRun = options.dryRun ?? false;
  const logger = options.logger ?? console.log;
  const errorLogger = options.errorLogger ?? console.error;

  try {
    const user = await client.users.get(ownUserId);
    const state = {
      avatar: String(user?.profile_picture?.url ?? ""),
      banner: String(user?.banner ?? ""),
      bio: String(user?.description ?? ""),
      name: String(user?.name ?? ""),
      pinned: String(user?.pinned_tweets?.[0] ?? ""),
    };
    const serializedState = JSON.stringify(state);
    const storedStateValue = database.getMeta(PROFILE_META_KEY);
    if (storedStateValue === serializedState) {
      return;
    }

    const previousState = storedProfileState(storedStateValue);
    const changedParts = PROFILE_PARTS.filter(
      (part) => previousState?.[part] !== state[part],
    );
    if (changedParts.length === 0) {
      return;
    }

    const pinnedChanged = changedParts.includes("pinned");
    const mappedPinned =
      pinnedChanged && state.pinned ? database.getPost(state.pinned) : null;
    const pinnedDeferred = pinnedChanged && state.pinned && !mappedPinned;
    const appliedParts = changedParts.filter(
      (part) => part !== "pinned" || !pinnedDeferred,
    );
    if (appliedParts.length === 0) {
      return;
    }

    if (dryRun) {
      logger(`[profile] dry run would update: ${appliedParts.join(", ")}`);
      return;
    }

    const avatar =
      changedParts.includes("avatar") && state.avatar
        ? await uploadImage(agent, state.avatar, true)
        : undefined;
    const banner =
      changedParts.includes("banner") && state.banner
        ? await uploadImage(agent, state.banner, false)
        : undefined;
    const description = truncateToBskyLimit(state.bio, 256);

    await agent.upsertProfile((existing) => {
      const updated = { ...existing, description };
      if (changedParts.includes("avatar")) {
        if (avatar) {
          updated.avatar = avatar;
        } else {
          delete updated.avatar;
        }
      }
      if (changedParts.includes("banner")) {
        if (banner) {
          updated.banner = banner;
        } else {
          delete updated.banner;
        }
      }
      if (changedParts.includes("name")) {
        if (state.name) {
          updated.displayName = truncateToBskyLimit(state.name, 64);
        } else {
          delete updated.displayName;
        }
      }
      if (pinnedChanged && !pinnedDeferred) {
        if (mappedPinned) {
          updated.pinnedPost = {
            uri: mappedPinned.bsky_uri,
            cid: mappedPinned.bsky_cid,
          };
        } else {
          delete updated.pinnedPost;
        }
      }
      return updated;
    });

    const persistedState = { ...state };
    if (pinnedDeferred) {
      if (Object.hasOwn(previousState ?? {}, "pinned")) {
        persistedState.pinned = previousState.pinned;
      } else {
        delete persistedState.pinned;
      }
    }
    database.setMeta(PROFILE_META_KEY, JSON.stringify(persistedState));
    logger(`[profile] updated: ${appliedParts.join(", ")}`);
  } catch (error) {
    errorLogger(`[profile] sync failed: ${error.message}`);
  }
}
