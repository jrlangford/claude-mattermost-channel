// matrix-client — Matrix adapter for the messaging-client contract.

export { createMatrixClient, type MatrixConfig } from "./matrix.ts";
export {
  emojiFromShortcode,
  eventToMessage,
  eventsToMessages,
  isEditEvent,
  isMessageEvent,
  kindFromRoom,
  localpart,
  msgtypeForMime,
  parseMxc,
  type MatrixMessageContent,
  type MatrixRawEvent,
} from "./convert.ts";
