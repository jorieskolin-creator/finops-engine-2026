# Canonical capability Knowledge Base objects

Store one approved maturity capability per JSON file in this directory.

Naming convention:

```text
A1.json ... A5.json
B1.json ... B5.json
C1.json ... C5.json
D1.json ... D5.json
E1.json ... E5.json
F1.json ... F5.json
```

Each file must validate against `../schemas/capability.schema.json`.

The JSON object is the canonical machine-readable interpretation model for the criterion. Historical versions belong in Git history/releases rather than parallel versioned files in this active directory.
