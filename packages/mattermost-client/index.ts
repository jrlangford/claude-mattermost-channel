// mattermost-client — Mattermost adapter for the messaging-client contract.

export { createMattermostClient, type MattermostConfig } from "./mattermost.ts";
export {
  attachmentFromMM,
  channelFromMM,
  channelKindFromType,
  flattenPostList,
  postToMessage,
  userFromMM,
  type MMChannel,
  type MMPost,
  type MMPostList,
  type MMUser,
} from "./convert.ts";
