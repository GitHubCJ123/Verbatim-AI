# Requirements review for issue #18

Status: clear

## Summary

The issue contains enough detail to implement a fix. The user selected the no-account/local setup path, observed that transcription defaulted to Azure, then selected Local Whisper and received a 404 for `whisper-runtimes.json` from the `v0.5.9` GitHub release.

## Findings

- The app currently frames "Use locally" as local data storage, but users reasonably expect local transcription defaults.
- The onboarding quick-start defaults still set cloud transcription and cloud cleanup.
- GitHub release `v0.5.9` exists but is a draft; draft release assets return 404 to the shipped app.
- Local Whisper currently surfaces the raw HTTP 404 instead of explaining that runtime release assets are unpublished.

## Questions / blockers

- None. The behavior and error are concrete enough to implement.

## Next action

Proceed to spec and implementation. Human review happens at PR review.

## Original issue

1. even though i selected to not create an account during setup, the default was to use Azure for transript.
2. when i selected Local - Whisper i got this error message:
HTTP status client error (404 Not Found) for url (https://github.com/GitHubCJ123/Verbatim-AI/releases/download/v0.5.9/whisper-runtimes.json)
