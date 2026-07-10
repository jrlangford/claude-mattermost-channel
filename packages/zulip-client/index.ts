// zulip-client — Zulip adapter for the messaging-client contract.

export { createZulipClient, type ZulipConfig } from "./zulip.ts";
export {
  attachmentsFromContent,
  channelFromDmId,
  channelFromStream,
  channelIdForMessage,
  dmChannelId,
  messageFromZulip,
  narrowFor,
  parseChannelId,
  streamChannelId,
  userFromZulip,
  type ParsedChannelId,
  type ZulipMessage,
  type ZulipStream,
  type ZulipUser,
} from "./convert.ts";
