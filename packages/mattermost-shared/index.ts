// Barrel for the dependency-free modules shared by both Mattermost bridges.
// The access-control CLI is intentionally NOT re-exported here — it is a
// side-effecting script, exposed via the "mattermost-shared/access-cli"
// subpath so each bridge's wrapper can run it after pointing it at the right
// state directory.

export {
  selectCatchUpPosts,
  type CatchUpPost,
  type CatchUpPostList,
} from "./catchup.ts";
export {
  describeAttachments,
  sanitizeFilename,
  type MMFileInfo,
  type AttachmentSummary,
} from "./files.ts";
