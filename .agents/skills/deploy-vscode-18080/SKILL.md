---
name: deploy-vscode-18080
description: Rebuild and restart the mutable Vibe VS Code development service on HTTPS port 18080 from the canonical /mnt/ceph/vibe-vscode checkout. Use once after completing and validating source-code changes in this repository, or whenever the user explicitly asks to update, rebuild, restart, or deploy the latest 18080 service. Do not trigger for read-only work or documentation-only edits unless the user requests deployment.
---

# Deploy Vibe VS Code on 18080

Deploy only after the current code-editing task and its relevant validation are complete. Avoid restarting the service after intermediate edits.

Before running the deployment, tell the user that the skill is starting the 18080 update. Then run the bundled script relative to this file:

```bash
./scripts/deploy-18080.sh
```

The script must remain the single automation entry for this skill. It:

- stops the canonical `vibe_vscode_latest` tmux service when it exists;
- builds and starts the service entirely from `/mnt/ceph/vibe-vscode`, without invoking another project's control code;
- preserves the existing state under `/mnt/ceph/dever_for_dev/.dever/vscode-services/state/latest`;
- waits for an HTTPS `200` response and verifies a `0.0.0.0:18080` listener before succeeding;
- fails instead of killing an unrecognized process when the port is not owned by the canonical tmux session.

On failure, report the relevant tail from `latest.log` and leave the error visible. Do not invoke or fall back to `/mnt/ceph/dever_for_dev/third_party/vscode`, do not start an ad-hoc server, and do not touch port `18081` unless the user explicitly expands the deployment scope.
