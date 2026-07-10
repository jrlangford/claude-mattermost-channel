// messaging-client — backend-neutral messaging transport contract.
//
// Types + the MessagingClient interface that adapters (Mattermost, Slack,
// Matrix, ...) implement, so consumers are plug-and-play across backends.

export type {
  AttachmentId,
  Attachment,
  Channel,
  ChannelId,
  ChannelKind,
  ChannelReadState,
  DisconnectInfo,
  FetchMessagesOptions,
  FileUpload,
  Message,
  MessageId,
  MessagingEvents,
  OutgoingMessage,
  Unsubscribe,
  User,
  UserId,
} from "./types.ts";

export {
  MessagingClientError,
  defineMessagingClient,
  type MessagingClient,
  type MessagingClientFactory,
  type MessagingErrorCode,
} from "./client.ts";
