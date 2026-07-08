# Security notes

- This change improves privacy defaults for local/no-account setup by avoiding cloud transcription unless the user explicitly selects it.
- Cleanup is disabled in local quick-start so text polish is not silently sent to cloud either.
- The persisted cleanup provider is local Ollama for local/no-account setup, not cloud hidden behind a disabled flag.
- Runtime downloads still require the signed runtime manifest and expected SHA-256 hashes.
- Bundled runtime archives are treated the same as downloaded archives: the app verifies the signed manifest and SHA-256 before extraction.
- The new runtime error message explains release asset availability without printing tokens, environment variables, or local filesystem details.
