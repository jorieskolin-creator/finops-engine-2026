# Canonical anti-pattern Knowledge Base objects

Store one approved anti-pattern per JSON file in this directory.

Naming convention:

```text
AP-A1.json ... AP-A5.json
AP-B1.json ... AP-B5.json
AP-C1.json ... AP-C5.json
AP-D1.json ... AP-D5.json
AP-E1.json ... AP-E5.json
AP-F1.json ... AP-F5.json
```

Each file must validate against `../schemas/antipattern.schema.json`.

The JSON object is the canonical machine-readable anti-pattern interpretation model. Historical versions belong in Git history/releases rather than parallel versioned files in this active directory.
