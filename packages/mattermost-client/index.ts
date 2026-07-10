// mattermost-client — Mattermost adapter for the messaging-client contract.

export { createMattermostClient, type MattermostConfig } from "./mattermost.ts";
export {
  attachmentFromMM,
  channelFromMM,
  channelKindFromType,
  describeAttachments,
  flattenPostList,
  postToMessage,
  userFromMM,
  type AttachmentSummary,
  type MMChannel,
  type MMFileInfo,
  type MMPost,
  type MMPostList,
  type MMUser,
} from "./convert.ts";
