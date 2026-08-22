# Persisted-data fixtures

These fixtures are sanitized examples of every JSON shape currently owned by the production
implementation. They were derived from the readers and writers in `src`; this checkout had no live
files under `logs` to compare. IDs, usernames, names, messages, dates, and costs are fictional.

Persistence compatibility tests consume these fixtures alongside their corresponding stores.
