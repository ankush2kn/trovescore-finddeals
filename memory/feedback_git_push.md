---
name: feedback_git_push
description: User wants to test changes locally before git commits/pushes are made
metadata:
  type: feedback
---

Don't auto-commit and push to git after making code changes. Wait for the user to test locally first, then ask or wait for explicit instruction to commit.

**Why:** User wants to verify changes work before they go to the repo.

**How to apply:** After editing files, stop. Let the user test. Only run git add/commit/push when the user explicitly says to commit or push.
