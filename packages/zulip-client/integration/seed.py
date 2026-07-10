# Seeds the test server: the root-domain realm plus the two test users.
# Runs inside the zulip container via `manage.py shell` (see run.sh) because
# Zulip has no REST endpoint for realm creation. Idempotent: re-running on a
# kept-alive stack is a no-op.
from zerver.actions.create_realm import do_create_realm
from zerver.actions.create_user import do_create_user
from zerver.models import UserProfile

try:
    from zerver.models.realms import get_realm
except ImportError:  # older module layout
    from zerver.models import get_realm

PW = "ITtestpass123!"

# The root-domain realm ("" subdomain) is the one requests reach when the
# Host header (IP, localhost:port, ...) doesn't match EXTERNAL_HOST.
try:
    realm = get_realm("")
except Exception:
    realm = do_create_realm(string_id="", name="E2E")


def ensure(email, name):
    try:
        return UserProfile.objects.get(delivery_email__iexact=email, realm=realm)
    except UserProfile.DoesNotExist:
        return do_create_user(email, PW, realm, name, acting_user=None)


bot = ensure("itbot@e2e.local", "IT Bot")
human = ensure("ithuman@e2e.local", "IT Human")
print("SEEDED bot=%d human=%d" % (bot.id, human.id))
