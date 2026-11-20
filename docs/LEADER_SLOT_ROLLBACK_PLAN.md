# Leader Slot Checker — Rollback Plan

## Deployment model (verified from repo; Vercel dashboard not accessible from this session)

- Vercel project `omenpotters-projects/x1-leader-slot-checker`. Vercel's default production branch is `main`; **a merge to `main` will normally auto-deploy production.** Confirm in Vercel → Settings → Git before merging.
- This work is only on `claude/bold-ritchie-g1l48h`. Pushing that branch creates (at most) a **preview** deployment.

## Safe release path

1. Open the branch's Vercel preview URL; run a lookup for a known validator; confirm `/api/leader`, `/api/clock` return 200.
2. Optionally: `BASE=<preview-url>` and check `/robots.txt`, `/sitemap.xml`, `/guide`, a 404 path.
3. Merge to `main` (owner decision) → production deploy.

## Rollback options (fastest first)

1. **Vercel instant rollback**: Vercel → Deployments → previous production deployment (from `58df1f3`) → "Promote to Production" / "Instant Rollback". No git change needed.
2. **Git revert**: `git revert -m 1 <merge-commit>` on `main` and push → redeploys previous code.
3. **Pre-upgrade reference**: commit `58df1f3` (tag suggestion: `pre-seo-upgrade`). The original proxy is preserved verbatim in git history (`api/rpc.js` @ `58df1f3`).

## Behaviour changes to be aware of

- `/api/rpc` no longer sends `Access-Control-Allow-Origin: *` and only forwards read methods. Any third-party site that was (undocumented) using this proxy cross-origin will stop working. Revert only that file if this is unwanted.
- New CSP header; if Vercel injects additional scripts in future, update `script-src` in `vercel.json`.
