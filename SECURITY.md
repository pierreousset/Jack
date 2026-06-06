# Security Policy

## Reporting a vulnerability

Please email pierreousset@gmail.com with details. Do not open a public issue for security-sensitive reports. You should receive an acknowledgement within a few days.

## Scope and threat model

- Jack spawns local CLIs and calls local/remote HTTP endpoints **on your machine, with your permissions**. Workers with `code-edit` capability can modify files in the working directory — review what you ask Jack to do, especially in repositories you care about.
- Jack never stores, transmits, or proxies provider credentials. Authentication is handled entirely by each CLI/server (e.g. `claude login`).
- Run artifacts under `./jack-runs/` may contain prompts and model outputs — treat them as potentially sensitive and keep them out of version control (the default `.gitignore` does this).

## Responsibility

You are responsible for complying with the terms of service and usage limits of each AI provider whose CLI or API Jack invokes on your behalf.
